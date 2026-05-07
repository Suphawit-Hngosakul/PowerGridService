'use strict';

require('dotenv').config();
const mqtt = require('mqtt');
const readline = require('readline');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const HEARTBEAT_INTERVAL_MS = Number(process.env.SIM_HEARTBEAT_INTERVAL_MS || 10_000);

const args = parseArgs(process.argv.slice(2));
const nodeIds = args.nodes
  ? args.nodes.split(',')
  : Array.from({ length: Number(args.count || process.env.SIM_NODE_COUNT || 3) },
    (_, i) => `node-${String(i + 1).padStart(3, '0')}`);

const downSet = new Set();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

const client = mqtt.connect(MQTT_URL);

client.on('connect', () => {
  console.log(`[sim] connected to ${MQTT_URL}, simulating: ${nodeIds.join(', ')}`);
  console.log(`[sim] commands: "down <node>", "up <node>", "list", "exit"`);
  setInterval(publishAll, HEARTBEAT_INTERVAL_MS);
  publishAll();
  startRepl();
});

client.on('error', (err) => {
  console.error('[sim] mqtt error', err.message);
});

function publishAll() {
  for (const nodeId of nodeIds) {
    if (downSet.has(nodeId)) continue;
    const payload = {
      node_id: nodeId,
      timestamp: new Date().toISOString(),
      voltage: 218 + Math.random() * 4,
    };
    const topic = `powergrid/nodes/${nodeId}/heartbeat`;
    client.publish(topic, JSON.stringify(payload));
  }
  const aliveCount = nodeIds.length - downSet.size;
  process.stdout.write(`[sim] published ${aliveCount}/${nodeIds.length} heartbeats\r`);
}

function startRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    if (cmd === 'down' && arg) {
      downSet.add(arg);
      console.log(`\n[sim] ${arg} marked DOWN`);
    } else if (cmd === 'up' && arg) {
      downSet.delete(arg);
      console.log(`\n[sim] ${arg} marked UP`);
    } else if (cmd === 'list') {
      console.log(`\n[sim] nodes=${nodeIds.join(',')} down=${[...downSet].join(',') || 'none'}`);
    } else if (cmd === 'exit') {
      client.end(() => process.exit(0));
    }
  });
}

process.on('SIGINT', () => client.end(() => process.exit(0)));
