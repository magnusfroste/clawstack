'use strict';
const http    = require('http');
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { BASE_DOMAIN, ADMIN_USER, ADMIN_PASS } = require('./lib/config');
const db        = require('./lib/db');
const { getProxy, proxyWs } = require('./lib/docker');
const { requireAdmin } = require('./lib/auth');
const { createWss, tokenStore } = require('./lib/terminal');
const deviceWatcher = require('./lib/device-watcher');

const app = express();

// ── Reverse proxy (must be first — before body parsing) ──────────────────────
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!BASE_DOMAIN || host === BASE_DOMAIN) return next();

  const row = db.prepare('SELECT container_name FROM instances WHERE domain = ?').get(host);
  if (!row) return next();

  const isA2A = req.path.startsWith('/a2a/') || req.path === '/.well-known/agent.json';
  return getProxy(row.container_name, isA2A ? 18800 : 18789)(req, res, next);
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Routes ────────────────────────────────────────────────────────────────────
require('./routes/system').register(app);
require('./routes/instances').register(app);
require('./routes/paperclip').register(app);

// ── SPA / index.html (admin portal) ──────────────────────────────────────────
function servePortal(req, res) {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const creds = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');
  res.send(html.replace('%%AUTH%%', JSON.stringify(`Basic ${creds}`)));
}
app.get('/', requireAdmin, servePortal);
app.get('/instances/:name', requireAdmin, servePortal);
app.get('/paperclip',      requireAdmin, servePortal);
app.get('/system',         requireAdmin, servePortal);

// ── HTTP server + WebSocket upgrade ──────────────────────────────────────────
const server = http.createServer(app);
const wss    = createWss();

server.on('upgrade', (req, socket, head) => {
  const url  = new URL(req.url, 'http://localhost');
  const host = (req.headers.host || '').split(':')[0];

  // PTY terminal WebSocket
  if (url.pathname === '/ws/terminal') {
    const token = url.searchParams.get('token');
    const entry = tokenStore.get(token);
    if (!entry || entry.expires < Date.now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    tokenStore.delete(token);
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, entry);
    });
    return;
  }

  // WebSocket proxy for OpenClaw instances
  if (BASE_DOMAIN && host !== BASE_DOMAIN) {
    const row = db.prepare('SELECT container_name FROM instances WHERE domain = ?').get(host);
    if (row) {
      const isA2A = url.pathname.startsWith('/a2a/');
      return proxyWs(req, socket, head, row.container_name, isA2A ? 18800 : 18789);
    }
  }

  socket.destroy();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ClawStack portal listening on :${PORT}`);
  deviceWatcher.start();
});
