'use strict';

const express = require('express');
const { query } = require('@powergrid/db');
const { dispatch, getCircuitBreakerStates } = require('@powergrid/dispatch');

function createApp() {
  const app = express();
  app.use(express.json());

  // ── Authentication ──────────────────────────────────────────────
  const apiKey = process.env.API_KEY;
  const adminKey = process.env.ADMIN_API_KEY || apiKey; // separate admin key

  app.use((req, res, next) => {
    if (!apiKey) return next();
    if (req.path === '/health') return next();

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

  // ── Error handler ───────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    console.error('[api] error', err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

module.exports = { createApp };
