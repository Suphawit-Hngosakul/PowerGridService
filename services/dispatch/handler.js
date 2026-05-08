'use strict';

const crypto = require('crypto');
const { query } = require('@powergrid/db');
const { CircuitBreaker } = require('@powergrid/circuit-breaker');

const INCIDENT_IMPACT_ZONE_URL = process.env.INCIDENT_IMPACT_ZONE_URL;
const PRIORITY_CASE_SERVICE_URL = process.env.PRIORITY_CASE_SERVICE_URL;
const SHARED_SECRET = process.env.OUTBOUND_SHARED_SECRET || '';
const HTTP_TIMEOUT_MS = Number(process.env.OUTBOUND_TIMEOUT_MS || 10_000);
const MAX_RETRIES = 1; // retry once, then REJECTED

// Per-target circuit breakers (kept in module scope for Lambda warm starts)
const incidentCB = new CircuitBreaker({ name: 'incident', failureThreshold: 3, resetTimeoutMs: 30_000 });
const helpCB = new CircuitBreaker({ name: 'help', failureThreshold: 3, resetTimeoutMs: 30_000 });

// ── helpers ──────────────────────────────────────────────────────────

function extractMessages(event) {
  if (event && Array.isArray(event.Records)) {
    return event.Records.map((r) => {
      try {
        const body = JSON.parse(r.body);
        return body.Message ? JSON.parse(body.Message) : body;
      } catch { return null; }
    }).filter(Boolean);
  }
  if (event && event.outage_event_id) return [event];
  return [];
}

function sign(body) {
  return crypto.createHmac('sha256', SHARED_SECRET).update(body).digest('hex');
}

async function postJSON(url, payload) {
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PowerGrid-Signature': sign(body),
      },
      body,
      signal: ctrl.signal,
    });
    const text = (await res.text()).slice(0, 4096);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SHARED_SECRET}`,
        'Accept': 'application/json',
      },
      signal: ctrl.signal,
    });
    const text = (await res.text()).slice(0, 65536);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

// Ray-casting point-in-polygon for GeoJSON Polygon ([lng,lat] order, single outer ring)
function pointInPolygon(lng, lat, polygon) {
  if (!polygon || polygon.type !== 'Polygon' || !Array.isArray(polygon.coordinates)) return false;
  const ring = polygon.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Haversine distance in km — used when zone has centerPoint + radiusKm but no polygon
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// True if node is inside a zone's polygon, or within centerPoint+radiusKm fallback
function nodeInZone(nodeLng, nodeLat, zone) {
  if (zone.affectedArea && pointInPolygon(nodeLng, nodeLat, zone.affectedArea)) return true;
  if (zone.centerPoint && typeof zone.radiusKm === 'number') {
    const d = haversineKm(nodeLat, nodeLng, zone.centerPoint.lat, zone.centerPoint.lng);
    if (d <= zone.radiusKm) return true;
  }
  return false;
}

// Pick a stable incident_id to forward to Help Service.
// Prefer the source incident ID over the zone-internal id.
function resolveIncidentId(zone) {
  return zone.sourceIncidentId
    || (Array.isArray(zone.sourceIncidentIds) && zone.sourceIncidentIds[0])
    || (zone.incidentReporterSnapshot && zone.incidentReporterSnapshot.incidentId)
    || zone.id;
}

async function logAttempt({ outage_event_id, target, url, request_body, http_status, response_body, error, attempt_no }) {
  await query(
    `INSERT INTO dispatch_log
       (outage_event_id, target, url, request_body, http_status, response_body, error, attempt_no)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
    [outage_event_id, target, url,
      JSON.stringify(request_body), http_status ?? null,
      response_body ?? null, error ?? null, attempt_no ?? 1]
  );
}

// ── retry with limit ─────────────────────────────────────────────────

async function withRetry(fn, maxRetries) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return { result: await fn(attempt), attempt };
    } catch (err) {
      lastErr = err;
      if (attempt <= maxRetries) {
        console.warn(`[dispatch] retry ${attempt}/${maxRetries}: ${err.message}`);
      }
    }
  }
  return { error: lastErr, attempt: maxRetries + 1 };
}

// ── optimistic lock ──────────────────────────────────────────────────

async function acquireLock(outageEventId, currentVersion) {
  const r = await query(
    `UPDATE outage_events
     SET version = version + 1
     WHERE id = $1 AND version = $2 AND dispatch_status = 'pending'
     RETURNING id`,
    [outageEventId, currentVersion]
  );
  return r.rowCount > 0;
}

