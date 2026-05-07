'use strict';

const { query } = require('@powergrid/db');

const SUSPECT_AFTER = Number(process.env.SUSPECT_AFTER_SECONDS || 60);
const OUTAGE_AFTER = Number(process.env.OUTAGE_AFTER_SECONDS || 120);

// Priority weights by place_type — higher = more urgent
const PRIORITY_WEIGHTS = { critical: 100, important: 70, standard: 30 };

// Bonus: +1 point per minute the outage has been active
function calculatePriority(placeType, outageStartedAt) {
  const base = PRIORITY_WEIGHTS[placeType] || PRIORITY_WEIGHTS.standard;
  const durationMin = Math.floor((Date.now() - new Date(outageStartedAt).getTime()) / 60_000);
  return base + durationMin;
}

async function publishOutage(nodeId, outageEventId, priorityLevel) {
  const arn = process.env.SNS_OUTAGE_TOPIC_ARN;
  if (!arn) {
    console.log(`[detect] (local) outage-confirmed node=${nodeId} event=${outageEventId} priority=${priorityLevel}`);
    return;
  }
  // Lazy-load AWS SDK so local dev doesn't need it.
  const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
  const sns = new SNSClient({ region: process.env.AWS_REGION });
  await sns.send(new PublishCommand({
    TopicArn: arn,
    Message: JSON.stringify({
      node_id: nodeId,
      outage_event_id: outageEventId,
      priority_level: priorityLevel,
    }),
    MessageAttributes: {
      event_type: { DataType: 'String', StringValue: 'outage-confirmed' },
    },
  }));
}

async function publishStatusChange(nodeId, newStatus) {
  const arn = process.env.SNS_STATUS_TOPIC_ARN;
  if (!arn) {
    console.log(`[detect] (local) status-changed node=${nodeId} status=${newStatus}`);
    return;
  }
  const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
  const sns = new SNSClient({ region: process.env.AWS_REGION });
  await sns.send(new PublishCommand({
    TopicArn: arn,
    Message: JSON.stringify({ node_id: nodeId, status: newStatus, timestamp: new Date().toISOString() }),
    MessageAttributes: {
      event_type: { DataType: 'String', StringValue: 'status-changed' },
    },
  }));
}

async function detect() {
  // Step 1: online → suspect (no heartbeat for >= SUSPECT_AFTER seconds)
  const toSuspect = await query(
    `UPDATE nodes
     SET status = 'suspect'
     WHERE status = 'online'
       AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval
     RETURNING node_id`,
    [SUSPECT_AFTER]
  );
  for (const r of toSuspect.rows) {
    console.log(`[detect] suspect: ${r.node_id}`);
    await publishStatusChange(r.node_id, 'suspect');
  }

  // Step 2: suspect → outage (no heartbeat for >= OUTAGE_AFTER seconds)
  const toOutage = await query(
    `UPDATE nodes
     SET status = 'outage'
     WHERE status = 'suspect'
       AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval
     RETURNING node_id, place_type`,
    [OUTAGE_AFTER]
  );

  for (const row of toOutage.rows) {
    // Idempotent: skip if there is already an open outage for this node.
    const now = new Date();
    const priorityLevel = calculatePriority(row.place_type, now);

    const inserted = await query(
      `INSERT INTO outage_events (node_id, priority_level)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM outage_events WHERE node_id = $1 AND ended_at IS NULL
       )
       RETURNING id`,
      [row.node_id, priorityLevel]
    );
    if (inserted.rowCount > 0) {
      console.log(`[detect] OUTAGE confirmed: ${row.node_id} (event ${inserted.rows[0].id}, priority=${priorityLevel})`);
      await publishOutage(row.node_id, inserted.rows[0].id, priorityLevel);
      await publishStatusChange(row.node_id, 'outage');
    }
  }

  return {
    suspected: toSuspect.rowCount,
    outaged: toOutage.rowCount,
  };
}

exports.handler = async () => detect();
exports.detect = detect;
