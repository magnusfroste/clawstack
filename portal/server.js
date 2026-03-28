const express = require('express');
const Docker = require('dockerode');
const Database = require('better-sqlite3');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const db = new Database('/data/clawstack.db');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const BASE_DOMAIN = process.env.BASE_DOMAIN || '';
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.3.24';
const INSTANCES_DIR = '/instances';
const INSTANCES_HOST_DIR = process.env.INSTANCES_HOST_DIR || '/opt/clawstack/instances';

// --- DB ---
db.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    domain TEXT UNIQUE NOT NULL,
    container_name TEXT UNIQUE NOT NULL,
    token TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'starting',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- Reverse proxy: MUST be first — routes customer domains before any admin middleware ---
const proxyCache = {};
function getProxy(containerName) {
  if (!proxyCache[containerName]) {
    proxyCache[containerName] = createProxyMiddleware({
      target: `http://${containerName}:18789`,
      changeOrigin: false,
      ws: true,
    });
  }
  return proxyCache[containerName];
}

app.use((req, res, next) => {
  const host = req.hostname;
  if (!host || host === BASE_DOMAIN) return next();
  const row = db.prepare('SELECT container_name FROM instances WHERE domain = ?').get(host);
  if (!row) return res.status(404).send('Not found');
  getProxy(row.container_name)(req, res, next);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Auth ---
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="ClawStack"');
    return res.status(401).send('Unauthorized');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.status(401).send('Invalid credentials');
}

// Provider base URLs and API types for models.json
const PROVIDER_CONFIGS = {
  openrouter:  { baseUrl: 'https://openrouter.ai/api/v1',                            api: 'openai-completions' },
  openai:      { baseUrl: 'https://api.openai.com/v1',                               api: 'openai-completions' },
  anthropic:   { baseUrl: 'https://api.anthropic.com',                               api: 'anthropic-messages'  },
  gemini:      { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', api: 'openai-completions' },
  private:     { baseUrl: '',                                                         api: 'openai-completions' },
};

// --- Bootstrap: write OpenClaw config files before container starts ---
function bootstrapInstance({ name, domain, provider, apiKey, model, token, baseUrl }) {
  const configDir = path.join(INSTANCES_DIR, name, 'config');
  const agentDir = path.join(configDir, 'agents', 'main', 'agent');
  const sessionsDir = path.join(configDir, 'agents', 'main', 'sessions');

  const dirs = [agentDir, sessionsDir,
    path.join(configDir, 'devices'),
    path.join(configDir, 'logs'),
    path.join(configDir, 'canvas'),
  ];
  dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));
  // OpenClaw runs as uid 1000 — ensure it can write
  dirs.concat([configDir]).forEach(d => fs.chownSync(d, 1000, 1000));

  // model reference format: "{provider}/{modelId}"
  // modelId is the part after provider prefix if present, otherwise the full model string
  const modelId = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  const fullModelRef = `${provider}/${modelId}`;

  // Provider base URL and API type (baseUrl arg overrides for private provider)
  const providerConf = PROVIDER_CONFIGS[provider] || { baseUrl: '', api: 'openai-completions' };
  if (baseUrl) providerConf.baseUrl = baseUrl;

  // 1. openclaw.json — all config in one file (models.providers is where OpenClaw reads API keys)
  fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
    meta: {
      lastTouchedVersion: '2026.3.24',
      lastTouchedAt: new Date().toISOString(),
    },
    models: {
      providers: {
        [provider]: {
          baseUrl: providerConf.baseUrl,
          apiKey: '${OPENCLAW_PROVIDER_API_KEY}',
          api: providerConf.api,
          models: [{ id: modelId, name: modelId }],
        }
      }
    },
    agents: {
      defaults: {
        model: { primary: fullModelRef },
        maxConcurrent: 4,
        subagents: { maxConcurrent: 8 },
      }
    },
    gateway: {
      bind: 'lan',
      remote: { url: `https://${domain}` },
      auth: { token: token },
      controlUi: {
        allowedOrigins: [
          'http://localhost:18789',
          `https://${domain}`
        ],
        dangerouslyDisableDeviceAuth: true
      }
    },
  }, null, 2));
}

// --- Caddy on-demand TLS verification ---
app.get('/api/verify-domain', (req, res) => {
  const domain = req.query.domain;
  if (!domain) return res.status(400).send('domain required');
  const row = db.prepare('SELECT id FROM instances WHERE domain = ?').get(domain);
  return row ? res.status(200).send('ok') : res.status(404).send('not found');
});