async function markRejected(outageEventId, reason) {
  await query(
    `UPDATE outage_events SET dispatch_status = 'rejected', rejection_reason = $2 WHERE id = $1`,
    [outageEventId, reason]
  );
}

async function markDispatched(outageEventId, incidentId) {
  await query(
    `UPDATE outage_events SET dispatch_status = 'dispatched', incident_id = $1 WHERE id = $2`,
    [incidentId, outageEventId]
  );
}

async function recordPriorityCorrelation(outageEventId, priorityRequestId, priorityTraceId) {
  if (!priorityRequestId && !priorityTraceId) return;
  await query(
    `UPDATE outage_events SET priority_request_id = $2, priority_trace_id = $3 WHERE id = $1`,
    [outageEventId, priorityRequestId || null, priorityTraceId || null]
  );
}

// ── load outage ──────────────────────────────────────────────────────

async function loadOutage(outageEventId) {
  const r = await query(
    `SELECT e.id, e.node_id, e.started_at, e.incident_id,
            e.priority_level, e.dispatch_status, e.version,
            n.latitude, n.longitude, n.place_name, n.place_type, n.voltage
     FROM outage_events e
     JOIN nodes n ON n.node_id = e.node_id
     WHERE e.id = $1`,
    [outageEventId]
  );
  return r.rows[0];
}

// ── outbound calls (with CB + retry + fallback) ──────────────────────

async function callIncidentService(outage) {
  if (!INCIDENT_IMPACT_ZONE_URL) throw new Error('INCIDENT_IMPACT_ZONE_URL not configured');

  const fallback = async (cbErr) => {
    const reason = `INCIDENT_IMPACT_ZONE_UNAVAILABLE: ${cbErr.message}`;
    await logAttempt({
      outage_event_id: outage.id, target: 'incident',
      url: INCIDENT_IMPACT_ZONE_URL, request_body: null,
      error: reason, attempt_no: 0,
    });
    await markRejected(outage.id, reason);
    return { __rejected: true, reason };
  };

  return incidentCB.call(async () => {
    const { result, error, attempt } = await withRetry(async (attemptNo) => {
      let httpResult;
      try {
        httpResult = await getJSON(INCIDENT_IMPACT_ZONE_URL);
      } catch (err) {
        await logAttempt({
          outage_event_id: outage.id, target: 'incident',
          url: INCIDENT_IMPACT_ZONE_URL, request_body: null,
          error: err.message, attempt_no: attemptNo,
        });
        throw err;
      }
      await logAttempt({
        outage_event_id: outage.id, target: 'incident',
        url: INCIDENT_IMPACT_ZONE_URL, request_body: null,
        http_status: httpResult.status, response_body: httpResult.text,
        attempt_no: attemptNo,
      });
      if (!httpResult.ok) throw new Error(`incident service returned ${httpResult.status}`);
      return httpResult.json || {};
    }, MAX_RETRIES);

    if (error) {
      const reason = `INCIDENT_IMPACT_ZONE_FAILED: ${error.message} (after ${attempt} attempts)`;
      await markRejected(outage.id, reason);
      return { __rejected: true, reason };
    }

    // PowerGrid does the matching against the upstream impact-zones response.
    // Upstream shape: { items: [{ id, status, affectedArea?, centerPoint?, radiusKm?,
    //   incidentType, severityLevel, sourceIncidentId?, sourceIncidentIds?, ... }] }
    const zones = Array.isArray(result.items) ? result.items : [];
    const lng = Number(outage.longitude);
    const lat = Number(outage.latitude);

    const skipped = zones.filter((z) =>
      z && z.status === 'ACTIVE' && !z.affectedArea &&
      !(z.centerPoint && typeof z.radiusKm === 'number')
    );
    if (skipped.length) {
      console.warn(`[dispatch] ${skipped.length} active zones have no polygon/radius — skipped: ${skipped.map((z) => z.id).join(',')}`);
    }

    const matched = zones.find((z) =>
      z && z.status === 'ACTIVE' && nodeInZone(lng, lat, z)
    );

    if (!matched) return { matched: false };

    const incidentId = resolveIncidentId(matched);
    return {
      matched: true,
      incident_id: incidentId,
    };
  }, fallback);
}

