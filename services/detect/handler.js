'use strict';

const { query } = require('@powergrid/db');

const SUSPECT_AFTER = Number(process.env.SUSPECT_AFTER_SECONDS || 60);
const OUTAGE_AFTER = Number(process.env.OUTAGE_AFTER_SECONDS || 120);

const PRIORITY_WEIGHTS = { critical: 100, important: 70, standard: 30 };

function calculatePriority(placeType, outageStartedAt) {
  const base = PRIORITY_WEIGHTS[placeType] || PRIORITY_WEIGHTS.standard;
  const durationMin = Math.floor((Date.now() - new Date(outageStartedAt).getTime()) / 60_000);
  return base + durationMin;
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

async function publishOutage(nodeId, outageEventId, priorityLevel) {
  const arn = process.env.SNS_OUTAGE_TOPIC_ARN;
  if (!arn) {
    console.log(`[detect] (local) outage-confirmed node=${nodeId} event=${outageEventId} priority=${priorityLevel}`);
    return;
  }
  const { sns, PublishCommand } = getSns();
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
  const { sns, PublishCommand } = getSns();
  await sns.send(new PublishCommand({
    TopicArn: arn,
    Message: JSON.stringify({ node_id: nodeId, status: newStatus, timestamp: new Date().toISOString() }),
    MessageAttributes: {
      event_type: { DataType: 'String', StringValue: 'status-changed' },
    },
  }));
}

async function detect() {
  // Single round-trip: drive both transitions (online→suspect, suspect→outage)
  // in one statement so steady-state ticks cost one DB query, not two.
  const r = await query(
    `WITH suspected AS (
       UPDATE nodes SET status = 'suspect'
       WHERE status = 'online'
         AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval
       RETURNING node_id
     ),
     outaged AS (
       UPDATE nodes SET status = 'outage'
       WHERE status = 'suspect'
         AND last_heartbeat_at < NOW() - ($2 || ' seconds')::interval
       RETURNING node_id, place_type, last_heartbeat_at
     )
     SELECT 'suspect'::text AS kind, node_id,
            NULL::text AS place_type,
            NULL::timestamptz AS last_heartbeat_at
       FROM suspected
     UNION ALL
     SELECT 'outage'::text, node_id, place_type::text, last_heartbeat_at FROM outaged`,
    [SUSPECT_AFTER, OUTAGE_AFTER]
  );

  if (r.rowCount === 0) return { suspected: 0, outaged: 0 };

  let suspected = 0;
  let outaged = 0;

  for (const row of r.rows) {
    if (row.kind === 'suspect') {
      console.log(`[detect] suspect: ${row.node_id}`);
      await publishStatusChange(row.node_id, 'suspect');
      suspected++;
      continue;
    }

    // last_heartbeat_at is when we last heard from the node — i.e. the moment
    // the outage actually began. Using new Date() here gave durationMin=0.
    const priorityLevel = calculatePriority(row.place_type, row.last_heartbeat_at);
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
      outaged++;
    }
  }

  return { suspected, outaged };
}

exports.handler = async () => detect();
exports.detect = detect;