// --- API ---
app.get('/api/instances', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, domain, container_name, provider, model, status, created_at FROM instances ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/instances', requireAdmin, async (req, res) => {
  const { name, domain, provider, model, baseUrl } = req.body;
  const apiKey = NO_KEY_PROVIDERS.has(provider) ? (req.body.apiKey || 'none') : req.body.apiKey;
  if (!name || !domain || !provider || !model || (!NO_KEY_PROVIDERS.has(provider) && !apiKey))
    return res.status(400).json({ error: 'name, domain, provider, model required (and apiKey for this provider)' });
  if (provider === 'private' && !baseUrl)
    return res.status(400).json({ error: 'baseUrl required for Private LLM provider' });

  const containerName = `clawstack-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const token = crypto.randomBytes(32).toString('hex');

  try {
    db.prepare('INSERT INTO instances (name, domain, container_name, token, provider, model) VALUES (?, ?, ?, ?, ?, ?)').run(name, domain.toLowerCase(), containerName, token, provider, model);
  } catch (e) {
    return res.status(400).json({ error: 'name or domain already exists' });
  }

  try {
    bootstrapInstance({ name, domain, provider, apiKey, model, token, baseUrl });
  } catch (e) {
    db.prepare('DELETE FROM instances WHERE name = ?').run(name);
    return res.status(500).json({ error: `Bootstrap failed: ${e.message}` });
  }

  try {
    const container = await docker.createContainer({
      name: containerName,
      Image: OPENCLAW_IMAGE,
      Env: [
        `OPENCLAW_GATEWAY_TOKEN=${token}`,
        `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=true`,
        `OPENCLAW_PROVIDER_API_KEY=${apiKey}`,
        `TZ=${process.env.TZ || 'Europe/Stockholm'}`,
      ],
      HostConfig: {
        NetworkMode: 'clawstack',
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: [
          `${INSTANCES_HOST_DIR}/${name}/config:/home/node/.openclaw`,
          `${INSTANCES_HOST_DIR}/${name}/workspace:/home/node/.openclaw/workspace`,
        ],
      },
    });
    await container.start();
    db.prepare('UPDATE instances SET status = ? WHERE container_name = ?').run('running', containerName);
    res.json({ success: true, name, domain });
  } catch (e) {
    db.prepare('UPDATE instances SET status = ? WHERE container_name = ?').run('error', containerName);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/instances/:name', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });

  try {
    const container = docker.getContainer(row.container_name);
    await container.stop().catch(() => {});
    await container.remove().catch(() => {});
  } catch (e) { /* already gone */ }

  db.prepare('DELETE FROM instances WHERE name = ?').run(req.params.name);
  res.json({ success: true });
});

// --- File Management API ---
function resolveInstancePath(instanceName, relPath) {
  const base = path.join(INSTANCES_DIR, instanceName, 'config');
  const full = path.resolve(base, relPath || '');
  if (full !== base && !full.startsWith(base + path.sep))
    throw new Error('Path traversal not allowed');
  return full;
}

app.get('/api/instances/:name/files', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT id FROM instances WHERE name = ?').get(req.params.name))
    return res.status(404).json({ error: 'not found' });
  try {
    const full = resolveInstancePath(req.params.name, req.query.path || '');
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(full, { withFileTypes: true })
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? fs.statSync(path.join(full, e.name)).size : 0 }))
        .sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
      return res.json({ type: 'dir', entries });
    }
    if (stat.size > 512 * 1024) return res.status(413).json({ error: 'File too large (>512 KB)' });
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return res.status(415).json({ error: 'Binary file — cannot edit' });
    res.json({ type: 'file', content: buf.toString('utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/instances/:name/files', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT id FROM instances WHERE name = ?').get(req.params.name))
    return res.status(404).json({ error: 'not found' });
  const { path: filePath, content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    const full = resolveInstancePath(req.params.name, filePath);
    if (fs.statSync(full).isDirectory()) return res.status(400).json({ error: 'is a directory' });
    fs.writeFileSync(full, content, 'utf8');
    fs.chownSync(full, 1000, 1000);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Container Actions ---
app.post('/api/instances/:name/action', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT container_name, status FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    const container = docker.getContainer(row.container_name);
    if (req.body.action === 'stop') {
      await container.stop().catch(() => {});
      db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('stopped', req.params.name);
    } else if (req.body.action === 'start') {
      await container.start();
      db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('running', req.params.name);
    } else if (req.body.action === 'restart') {
      await container.restart().catch(() => {});
      db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('running', req.params.name);
    } else {
      return res.status(400).json({ error: 'unknown action' });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Logs API ---
app.get('/api/instances/:name/logs', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    const container = docker.getContainer(row.container_name);
    const buf = await container.logs({ stdout: true, stderr: true, tail: parseInt(req.query.tail) || 300, timestamps: true });
    // Demux Docker multiplexed log stream
    let offset = 0, lines = [];
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      offset += 8;
      if (offset + size > buf.length) break;
      lines.push(buf.slice(offset, offset + size).toString('utf8'));
      offset += size;
    }
    res.json({ logs: lines.join('') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Exec API (runs as root in container) ---
app.post('/api/instances/:name/exec', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { cmd } = req.body;
  if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
  try {
    const container = docker.getContainer(row.container_name);
    const exec = await container.exec({
      Cmd: ['sh', '-c', cmd],
      AttachStdout: true,
      AttachStderr: true,
      User: 'root',
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data', d => chunks.push(d));
      stream.on('end', resolve);
      stream.on('error', reject);
      setTimeout(resolve, 30000); // max 30s
    });
    // Demux multiplexed stream
    const buf = Buffer.concat(chunks);
    let offset = 0, lines = [];
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      offset += 8;
      if (offset + size > buf.length) break;
      lines.push(buf.slice(offset, offset + size).toString('utf8'));
      offset += size;
    }
    const output = lines.join('') || buf.toString('utf8');
    const inspect = await exec.inspect();
    res.json({ output, exitCode: inspect.ExitCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Status API ---
app.get('/api/instances/:name/status', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    const info = await docker.getContainer(row.container_name).inspect();
    const status = info.State.Running ? 'running' : (info.State.Status || 'stopped');
    db.prepare('UPDATE instances SET status = ? WHERE name = ?').run(status, req.params.name);
    res.json({ status });
  } catch (e) {
    db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('error', req.params.name);
    res.json({ status: 'error' });
  }
});

// --- Admin UI ---
const PROVIDERS = ['openrouter', 'openai', 'anthropic', 'gemini', 'private'];
const MODEL_PRESETS = {
  openrouter: 'openrouter/auto',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.0-flash',
  private: 'my-model',
};
// Providers where API key is optional
const NO_KEY_PROVIDERS = new Set(['private']);

app.get('/', requireAdmin, (req, res) => {
  const instances = db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all();
  const authHeader = JSON.stringify(req.headers.authorization || '');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>ClawStack</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e5e5e5;padding:2rem;max-width:1000px;margin:0 auto}
    h1{font-size:1.4rem;margin-bottom:1.75rem;color:#fff}
    h2{font-size:0.78rem;color:#555;font-weight:500;margin-bottom:1rem;text-transform:uppercase;letter-spacing:.06em}
    .card{background:#161616;border:1px solid #252525;border-radius:8px;padding:1.4rem;margin-bottom:1rem}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:0.7rem}
    .full{grid-column:1/-1}
    label{display:block;font-size:0.78rem;color:#777;margin-bottom:3px}
    input,select{width:100%;background:#0f0f0f;border:1px solid #2e2e2e;color:#e5e5e5;padding:7px 11px;border-radius:5px;font-size:0.88rem}
    select option{background:#111}
    .btn{display:inline-flex;align-items:center;gap:5px;border:none;border-radius:5px;cursor:pointer;font-size:0.82rem;padding:5px 12px;color:#fff;background:#2563eb}
    .btn:disabled{opacity:.35;cursor:default}
    .btn.sm{padding:3px 9px;font-size:0.76rem}
    .btn.danger{background:#b91c1c}
    .btn.ghost{background:#252525;color:#aaa}
    .btn.amber{background:#b45309}
    .btn.green{background:#15803d}
    .btn.primary{background:#2563eb;padding:7px 16px;font-size:0.88rem}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:9px 11px;border-bottom:1px solid #1e1e1e;font-size:0.86rem;vertical-align:middle}
    th{color:#444;font-weight:500;font-size:0.74rem;text-transform:uppercase;letter-spacing:.05em}
    .badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:0.72rem;font-weight:500}
    .badge.running{background:#14532d;color:#4ade80}
    .badge.stopped{background:#1c1917;color:#78716c}
    .badge.error{background:#450a0a;color:#f87171}
    .badge.starting{background:#1c1917;color:#a8a29e}
    a{color:#60a5fa;text-decoration:none}
    .copy-btn{background:none;border:none;cursor:pointer;color:#444;padding:2px 5px;border-radius:3px;font-size:0.75rem}
    .copy-btn:hover{color:#93c5fd;background:#1a1a1a}
    .actions{display:flex;gap:5px;align-items:center}
    /* Modal */
    #mgr{display:none;position:fixed;inset:0;z-index:999;flex-direction:column;background:#0a0a0a}
    #mgr.open{display:flex}
    #mgr-bar{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid #1a1a1a;background:#111;flex-shrink:0}
    #mgr-tabs{display:flex;gap:0;border-bottom:1px solid #1a1a1a;flex-shrink:0;background:#111}
    .tab{padding:6px 18px;font-size:0.8rem;cursor:pointer;color:#555;border-bottom:2px solid transparent}
    .tab.active{color:#93c5fd;border-bottom-color:#2563eb}
    #mgr-body{display:flex;flex:1;overflow:hidden}
    #mgr-tree{width:250px;flex-shrink:0;overflow-y:auto;border-right:1px solid #161616;font-size:0.78rem;font-family:monospace;padding:4px 0}
    #mgr-right{flex:1;display:flex;flex-direction:column;overflow:hidden}
    #mgr-crumb{padding:4px 14px;font-size:0.72rem;color:#3a3a3a;font-family:monospace;background:#0e0e0e;border-bottom:1px solid #161616;flex-shrink:0}
    #mgr-editor{flex:1;background:#0a0a0a;color:#c9d1d9;border:none;outline:none;resize:none;padding:14px 18px;font-family:'Fira Code',Consolas,monospace;font-size:13px;line-height:1.65;tab-size:2}
    #mgr-logs{flex:1;background:#0a0a0a;color:#7d8590;overflow-y:auto;padding:12px 16px;font-family:monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;display:none}
    #mgr-exec{flex:1;display:none;flex-direction:column;overflow:hidden}
    #exec-output{flex:1;background:#0a0a0a;color:#7d8590;overflow-y:auto;padding:12px 16px;font-family:monospace;font-size:12px;line-height:1.5;white-space:pre-wrap}
    #exec-input-row{display:flex;gap:6px;padding:7px 14px;border-top:1px solid #161616;background:#0e0e0e;flex-shrink:0}
    #exec-cmd{flex:1;background:#0f0f0f;border:1px solid #2e2e2e;color:#e5e5e5;padding:6px 10px;border-radius:5px;font-size:0.85rem;font-family:monospace}
    #exec-run{background:#15803d;border:none;color:#fff;padding:6px 14px;border-radius:5px;cursor:pointer;font-size:0.82rem}
    #exec-run:disabled{opacity:.4;cursor:default}
    #mgr-footer{display:flex;align-items:center;gap:8px;padding:7px 14px;border-top:1px solid #161616;background:#0e0e0e;flex-shrink:0}
    .tree-row{display:flex;align-items:center;padding:2px 8px;cursor:pointer;border-radius:3px;user-select:none;gap:5px}
    .tree-row:hover{background:#161616}
    .tree-row.active{background:#1e3448;color:#93c5fd}
    .tree-arrow{font-size:8px;color:#3a3a3a;transition:transform .12s;flex-shrink:0}
    .tree-arrow.open{transform:rotate(90deg)}
    .tree-icon{font-size:11px;flex-shrink:0}
    .tree-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#777}
    .tree-row:hover .tree-name{color:#ccc}
    .tree-row.active .tree-name{color:#93c5fd}
    .tree-children{padding-left:14px;display:none}
    .tree-children.open{display:block}
  </style>
</head>
<body>
  <h1>ClawStack</h1>

  <div class="card">
    <h2>New instance</h2>
    <form method="post" action="/admin/instances">
      <div class="grid">
        <div><label>Name</label><input name="name" placeholder="acme" required></div>
        <div>
          <label>Domain</label>
          <input name="domain" id="domain-input" placeholder="ai.acme.com" required oninput="onDomainInput(this)">
          <div id="cname-notice" style="display:none;margin-top:5px;padding:6px 10px;background:#1a1200;border:1px solid #3d2e00;border-radius:4px;font-size:0.76rem;color:#ca8a04;line-height:1.4">
            Set a CNAME record: <code id="cname-domain" style="color:#fbbf24;background:#111;padding:1px 5px;border-radius:3px"></code> → <code style="color:#fbbf24;background:#111;padding:1px 5px;border-radius:3px">${BASE_DOMAIN || 'this-server'}</code>
          </div>
        </div>
        <div>
          <label>Provider</label>
          <select name="provider" id="provider" onchange="onProviderChange(this)">
            ${PROVIDERS.map(p => `<option value="${p}">${p === 'private' ? 'Private LLM (self-hosted)' : p}</option>`).join('')}
          </select>
        </div>
        <div><label>Model</label><input name="model" id="model" value="${MODEL_PRESETS.openrouter}" required></div>
        <div class="full" id="baseurl-row" style="display:none"><label>Base URL</label><input name="baseUrl" id="baseUrl" type="url" placeholder="http://localhost:11434/v1" autocomplete="off"></div>
        <div class="full" id="apikey-row"><label>API Key</label><input name="apiKey" id="apiKey" type="password" placeholder="sk-... (optional for private)" autocomplete="off"></div>
        <div class="full" style="margin-top:6px"><button type="submit" class="btn primary">Create instance</button></div>
      </div>
    </form>
  </div>

  <div class="card">
    <h2>Instances</h2>
    ${instances.length === 0 ? '<p style="color:#444;font-size:0.88rem">No instances yet.</p>' : `
    <table>
      <thead><tr><th>Name</th><th>Domain</th><th>Token</th><th>Status</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${instances.map(i => `
          <tr>
            <td><strong style="color:#e2e8f0">${i.name}</strong><div style="font-size:0.72rem;color:#444;margin-top:2px">${i.provider} · ${i.model}</div></td>
            <td><a href="https://${i.domain}" target="_blank">${i.domain}</a></td>
            <td>
              <div style="display:flex;align-items:center;gap:4px">
                <code id="tok-${i.name}" style="font-size:0.7rem;color:#3a3a3a;cursor:pointer" title="Click to copy">${i.token.slice(0,20)}…</code>
                <button class="copy-btn" onclick="copyToken('${i.token}','${i.name}')" title="Copy full token">⎘</button>
              </div>
            </td>
            <td><span class="badge ${i.status}" id="badge-${i.name}">${i.status}</span></td>
            <td style="color:#444;font-size:0.8rem">${new Date(i.created_at).toLocaleDateString()}</td>
            <td>
              <div class="actions">
                <button class="btn ghost sm" onclick="openMgr('${i.name}','files')">Files</button>
                <button class="btn ghost sm" onclick="openMgr('${i.name}','logs')">Logs</button>
                <button class="btn amber sm" onclick="rowAction('${i.name}','restart')">↺</button>
                <button class="btn ghost sm" id="stopstart-${i.name}" onclick="rowAction('${i.name}','${i.status === 'running' ? 'stop' : 'start'}')">${i.status === 'running' ? '■' : '▶'}</button>
                <form method="post" action="/admin/instances/${i.name}/delete" style="margin:0">
                  <button type="submit" class="btn danger sm" onclick="return confirm('Delete ${i.name}?')">✕</button>
                </form>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`}
  </div>

  <!-- ===== Manager Modal ===== -->
  <div id="mgr">
    <div id="mgr-bar">
      <button class="btn ghost sm" id="btn-close" onclick="closeMgr()">← Back</button>
      <span id="mgr-title" style="font-weight:600;color:#e2e8f0;font-size:0.9rem"></span>
      <span id="mgr-badge" class="badge" style="margin-left:4px"></span>
      <div style="flex:1"></div>
      <button class="btn amber sm" onclick="mgrAction('restart')">Restart</button>
      <button class="btn danger sm" id="btn-stop"  onclick="mgrAction('stop')">Stop</button>
      <button class="btn green sm"  id="btn-start" onclick="mgrAction('start')">Start</button>
      <span id="mgr-action-status" style="font-size:0.75rem;color:#555;min-width:60px;text-align:right"></span>
    </div>
    <div id="mgr-tabs">
      <div class="tab active" id="tab-files" onclick="switchTab('files')">Files</div>
      <div class="tab"        id="tab-logs"  onclick="switchTab('logs')">Logs</div>
      <div class="tab"        id="tab-exec"  onclick="switchTab('exec')">Exec (root)</div>
    </div>
    <div id="mgr-body">
      <div id="mgr-tree"></div>
      <div id="mgr-right">
        <div id="mgr-crumb">—</div>
        <textarea id="mgr-editor" spellcheck="false" placeholder="Select a file from the tree to edit it here…"></textarea>
        <pre id="mgr-logs"></pre>
        <div id="mgr-exec">
          <div id="exec-output"># Root exec — runs as root inside the container\n# Use this to install packages, fix permissions, inspect the system, etc.\n</div>
          <div id="exec-input-row">
            <input id="exec-cmd" placeholder="e.g. apt-get install -y curl" autocomplete="off" spellcheck="false">
            <button id="exec-run" onclick="runExec()">Run</button>
          </div>
        </div>
        <div id="mgr-footer">
          <button id="btn-save" class="btn sm" onclick="saveFile()" disabled>Save</button>
          <button id="btn-refresh-logs" class="btn ghost sm" style="display:none" onclick="loadLogs()">↻ Refresh</button>
          <span id="mgr-status" style="font-size:0.78rem;color:#555"></span>
        </div>
      </div>
    </div>
  </div>

  <script>
    const presets   = ${JSON.stringify(MODEL_PRESETS)};
    const noKeyProviders = ${JSON.stringify([...NO_KEY_PROVIDERS])};
    const __auth    = ${authHeader};

    function onProviderChange(s){
      const m=document.getElementById('model');
      if(presets[s.value]) m.value=presets[s.value];
      const isPrivate=s.value==='private';
      document.getElementById('baseurl-row').style.display=isPrivate?'':'none';
      document.getElementById('baseUrl').required=isPrivate;
      const keyInp=document.getElementById('apiKey');
      keyInp.placeholder=isPrivate?'optional — leave blank if not required':'sk-...';
      keyInp.required=!isPrivate;
    }

    function onDomainInput(inp){
      const v=inp.value.trim();
      const notice=document.getElementById('cname-notice');
      const label=document.getElementById('cname-domain');
      if(v&&v.includes('.')){notice.style.display='';label.textContent=v;}
      else{notice.style.display='none';}
    }

    async function api(method, url, body){
      const opts={method,headers:{Authorization:__auth}};
      if(body!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}
      const r=await fetch(url,opts);
      return r.json().catch(()=>({error:'bad response'}));
    }

    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

    // ── Copy token ──
    function copyToken(token, name){
      navigator.clipboard.writeText(token).then(()=>{
        const el=document.getElementById('tok-'+name);
        const prev=el.textContent;
        el.textContent='Copied!';el.style.color='#4ade80';
        setTimeout(()=>{el.textContent=prev;el.style.color='';},1500);
      });
    }

    // ── Row quick actions ──
    async function rowAction(name, action){
      const badge=document.getElementById('badge-'+name);
      const btn=document.getElementById('stopstart-'+name);
      if(badge){badge.textContent='…';badge.className='badge starting';}
      await api('POST','/api/instances/'+name+'/action',{action});
      const d=await api('GET','/api/instances/'+name+'/status');
      if(badge){badge.textContent=d.status;badge.className='badge '+(d.status||'error');}
      if(btn){btn.textContent=d.status==='running'?'■':'▶';btn.onclick=()=>rowAction(name,d.status==='running'?'stop':'start');}
    }

    // ── Status polling ──
    async function pollStatus(){
      document.querySelectorAll('[id^="badge-"]').forEach(async el=>{
        const name=el.id.slice(6);
        const d=await api('GET','/api/instances/'+name+'/status').catch(()=>({}));
        if(d.status){el.textContent=d.status;el.className='badge '+(d.status||'error');}
      });
    }
    setInterval(pollStatus,15000);

    // ── Manager modal ──
    let mgrName=null, mgrPath=null, mgrTab='files';

    function openMgr(name,tab='files'){
      mgrName=name;mgrPath=null;
      document.getElementById('mgr-title').textContent=name;
      document.getElementById('mgr-editor').value='';
      document.getElementById('btn-save').disabled=true;
      document.getElementById('mgr-status').textContent='';
      document.getElementById('mgr').classList.add('open');
      refreshMgrBadge();
      switchTab(tab);
    }
    function closeMgr(){document.getElementById('mgr').classList.remove('open');mgrName=null;}

    async function refreshMgrBadge(){
      const d=await api('GET','/api/instances/'+mgrName+'/status');
      const b=document.getElementById('mgr-badge');
      b.textContent=d.status||'?';b.className='badge '+(d.status||'error');
    }

    function switchTab(tab){
      mgrTab=tab;
      document.getElementById('tab-files').className='tab'+(tab==='files'?' active':'');
      document.getElementById('tab-logs').className='tab'+(tab==='logs'?' active':'');
      document.getElementById('tab-exec').className='tab'+(tab==='exec'?' active':'');
      document.getElementById('mgr-editor').style.display=tab==='files'?'':'none';
      document.getElementById('mgr-logs').style.display=tab==='logs'?'block':'none';
      document.getElementById('mgr-exec').style.display=tab==='exec'?'flex':'none';
      document.getElementById('btn-save').style.display=tab==='files'?'':'none';
      document.getElementById('btn-refresh-logs').style.display=tab==='logs'?'':'none';
      document.getElementById('mgr-tree').style.display=tab==='files'?'':'none';
      if(tab==='files'){
        if(!document.getElementById('mgr-tree').children.length) loadTree('');
        document.getElementById('mgr-crumb').textContent=mgrPath||'Select a file';
      } else if(tab==='logs'){
        document.getElementById('mgr-crumb').textContent='Container logs (last 300 lines)';
        loadLogs();
      } else {
        document.getElementById('mgr-crumb').textContent='Root shell (docker exec --user root)';
      }
    }

    // ── File tree (event delegation — no inline onclick) ──
    const tree=document.getElementById('mgr-tree');
    tree.addEventListener('click',async e=>{
      const row=e.target.closest('.tree-row');
      if(!row) return;
      if(row.dataset.type==='file'){
        tree.querySelectorAll('.tree-row').forEach(r=>r.classList.remove('active'));
        row.classList.add('active');
        loadFile(row.dataset.path);
      } else {
        const arrow=row.querySelector('.tree-arrow');
        const children=row.nextElementSibling;
        const opening=!children.classList.contains('open');
        if(arrow) arrow.classList.toggle('open',opening);
        children.classList.toggle('open',opening);
        if(opening && children.children.length===0){
          children.innerHTML='<div style="padding:3px 8px;color:#333">Loading…</div>';
          const d=await api('GET','/api/instances/'+mgrName+'/files?path='+encodeURIComponent(row.dataset.path));
          children.innerHTML=d.error?'<div style="padding:3px 8px;color:#f87171">'+esc(d.error)+'</div>':buildTree(d.entries,row.dataset.path);
        }
      }
    });

    async function loadTree(dirPath){
      tree.innerHTML='<div style="padding:6px 8px;color:#333">Loading…</div>';
      const d=await api('GET','/api/instances/'+mgrName+'/files?path='+encodeURIComponent(dirPath));
      tree.innerHTML=d.error?'<div style="padding:6px 8px;color:#f87171">'+esc(d.error)+'</div>':buildTree(d.entries,dirPath);
    }

    function buildTree(entries,parent){
      return entries.map(e=>{
        const p=parent?parent+'/'+e.name:e.name;
        if(e.type==='dir') return \`
          <div class="tree-row" data-type="dir" data-path="\${esc(p)}">
            <span class="tree-arrow">▶</span>
            <span class="tree-icon" style="color:#6b7280">📁</span>
            <span class="tree-name">\${esc(e.name)}</span>
          </div>
          <div class="tree-children"></div>\`;
        const icon=p.endsWith('.json')?'{}':p.endsWith('.md')?'📝':p.endsWith('.log')||p.endsWith('.jsonl')?'📋':'📄';
        return \`<div class="tree-row" data-type="file" data-path="\${esc(p)}">
          <span class="tree-arrow" style="visibility:hidden">▶</span>
          <span class="tree-icon" style="color:#4b5563">\${icon}</span>
          <span class="tree-name">\${esc(e.name)}</span>
        </div>\`;
      }).join('');
    }

    async function loadFile(path){
      document.getElementById('mgr-crumb').textContent=path;
      document.getElementById('mgr-status').textContent='Loading…';
      document.getElementById('btn-save').disabled=true;
      const d=await api('GET','/api/instances/'+mgrName+'/files?path='+encodeURIComponent(path));
      if(d.error){document.getElementById('mgr-status').textContent=d.error;return;}
      mgrPath=path;
      document.getElementById('mgr-editor').value=d.content;
      document.getElementById('mgr-status').textContent='';
      document.getElementById('btn-save').disabled=false;
    }

    async function saveFile(){
      if(!mgrPath) return;
      const content=document.getElementById('mgr-editor').value;
      // Validate JSON if .json file
      if(mgrPath.endsWith('.json')&&!mgrPath.endsWith('.jsonl')){
        try{JSON.parse(content);}catch(e){document.getElementById('mgr-status').textContent='Invalid JSON: '+e.message;return;}
      }
      document.getElementById('mgr-status').textContent='Saving…';
      document.getElementById('btn-save').disabled=true;
      const d=await api('POST','/api/instances/'+mgrName+'/files',{path:mgrPath,content});
      document.getElementById('btn-save').disabled=false;
      document.getElementById('mgr-status').textContent=d.success?'Saved ✓':('Error: '+d.error);
      if(d.success) setTimeout(()=>document.getElementById('mgr-status').textContent='',2500);
    }

    async function loadLogs(){
      const el=document.getElementById('mgr-logs');
      el.textContent='Loading…';
      const d=await api('GET','/api/instances/'+mgrName+'/logs');
      el.textContent=d.error?('Error: '+d.error):(d.logs||'(no logs)');
      el.scrollTop=el.scrollHeight;
    }

    // ── Exec tab ──
    const execHistory=[];
    let execHistIdx=-1;
    document.addEventListener('DOMContentLoaded',()=>{
      document.getElementById('exec-cmd').addEventListener('keydown',e=>{
        if(e.key==='Enter'){runExec();return;}
        if(e.key==='ArrowUp'){e.preventDefault();if(execHistIdx<execHistory.length-1){execHistIdx++;e.target.value=execHistory[execHistory.length-1-execHistIdx]||'';}}
        if(e.key==='ArrowDown'){e.preventDefault();if(execHistIdx>0){execHistIdx--;e.target.value=execHistory[execHistory.length-1-execHistIdx]||'';}else{execHistIdx=-1;e.target.value='';}}
      });
    });

    async function runExec(){
      const inp=document.getElementById('exec-cmd');
      const out=document.getElementById('exec-output');
      const btn=document.getElementById('exec-run');
      const cmd=inp.value.trim();
      if(!cmd) return;
      execHistory.push(cmd); execHistIdx=-1;
      inp.value='';
      btn.disabled=true;
      out.textContent+='\\n$ '+cmd+'\\n';
      out.scrollTop=out.scrollHeight;
      const d=await api('POST','/api/instances/'+mgrName+'/exec',{cmd});
      if(d.error){ out.textContent+='[error] '+d.error+'\\n'; }
      else {
        out.textContent+=(d.output||'(no output)');
        if(d.exitCode!==0) out.textContent+='[exit '+d.exitCode+']\\n';
      }
      out.scrollTop=out.scrollHeight;
      btn.disabled=false;
      inp.focus();
    }

    async function mgrAction(action){
      const s=document.getElementById('mgr-action-status');
      s.textContent=action+'…';
      await api('POST','/api/instances/'+mgrName+'/action',{action});
      await refreshMgrBadge();
      s.textContent='Done';
      setTimeout(()=>s.textContent='',2500);
    }

    // Tab key inserts 2 spaces
    document.getElementById('mgr-editor').addEventListener('keydown',e=>{
      if(e.key!=='Tab') return;
      e.preventDefault();
      const t=e.target,s=t.selectionStart,end=t.selectionEnd;
      t.value=t.value.slice(0,s)+'  '+t.value.slice(end);
      t.selectionStart=t.selectionEnd=s+2;
    });
  </script>
</body>
</html>`);
});

// Form handlers
app.post('/admin/instances', requireAdmin, async (req, res) => {
  const auth = req.headers.authorization;
  const r = await fetch('http://localhost:3000/api/instances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': auth },
    body: JSON.stringify(req.body)
  });
  const data = await r.json();
  if (!r.ok) return res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;background:#0f0f0f;color:#e5e5e5"><p>Error: ${data.error}</p><a href="/" style="color:#60a5fa">Back</a></body></html>`);
  res.redirect('/');
});

app.post('/admin/instances/:name/delete', requireAdmin, async (req, res) => {
  await fetch(`http://localhost:3000/api/instances/${req.params.name}`, {
    method: 'DELETE',
    headers: { 'Authorization': req.headers.authorization }
  });
  res.redirect('/');
});


const server = app.listen(3000, () => console.log(`ClawStack portal running on :3000`));

// WebSocket upgrade handler — required for OpenClaw's WS connections
server.on('upgrade', (req, socket, head) => {
  const host = req.headers.host?.split(':')[0];
  if (!host || host === BASE_DOMAIN) return socket.destroy();
  const row = db.prepare('SELECT container_name FROM instances WHERE domain = ?').get(host);
  if (!row) return socket.destroy();
  getProxy(row.container_name).upgrade(req, socket, head);
});
