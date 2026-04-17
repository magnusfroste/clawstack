'use strict';
const db = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

// Shared token for agent-to-agent access (no user session required)
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'bridge-dev-token';

function agentAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token && token === BRIDGE_TOKEN) return next();
  // Fall back to admin auth
  return requireAdmin(req, res, next);
}

function register(app) {
  // POST /api/bridge — post a message
  app.post('/api/bridge', agentAuth, (req, res) => {
    const { sender, message, thread = 'main', meta } = req.body;
    if (!sender || !message) {
      return res.status(400).json({ error: '`sender` and `message` are required' });
    }
    const row = db.prepare(
      `INSERT INTO bridge_messages (thread, sender, message, meta) VALUES (?,?,?,?) RETURNING *`
    ).get(thread, sender, message, meta ? JSON.stringify(meta) : null);
    res.json({ ok: true, id: row.id, created_at: row.created_at });
  });

  // GET /api/bridge?thread=main&since_id=0&limit=50 — read messages
  app.get('/api/bridge', agentAuth, (req, res) => {
    const thread   = req.query.thread   || 'main';
    const since_id = parseInt(req.query.since_id || '0', 10);
    const limit    = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const rows = db.prepare(
      `SELECT id, thread, sender, message, meta, created_at
       FROM bridge_messages
       WHERE thread = ? AND id > ?
       ORDER BY id ASC LIMIT ?`
    ).all(thread, since_id, limit);
    rows.forEach(r => { if (r.meta) try { r.meta = JSON.parse(r.meta); } catch {} });
    res.json({ thread, messages: rows });
  });

  // DELETE /api/bridge?thread=main — clear a thread (admin only)
  app.delete('/api/bridge', requireAdmin, (req, res) => {
    const thread = req.query.thread || 'main';
    const { changes } = db.prepare(`DELETE FROM bridge_messages WHERE thread = ?`).run(thread);
    res.json({ ok: true, deleted: changes });
  });
}

module.exports = { register };
