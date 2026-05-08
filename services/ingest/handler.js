'use strict';

const { withTransaction } = require('@powergrid/db');

function extractRecords(event) {
  if (Array.isArray(event)) return event;
  if (event && Array.isArray(event.Records)) {
    return event.Records.map((r) => {
      try { return JSON.parse(r.body); } catch { return null; }
    }).filter(Boolean);
  }
  if (event && event.node_id) return [event];
  return [];
}

let snsClient;
let PublishCommandRef;
function getSns() {
  if (snsClient) return { sns: snsClient, PublishCommand: PublishCommandRef };
  const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
  snsClient = new SNSClient({ region: process.env.AWS_REGION });
  PublishCommandRef = PublishCommand;
  return { sns: snsClient, PublishCommand };
}

async function publishStatusChange(nodeId, newStatus) {
  const arn = process.env.SNS_STATUS_TOPIC_ARN;
  if (!arn) {
    console.log(`[ingest] (local) status-changed node=${nodeId} status=${newStatus}`);
    return;
  }
  const { sns, PublishCommand } = getSns();
  await sns.send(new PublishCommand({
    TopicArn: arn,
    Message: JSON.stringify({ node_id: nodeId, status: newStatus, timestamp: new Date().toISOString() }),
    MessageAttributes: {
      event_type: { DataType: 'String', StringValue: 'status-changed' },
    },
  }));
}

async function ingest(payload) {
  const { node_id, timestamp, voltage } = payload;
  if (!node_id || !timestamp) {
    throw new Error('payload missing node_id or timestamp');
  }

  return withTransaction(async (client) => {
    // Auto-register unknown nodes so the simulator can introduce new ones.
    const upsert = await client.query(
      `INSERT INTO nodes (node_id, last_heartbeat_at, voltage)
       VALUES ($1, $2::timestamptz, $3::numeric)
       ON CONFLICT (node_id) DO UPDATE SET
         last_heartbeat_at = GREATEST(nodes.last_heartbeat_at, EXCLUDED.last_heartbeat_at),
         voltage = COALESCE(EXCLUDED.voltage, nodes.voltage),
         status = CASE WHEN nodes.status IN ('suspect','outage') THEN 'online'::node_status ELSE nodes.status END
       RETURNING (SELECT status FROM nodes WHERE node_id = $1) AS new_status,
                 xmax::text::int > 0 AS updated`,
      [node_id, timestamp, voltage ?? null]
    );

    // Re-read prior status by checking outage_events: if there is an open one,
    // we just recovered.
    const open = await client.query(
      `UPDATE outage_events
       SET ended_at = NOW(), status = 'resolved'
       WHERE node_id = $1 AND ended_at IS NULL
       RETURNING id`,
      [node_id]
    );

    const recovered = open.rowCount > 0;
    if (recovered) {
      console.log(`[ingest] ${node_id} recovered from outage (event ${open.rows[0].id})`);
      await publishStatusChange(node_id, 'online');
    }
    return { node_id, recovered, new_status: upsert.rows[0].new_status };
  });
}

exports.handler = async (event) => {
  const records = extractRecords(event);
  const results = [];
  for (const rec of records) {
    try {
      results.push(await ingest(rec));
    } catch (err) {
      console.error('[ingest] failed', err.message, rec);
    }
  }
  return { ingested: results.length };
};
