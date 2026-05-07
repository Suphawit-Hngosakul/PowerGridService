'use strict';

const { query } = require('@powergrid/db');

function extractMessages(event) {
  if (event && Array.isArray(event.Records)) {
    return event.Records.map((r) => {
      try {
        const body = JSON.parse(r.body);
        return body.Message ? JSON.parse(body.Message) : body;
      } catch { return null; }
    }).filter(Boolean);
  }
  if (event && event.event_type) return [event];
  return [];
}

async function confirm(msg) {
  if (msg.event_type !== 'POWERGRID_COMPLETED') {
    console.log(`[confirm] ignoring event_type=${msg.event_type}`);
    return { skipped: true, reason: 'wrong_event_type' };
  }

  const requestId = msg.request_id;
  const completedAt = msg.completed_at || msg.timestamp || null;
  const reportedNodeId = msg.destination && msg.destination.destination_id;

  if (!requestId) {
    console.warn('[confirm] message missing request_id, skipping', msg.event_id);
    return { skipped: true, reason: 'no_request_id' };
  }

  const result = await query(
    `UPDATE outage_events
     SET dispatch_status = 'confirmed',
         ended_at = COALESCE($2::timestamptz, NOW()),
         status = 'resolved'
     WHERE priority_request_id = $1 AND dispatch_status = 'dispatched'
     RETURNING id, node_id`,
    [requestId, completedAt]
  );

  if (result.rowCount === 0) {
    console.warn(`[confirm] no dispatched outage for request_id=${requestId} (reported destination=${reportedNodeId})`);
    return { matched: false };
  }

  const { id: outageId, node_id: nodeId } = result.rows[0];

  await query(
    `UPDATE nodes SET status = 'online', last_heartbeat_at = NOW() WHERE node_id = $1`,
    [nodeId]
  );

  console.log(`[confirm] outage ${outageId} confirmed (request_id=${requestId} node=${nodeId})`);
  return { confirmed: true, outage_id: outageId, node_id: nodeId };
}

exports.handler = async (event) => {
  const messages = extractMessages(event);
  for (const msg of messages) {
    try {
      await confirm(msg);
    } catch (err) {
      console.error('[confirm] failed', err.message, msg.event_id);
    }
  }
  return { processed: messages.length };
};