function generateRequestId() {
  return `REQ-PW${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function callHelpService(outage, incident) {
  if (!PRIORITY_CASE_SERVICE_URL) throw new Error('PRIORITY_CASE_SERVICE_URL not configured');

  const place = outage.place_name ? ` (${outage.place_name})` : '';
  const requestId = generateRequestId();
  const payload = {
    request_id: requestId,
    incident_Id: incident.incident_id,
    incident_type: 'power_outage',
    latitude: Number(outage.latitude),
    longitude: Number(outage.longitude),
    description: `Node ${outage.node_id}${place} ไฟดับ`,
  };

  const fallback = async (cbErr) => {
    const reason = `PRIORITY_CASE_SERVICE_UNAVAILABLE: ${cbErr.message}`;
    await logAttempt({
      outage_event_id: outage.id, target: 'help',
      url: PRIORITY_CASE_SERVICE_URL, request_body: payload,
      error: reason, attempt_no: 0,
    });
    await markRejected(outage.id, reason);
    return { __rejected: true, reason };
  };

  return helpCB.call(async () => {
    const { result, error, attempt } = await withRetry(async (attemptNo) => {
      let httpResult;
      try {
        httpResult = await postJSON(PRIORITY_CASE_SERVICE_URL, payload);
      } catch (err) {
        await logAttempt({
          outage_event_id: outage.id, target: 'help',
          url: PRIORITY_CASE_SERVICE_URL, request_body: payload,
          error: err.message, attempt_no: attemptNo,
        });
        throw err;
      }
      await logAttempt({
        outage_event_id: outage.id, target: 'help',
        url: PRIORITY_CASE_SERVICE_URL, request_body: payload,
        http_status: httpResult.status, response_body: httpResult.text,
        attempt_no: attemptNo,
      });
      if (!httpResult.ok) throw new Error(`help service returned ${httpResult.status}`);
      return httpResult.json || {};
    }, MAX_RETRIES);

    if (error) {
      const reason = `PRIORITY_CASE_SERVICE_FAILED: ${error.message} (after ${attempt} attempts)`;
      await markRejected(outage.id, reason);
      return { __rejected: true, reason };
    }
    await recordPriorityCorrelation(outage.id, requestId, result && result.trace_id);
    return result;
  }, fallback);
}

// ── main dispatch ────────────────────────────────────────────────────

async function dispatch({ outage_event_id }) {
  const outage = await loadOutage(outage_event_id);
  if (!outage) throw new Error(`outage_event ${outage_event_id} not found`);

  // Skip already-processed events
  if (outage.dispatch_status !== 'pending') {
    console.log(`[dispatch] outage ${outage.id} already ${outage.dispatch_status} — skipping`);
    return { skipped: true, dispatch_status: outage.dispatch_status };
  }

  if (outage.latitude == null || outage.longitude == null) {
    console.warn(`[dispatch] ${outage.node_id} has no coordinates — skipping`);
    return { skipped: true };
  }

  // Optimistic locking: prevents double dispatch
  const locked = await acquireLock(outage.id, outage.version);
  if (!locked) {
    console.warn(`[dispatch] optimistic lock failed for outage ${outage.id} — another worker is handling it`);
    return { skipped: true, reason: 'lock_conflict' };
  }

  // Step 1: Call Incident Service (with CB + retry + fallback)
  const incident = await callIncidentService(outage);
  if (incident.__rejected) {
    console.warn(`[dispatch] outage ${outage.id} REJECTED: ${incident.reason}`);
    return { rejected: true, reason: incident.reason };
  }

  if (!incident.matched) {
    console.log(`[dispatch] outage ${outage.id} (${outage.node_id}) — no disaster match`);
    await markRejected(outage.id, 'NO_DISASTER_MATCH');
    return { matched: false };
  }

  if (!incident.incident_id) {
    const reason = 'INCIDENT_NO_ID: matched=true but no incident_id returned';
    await markRejected(outage.id, reason);
    return { rejected: true, reason };
  }

  // Step 2: Call Help Service (with CB + retry + fallback)
  const helpResult = await callHelpService(outage, incident);
  if (helpResult.__rejected) {
    console.warn(`[dispatch] outage ${outage.id} REJECTED at help stage: ${helpResult.reason}`);
    return { rejected: true, reason: helpResult.reason };
  }

  // Success: mark as dispatched
  await markDispatched(outage.id, incident.incident_id);
  console.log(`[dispatch] outage ${outage.id} → incident ${incident.incident_id} → help dispatched`);
  return { matched: true, incident_id: incident.incident_id };
}

exports.handler = async (event) => {
  const messages = extractMessages(event);
  for (const msg of messages) await dispatch(msg);
  return { processed: messages.length };
};

exports.dispatch = dispatch;
exports.getCircuitBreakerStates = () => ({
  incident: incidentCB.getState(),
  help: helpCB.getState(),
});
