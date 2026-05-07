'use strict';

const express = require('express');
const { query } = require('@powergrid/db');
const { dispatch, getCircuitBreakerStates } = require('@powergrid/dispatch');

// Geometry helpers (mirrors services/dispatch/handler.js — keep in sync)
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
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function nodeInZone(nodeLng, nodeLat, zone) {
  if (zone.affectedArea && pointInPolygon(nodeLng, nodeLat, zone.affectedArea)) return true;
  if (zone.centerPoint && typeof zone.radiusKm === 'number') {
    const d = haversineKm(nodeLat, nodeLng, zone.centerPoint.lat, zone.centerPoint.lng);
    if (d <= zone.radiusKm) return true;
  }
  return false;
}

function createApp() {
  const app = express();
  app.use(express.json());

  // ── CORS (open for demo) ────────────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ── Authentication ──────────────────────────────────────────────
  const apiKey = process.env.API_KEY;
  const adminKey = process.env.ADMIN_API_KEY || apiKey; // separate admin key

  app.use((req, res, next) => {
    if (!apiKey) return next();
    if (req.path === '/health') return next();
    if (req.path.startsWith('/demo/')) return next(); // demo endpoints are public

    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'missing api key' });

    // Admin routes require adminKey
    if (req.path.includes('/admin')) {
      if (key !== adminKey) return res.status(403).json({ error: 'forbidden: admin access required' });
    } else {
      if (key !== apiKey && key !== adminKey) {
        return res.status(401).json({ error: 'invalid api key' });
      }
    }
    next();
  });

  // ── Health ──────────────────────────────────────────────────────
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ── Nodes ───────────────────────────────────────────────────────
  app.get('/nodes', async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      const countRes = await query(`SELECT COUNT(*) FROM nodes`);
      const total = parseInt(countRes.rows[0].count);

      const r = await query(
        `SELECT node_id, place_name, latitude, longitude, place_type,
                voltage, status, last_heartbeat_at,
                EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))::int AS seconds_since_heartbeat
         FROM nodes ORDER BY node_id
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      res.json({ nodes: r.rows, page, limit, total });
    } catch (err) { next(err); }
  });

  app.get('/nodes/:id', async (req, res, next) => {
    try {
      const r = await query(`SELECT * FROM nodes WHERE node_id = $1`, [req.params.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json(r.rows[0]);
    } catch (err) { next(err); }
  });

  // ── Outages ─────────────────────────────────────────────────────
  app.get('/outages', async (req, res, next) => {
    try {
      const open = req.query.open === 'true';
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      const whereClause = open ? 'WHERE ended_at IS NULL' : '';
      const countRes = await query(`SELECT COUNT(*) FROM outage_events ${whereClause}`);
      const total = parseInt(countRes.rows[0].count);

      const r = await query(
        `SELECT id, node_id, started_at, ended_at, status, incident_id,
                priority_level, dispatch_status, rejection_reason
         FROM outage_events
         ${whereClause}
         ORDER BY priority_level DESC, started_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      res.json({ outages: r.rows, page, limit, total });
    } catch (err) { next(err); }
  });

  app.get('/outages/:id', async (req, res, next) => {
    try {
      const o = await query(`SELECT * FROM outage_events WHERE id = $1`, [req.params.id]);
      if (o.rowCount === 0) return res.status(404).json({ error: 'not found' });
      const log = await query(
        `SELECT id, target, url, http_status, error, attempt_no, sent_at
         FROM dispatch_log WHERE outage_event_id = $1 ORDER BY sent_at`,
        [req.params.id]
      );
      res.json({ outage: o.rows[0], dispatch_log: log.rows });
    } catch (err) { next(err); }
  });

  // ── Circuit Breaker status ──────────────────────────────────────
  app.get('/circuit-breakers', (_req, res) => {
    res.json(getCircuitBreakerStates());
  });

  // ── Admin ───────────────────────────────────────────────────────
  app.post('/admin/reset-node', async (req, res, next) => {
    try {
      const { node_id } = req.body;
      if (!node_id) return res.status(400).json({ error: 'node_id required' });
      await query(
        `UPDATE nodes SET status='online', last_heartbeat_at=NOW() WHERE node_id=$1`,
        [node_id]
      );
      await query(
        `UPDATE outage_events SET ended_at=NOW(), status='resolved'
         WHERE node_id=$1 AND ended_at IS NULL`,
        [node_id]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post('/admin/dispatch-test', async (req, res, next) => {
    try {
      const { outage_event_id } = req.body;
      if (!outage_event_id) return res.status(400).json({ error: 'outage_event_id required' });
      const result = await dispatch({ outage_event_id });
      res.json({ ok: true, result });
    } catch (err) { next(err); }
  });

  // ── Demo endpoints (for the demo console UI) ────────────────────
  let iotClient;
  function getIotClient() {
    if (iotClient) return iotClient;
    const endpoint = process.env.IOT_ENDPOINT;
    if (!endpoint) throw new Error('IOT_ENDPOINT env var not set');
    const { IoTDataPlaneClient } = require('@aws-sdk/client-iot-data-plane');
    iotClient = new IoTDataPlaneClient({
      region: process.env.AWS_REGION,
      endpoint: endpoint.startsWith('http') ? endpoint : `https://${endpoint}`,
    });
    return iotClient;
  }

  // Browser-driven heartbeat: publish to IoT Core (so the full pipeline runs)
  app.post('/demo/heartbeat/:nodeId', async (req, res, next) => {
    try {
      const nodeId = req.params.nodeId;
      const voltage = req.body && req.body.voltage != null ? Number(req.body.voltage) : 220 + Math.random() * 4;
      const payload = {
        node_id: nodeId,
        timestamp: new Date().toISOString(),
        voltage,
      };
      const { PublishCommand } = require('@aws-sdk/client-iot-data-plane');
      await getIotClient().send(new PublishCommand({
        topic: `powergrid/nodes/${nodeId}/heartbeat`,
        payload: Buffer.from(JSON.stringify(payload)),
        qos: 0,
      }));
      res.json({ ok: true, published: payload });
    } catch (err) { next(err); }
  });

  // Proxy: fetch active impact zones from Incident Service (with Bearer auth)
  app.get('/demo/impact-zones', async (_req, res, next) => {
    try {
      const url = process.env.INCIDENT_IMPACT_ZONE_URL;
      const secret = process.env.OUTBOUND_SHARED_SECRET || '';
      if (!url) return res.status(500).json({ error: 'INCIDENT_IMPACT_ZONE_URL not configured' });

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
          signal: ctrl.signal,
        });
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 4096) }; }

        // Tag each zone with the node_ids it currently affects (point-in-polygon on demand)
        if (body && Array.isArray(body.items)) {
          const nodes = (await query(
            `SELECT node_id, latitude, longitude FROM nodes
             WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
          )).rows;
          for (const z of body.items) {
            z._affected_node_ids = nodes
              .filter((n) => nodeInZone(Number(n.longitude), Number(n.latitude), z))
              .map((n) => n.node_id);
          }
        }

        res.status(r.ok ? 200 : r.status).json({ status: r.status, body });
      } finally { clearTimeout(t); }
    } catch (err) { next(err); }
  });

  // List nodes (richer payload for the demo console)
  app.get('/demo/nodes', async (_req, res, next) => {
    try {
      const r = await query(
        `SELECT node_id, place_name, latitude, longitude, place_type,
                voltage, status, last_heartbeat_at,
                EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))::int AS seconds_since_heartbeat
         FROM nodes ORDER BY node_id`
      );
      res.json({ nodes: r.rows });
    } catch (err) { next(err); }
  });

  // List outages with node info joined
  app.get('/demo/outages', async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const r = await query(
        `SELECT e.id, e.node_id, e.started_at, e.ended_at, e.status,
                e.incident_id, e.priority_level, e.dispatch_status,
                e.rejection_reason, e.priority_request_id, e.priority_trace_id,
                n.place_name, n.place_type
         FROM outage_events e
         LEFT JOIN nodes n ON n.node_id = e.node_id
         ORDER BY e.started_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json({ outages: r.rows });
    } catch (err) { next(err); }
  });

  // Dispatch log for one outage
  app.get('/demo/dispatch-log', async (req, res, next) => {
    try {
      const outageId = parseInt(req.query.outageId);
      if (!outageId) return res.status(400).json({ error: 'outageId required' });
      const r = await query(
        `SELECT id, target, url, http_status, error, attempt_no, sent_at,
                request_body, response_body
         FROM dispatch_log WHERE outage_event_id = $1
         ORDER BY sent_at`,
        [outageId]
      );
      res.json({ dispatch_log: r.rows });
    } catch (err) { next(err); }
  });

  // Reset a node back to online (and resolve any open outage)
  app.post('/demo/reset/:nodeId', async (req, res, next) => {
    try {
      const nodeId = req.params.nodeId;
      await query(
        `UPDATE nodes SET status='online', last_heartbeat_at=NOW() WHERE node_id=$1`,
        [nodeId]
      );
      await query(
        `UPDATE outage_events SET ended_at=NOW(), status='resolved'
         WHERE node_id=$1 AND ended_at IS NULL`,
        [nodeId]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Error handler ───────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    console.error('[api] error', err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

module.exports = { createApp };
