const express = require('express');
const Docker = require('dockerode');
const Database = require('better-sqlite3');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
// Migration: add role column if missing
try { db.exec(`ALTER TABLE instances ADD COLUMN role TEXT DEFAULT 'generalist'`); } catch {}
// Migration: add image column if missing
try { db.exec(`ALTER TABLE instances ADD COLUMN image TEXT`); } catch {}
// Paperclip pending connections state
db.exec(`CREATE TABLE IF NOT EXISTS paperclip_pending (
  claw_name    TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL,
  claim_secret TEXT NOT NULL,
  gw_token     TEXT NOT NULL,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
)`);

// --- Shared helper: exec a shell command in any container ---
async function containerExec(containerName, cmd, user = 'root', timeoutMs = 30000) {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true, User: user });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', d => chunks.push(d));
    stream.on('end', resolve);
    stream.on('error', reject);
    setTimeout(resolve, timeoutMs);
  });
  const buf = Buffer.concat(chunks);
  let offset = 0, lines = [];
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    lines.push(buf.slice(offset, offset + size).toString('utf8'));
    offset += size;
  }
  const output = (lines.join('') || buf.toString('utf8')).trim();
  const info = await exec.inspect();
  return { output, exitCode: info.ExitCode };
}

// --- Shared helper: internal HTTP JSON request ---
function httpJSON(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, port: u.port || 3100, path: u.pathname + (u.search || ''),
      method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    };
    const req = require('http').request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const PAPERCLIP_URL = 'http://paperclip:3100';
const PAPERCLIP_CONTAINER = 'clawstack-paperclip-1';
const PAPERCLIP_DB = 'clawstack-paperclip-db-1';

// --- Reverse proxy: MUST be first — routes customer domains before any admin middleware ---
const proxyCache = {};
function getProxy(containerName, port = 18789) {
  const key = `${containerName}:${port}`;
  if (!proxyCache[key]) {
    proxyCache[key] = createProxyMiddleware({
      target: `http://${containerName}:${port}`,
      changeOrigin: false,
    });
  }
  return proxyCache[key];
}

app.use((req, res, next) => {
  const host = req.hostname;
  if (!host || host === BASE_DOMAIN) return next();
  const row = db.prepare('SELECT container_name FROM instances WHERE domain = ?').get(host);
  if (!row) return next(); // unknown host — let normal routes handle it (e.g. Caddy's internal /api/verify-domain call)
  // A2A traffic goes to port 18800, everything else to 18789
  const isA2A = req.path.startsWith('/a2a/') || req.path === '/.well-known/agent.json';
  getProxy(row.container_name, isA2A ? 18800 : 18789)(req, res, next);
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

// --- Claw defaults (admin-editable, persisted in portal_data volume) ---
const CLAW_DEFAULTS_FILE = '/data/claw-defaults.json';
const BASELINE_CLAW_DEFAULTS = {
  agents: {
    defaults: {
      maxConcurrent: 4,
      subagents: { maxConcurrent: 8 },
      compaction: {
        mode: 'default',
        reserveTokensFloor: 40000,
      },
      contextPruning: {
        mode: 'cache-ttl',
        ttl: '45m',
        keepLastAssistants: 2,
        minPrunableToolChars: 12000,
        hardClear: { enabled: true, placeholder: '[Old tool result cleared]' },
      },
    }
  },
  browser: { enabled: true, headless: true, noSandbox: true },
  session: { dmScope: 'per-channel-peer' },
};

function loadClawDefaults() {
  try { return JSON.parse(fs.readFileSync(CLAW_DEFAULTS_FILE, 'utf8')); } catch { return BASELINE_CLAW_DEFAULTS; }
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k]))
      out[k] = deepMerge(base[k], v);
    else
      out[k] = v;
  }
  return out;
}

app.get('/api/system/claw-defaults', requireAdmin, (req, res) => {
  res.json({ content: JSON.stringify(loadClawDefaults(), null, 2) });
});

app.post('/api/system/claw-defaults', requireAdmin, (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    JSON.parse(content); // validate
    fs.writeFileSync(CLAW_DEFAULTS_FILE, content, 'utf8');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Bootstrap: write OpenClaw config files before container starts ---
function bootstrapInstance({ name, domain, provider, apiKey, model, token, baseUrl, enableA2A, role, allowAll }) {
  const configDir = path.join(INSTANCES_DIR, name, 'config');
  const agentDir = path.join(configDir, 'agents', 'main', 'agent');
  const sessionsDir = path.join(configDir, 'agents', 'main', 'sessions');
  const workspaceDir = path.join(INSTANCES_DIR, name, 'workspace');

  const dirs = [agentDir, sessionsDir,
    path.join(configDir, 'devices'),
    path.join(configDir, 'logs'),
    path.join(configDir, 'canvas'),
    workspaceDir,
  ];
  dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));
  // OpenClaw runs as uid 1000 — ensure it can write
  dirs.concat([configDir]).forEach(d => fs.chownSync(d, 1000, 1000));

  // --- Workspace files ---
  const preset = AGENT_ROLES[role] || AGENT_ROLES.generalist;
  const agentName = name.charAt(0).toUpperCase() + name.slice(1);

  // Role-specific workspace files — generalist gets nothing, OpenClaw handles its own onboarding
  if (preset.identity) {
    fs.writeFileSync(path.join(workspaceDir, 'IDENTITY.md'), preset.identity.replace(/\$\{\'name\'\}/g, agentName));
    fs.writeFileSync(path.join(workspaceDir, 'USER.md'), `# USER.md\n\nAdd details about yourself here — your name, timezone, how you like to communicate, and anything the agent should know about you.\n`);
    fs.writeFileSync(path.join(workspaceDir, 'MEMORY.md'), `# MEMORY.md\n\nLong-term memory lives here. The agent updates this file to remember things between sessions.\n`);
    fs.writeFileSync(path.join(workspaceDir, 'HEARTBEAT.md'), `# HEARTBEAT.md\n\nAdd periodic tasks here — things the agent should check or do on a schedule.\n`);
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), `# AGENTS.md\n\nSession startup checklist:\n1. Read SOUL.md\n2. Read USER.md\n3. Read MEMORY.md\n4. You are ready.\n`);
  }
  if (preset.soul) {
    fs.writeFileSync(path.join(workspaceDir, 'SOUL.md'), preset.soul);
  }
  if (preset.tools) {
    fs.writeFileSync(path.join(workspaceDir, 'TOOLS.md'), preset.tools);
  }

  // Chown workspace dir and all files written into it
  fs.readdirSync(workspaceDir).forEach(f =>
    fs.chownSync(path.join(workspaceDir, f), 1000, 1000)
  );
  fs.chownSync(workspaceDir, 1000, 1000);

  // model reference format: "{provider}/{modelId}"
  // modelId is the part after provider prefix if present, otherwise the full model string
  const modelId = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  const fullModelRef = `${provider}/${modelId}`;

  // Provider base URL and API type (baseUrl arg overrides for private provider)
  const providerConf = PROVIDER_CONFIGS[provider] || { baseUrl: '', api: 'openai-completions' };
  if (baseUrl) providerConf.baseUrl = baseUrl;

  // 1. openclaw.json — merge admin defaults with instance-specific config
  const instanceConfig = {
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
      defaults: { model: { primary: fullModelRef } }
    },
    tools: {
      exec: { ask: allowAll ? 'off' : 'always' }
    },
    gateway: {
      mode: 'local',
      bind: 'lan',
      remote: { url: `https://${domain}` },
      auth: { token: token },
      trustedProxies: '172.16.0.0/12',
      http: { endpoints: { responses: { enabled: true } } },
      controlUi: {
        allowedOrigins: ['http://localhost:18789', `https://${domain}`],
        dangerouslyDisableDeviceAuth: true
      }
    },
    ...(enableA2A ? {
      plugins: {
        entries: {
          'a2a-gateway': {
            enabled: true,
            config: {
              server: { host: '0.0.0.0' },
              agentCard: {
                url: `https://${domain}/a2a/jsonrpc`,
                ...(preset.a2aSkills.length > 0 ? { skills: preset.a2aSkills } : {}),
              },
              routing: { defaultAgentId: 'main' },
            }
          }
        }
      }
    } : {}),
  };
  const merged = deepMerge(loadClawDefaults(), instanceConfig);
  fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify(merged, null, 2));
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
  const rows = db.prepare('SELECT id, name, domain, container_name, provider, model, status, image, created_at FROM instances ORDER BY created_at DESC').all();
  rows.forEach(row => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, row.name, 'config', 'openclaw.json'), 'utf8'));
      const agents = cfg?.agents?.defaults?.model?.primary || cfg?.agents?.list?.[0]?.model;
      row.liveModel = agents || null;
    } catch { row.liveModel = null; }
  });
  res.json(rows);
});

app.post('/api/instances', requireAdmin, async (req, res) => {
  const { name, domain, provider, model, baseUrl, enableA2A, role, image, allowAll } = req.body;
  const apiKey = NO_KEY_PROVIDERS.has(provider) ? (req.body.apiKey || 'none') : req.body.apiKey;
  if (!name || !domain || !provider || !model || (!NO_KEY_PROVIDERS.has(provider) && !apiKey))
    return res.status(400).json({ error: 'name, domain, provider, model required (and apiKey for this provider)' });
  if (provider === 'private' && !baseUrl)
    return res.status(400).json({ error: 'baseUrl required for Private LLM provider' });

  const containerName = `clawstack-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const token = crypto.randomBytes(32).toString('hex');
  const instanceImage = (image || OPENCLAW_IMAGE).trim();

  try {
    db.prepare('INSERT INTO instances (name, domain, container_name, token, provider, model, role, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, domain.toLowerCase(), containerName, token, provider, model, role || 'generalist', instanceImage);
  } catch (e) {
    return res.status(400).json({ error: 'name or domain already exists' });
  }

  try {
    bootstrapInstance({ name, domain, provider, apiKey, model, token, baseUrl, enableA2A: !!enableA2A, role: role || 'generalist', allowAll: !!allowAll });
  } catch (e) {
    db.prepare('DELETE FROM instances WHERE name = ?').run(name);
    return res.status(500).json({ error: `Bootstrap failed: ${e.message}` });
  }

  try {
    const container = await docker.createContainer({
      name: containerName,
      Image: instanceImage,
      Env: [
        `OPENCLAW_GATEWAY_TOKEN=${token}`,
        `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=true`,
        `OPENCLAW_PROVIDER_API_KEY=${apiKey}`,
        `TZ=${process.env.TZ || 'Europe/Stockholm'}`,
      ],
      HostConfig: {
        NetworkMode: 'clawstack',
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: 1536 * 1024 * 1024,       // 1.5 GB hard limit
        MemorySwap: 2048 * 1024 * 1024,  // 2 GB incl. swap
        CpuQuota: 150000,                 // 1.5 CPUs max (period=100000)
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

// --- Recreate container with a new image ---
app.post('/api/instances/:name/recreate', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });

  const newImage = (req.body.image || row.image || OPENCLAW_IMAGE).trim();

  // Grab API key from existing container env before stopping
  let apiKey = '';
  try {
    const info = await docker.getContainer(row.container_name).inspect();
    const envEntry = (info.Config.Env || []).find(e => e.startsWith('OPENCLAW_PROVIDER_API_KEY='));
    if (envEntry) apiKey = envEntry.slice('OPENCLAW_PROVIDER_API_KEY='.length);
  } catch { /* container may already be gone */ }

  // Stop and remove old container
  try {
    const c = docker.getContainer(row.container_name);
    await c.stop().catch(() => {});
    await c.remove().catch(() => {});
  } catch { /* already gone */ }

  // Pull new image
  try {
    await new Promise((resolve, reject) => {
      docker.pull(newImage, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, err => err ? reject(err) : resolve());
      });
    });
  } catch (e) {
    return res.status(500).json({ error: `Pull failed: ${e.message}` });
  }

  // Update DB
  db.prepare('UPDATE instances SET image = ?, status = ? WHERE name = ?').run(newImage, 'starting', row.name);

  // Recreate and start container
  try {
    const container = await docker.createContainer({
      name: row.container_name,
      Image: newImage,
      Env: [
        `OPENCLAW_GATEWAY_TOKEN=${row.token}`,
        `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=true`,
        `OPENCLAW_PROVIDER_API_KEY=${apiKey}`,
        `TZ=${process.env.TZ || 'Europe/Stockholm'}`,
      ],
      HostConfig: {
        NetworkMode: 'clawstack',
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: 1536 * 1024 * 1024,
        MemorySwap: 2048 * 1024 * 1024,
        CpuQuota: 150000,
        Binds: [
          `${INSTANCES_HOST_DIR}/${row.name}/config:/home/node/.openclaw`,
          `${INSTANCES_HOST_DIR}/${row.name}/workspace:/home/node/.openclaw/workspace`,
        ],
      },
    });
    await container.start();
    db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('running', row.name);
    res.json({ success: true, image: newImage });
  } catch (e) {
    db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('error', row.name);
    res.status(500).json({ error: e.message });
  }
});

// --- File Management API ---
function resolveInstancePath(instanceName, relPath) {
  const base = path.join(INSTANCES_DIR, instanceName);
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
        .filter(e => !e.name.includes('.clobbered.'))
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

// --- Backup / Restore ---
app.get('/api/instances/:name/backup', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT id FROM instances WHERE name = ?').get(req.params.name))
    return res.status(404).json({ error: 'not found' });
  const dir = path.join(INSTANCES_DIR, req.params.name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'instance directory not found' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}-backup.tar.gz"`);
  const tar = require('child_process').spawn('tar', ['czf', '-', '-C', path.dirname(dir), path.basename(dir)]);
  tar.stdout.pipe(res);
  tar.stderr.on('data', d => console.error('backup tar:', d.toString()));
  tar.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
});

app.post('/api/instances/:name/restore', requireAdmin, express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
  const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'no file uploaded' });
  const dir = path.join(INSTANCES_DIR, req.params.name);
  const tmpFile = path.join('/tmp', `${req.params.name}-restore.tar.gz`);
  try {
    fs.writeFileSync(tmpFile, req.body);
    const container = docker.getContainer(row.container_name);
    await container.stop().catch(() => {});
    // Wipe and re-extract
    const { execFileSync } = require('child_process');
    execFileSync('rm', ['-rf', path.join(dir, 'config'), path.join(dir, 'workspace')]);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['xzf', tmpFile, '--strip-components=1', '-C', dir]);
    execFileSync('chown', ['-R', '1000:1000', dir]);
    await container.start();
    db.prepare('UPDATE instances SET status = ? WHERE container_name = ?').run('running', row.container_name);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
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

// --- CLI API (runs as node/uid 1000 — for openclaw CLI commands) ---
app.post('/api/instances/:name/cli', requireAdmin, async (req, res) => {
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
      User: 'node',
      Env: ['HOME=/home/node'],
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data', d => chunks.push(d));
      stream.on('end', resolve);
      stream.on('error', reject);
      setTimeout(resolve, 60000); // 60s — installs can take a while
    });
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
app.get('/api/instances/:name/model', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT name FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, req.params.name, 'config', 'openclaw.json'), 'utf8'));
    const primary = cfg?.agents?.defaults?.model?.primary || '';
    const providers = cfg?.models?.providers || {};
    const providerKey = Object.keys(providers)[0] || '';
    const providerCfg = providers[providerKey] || {};
    const apiKey = providerCfg.apiKey || '';
    res.json({
      provider: providerKey,
      model: primary.includes('/') ? primary.split('/').slice(1).join('/') : primary,
      baseUrl: providerCfg.baseUrl || '',
      hasApiKey: !!apiKey && !apiKey.startsWith('${'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/instances/:name/model', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT name, container_name FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { provider, model, apiKey, baseUrl } = req.body;
  if (!provider || !model) return res.status(400).json({ error: 'provider and model required' });
  try {
    const cfgPath = path.join(INSTANCES_DIR, req.params.name, 'config', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const providerConf = PROVIDER_CONFIGS[provider] || { baseUrl: baseUrl || '', api: 'openai-completions' };
    if (baseUrl) providerConf.baseUrl = baseUrl;
    // Replace provider config (keep only the new provider)
    cfg.models = cfg.models || {};
    cfg.models.providers = {
      [provider]: {
        ...providerConf,
        apiKey: apiKey || cfg.models?.providers?.[provider]?.apiKey || '${OPENCLAW_PROVIDER_API_KEY}',
        models: [{ id: model, name: model }],
      }
    };
    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = cfg.agents.defaults || {};
    cfg.agents.defaults.model = { primary: `${provider}/${model}` };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    fs.chownSync(cfgPath, 1000, 1000);
    // Restart container
    const container = docker.getContainer(row.container_name);
    await container.restart();
    db.prepare('UPDATE instances SET provider = ?, model = ? WHERE name = ?').run(provider, model, row.name);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Chat proxy (streams SSE from OpenClaw /v1/responses) ---
app.post('/api/instances/:name/chat', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT container_name, token FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  const body = Buffer.from(JSON.stringify({ model: 'openclaw', input: messages, stream: true }));
  const opts = {
    hostname: row.container_name,
    port: 18789,
    path: '/v1/responses',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${row.token}`,
      'Content-Length': body.length,
    },
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const proxyReq = require('http').request(opts, proxyRes => {
    proxyRes.on('data', chunk => res.write(chunk));
    proxyRes.on('end', () => res.end());
  });
  proxyReq.on('error', err => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  });
  proxyReq.write(body);
  proxyReq.end();
});


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

// --- System stats ---
function readProcStat() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const vals = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = vals[3] + (vals[4] || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  return { idle, total };
}

app.get('/api/system', requireAdmin, async (req, res) => {
  // CPU — two samples 300ms apart
  const t1 = readProcStat();
  await new Promise(r => setTimeout(r, 300));
  const t2 = readProcStat();
  const idleDelta = t2.idle - t1.idle;
  const totalDelta = t2.total - t1.total;
  const cpuPct = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;

  // Memory
  const memData = fs.readFileSync('/proc/meminfo', 'utf8');
  const getKB = key => parseInt(memData.match(new RegExp(key + ':\\s+(\\d+)'))?.[1] || 0) * 1024;
  const memTotal = getKB('MemTotal');
  const memUsed = memTotal - getKB('MemAvailable');

  // Disk — /instances is a bind-mount from host; BusyBox df format: Filesystem 1-blocks Used Available Use% Mount
  let diskUsed = 0, diskTotal = 1;
  try {
    const dfLine = execSync('df -B1 /instances 2>/dev/null | tail -1').toString().trim().split(/\s+/);
    diskTotal = parseInt(dfLine[1]) || 1;
    diskUsed  = parseInt(dfLine[2]) || 0;
  } catch {}

  // Containers — list all, fetch stats for running ones in parallel
  const all = await docker.listContainers({ all: true });
  const containers = await Promise.all(all.map(async c => {
    const name = (c.Names[0] || '').replace(/^\//, '') || c.Id.slice(0, 12);
    const base = { id: c.Id.slice(0, 12), name, status: c.State, image: c.Image, cpuPct: 0, memUsed: 0, memLimit: 0, memPct: 0 };
    if (c.State !== 'running') return base;
    try {
      const s = await Promise.race([
        docker.getContainer(c.Id).stats({ stream: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = (s.cpu_stats.system_cpu_usage || 0) - (s.precpu_stats.system_cpu_usage || 0);
      const ncpu = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
      const cpuPct = sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * ncpu * 1000) / 10 : 0;
      const memUsed = Math.max(0, (s.memory_stats.usage || 0) - (s.memory_stats.stats?.cache || 0));
      const memLimit = s.memory_stats.limit || 0;
      const memPct = memLimit > 0 ? Math.round(memUsed / memLimit * 100) : 0;
      return { ...base, cpuPct, memUsed, memLimit, memPct };
    } catch { return base; }
  }));

  containers.sort((a, b) => (b.status === 'running' ? 1 : 0) - (a.status === 'running' ? 1 : 0));

  // Images
  const rawImages = await docker.listImages({ all: false });
  const usedImageIds = new Set(all.map(c => c.ImageID));
  const images = rawImages.map(img => {
    const repoTag = (img.RepoTags?.[0]) || (img.RepoDigests?.[0]?.split('@')[0] + ':<none>') || '<none>:<none>';
    const [repo, tag] = repoTag.includes(':') ? repoTag.split(':') : [repoTag, '<none>'];
    return {
      id: img.Id.replace('sha256:', '').slice(0, 12),
      repo,
      tag,
      size: img.Size,
      dangling: !img.RepoTags || img.RepoTags[0] === '<none>:<none>',
      inUse: usedImageIds.has(img.Id),
    };
  }).sort((a, b) => b.size - a.size);

  res.json({
    cpu:  { pct: cpuPct },
    mem:  { used: memUsed,  total: memTotal,  pct: Math.round(memUsed  / memTotal  * 100) },
    disk: { used: diskUsed, total: diskTotal, pct: Math.round(diskUsed / diskTotal * 100) },
    containers,
    images,
  });
});

const CONFIG_DIR = '/clawstack-config';
const ALLOWED_CONFIG_FILES = ['docker-compose.yml', '.env', 'Caddyfile'];

app.get('/api/system/config/:file', requireAdmin, (req, res) => {
  const name = req.params.file;
  if (!ALLOWED_CONFIG_FILES.includes(name)) return res.status(400).json({ error: 'Not allowed' });
  try {
    const content = fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8');
    res.json({ content });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.post('/api/system/config/:file', requireAdmin, (req, res) => {
  const name = req.params.file;
  if (!ALLOWED_CONFIG_FILES.includes(name)) return res.status(400).json({ error: 'Not allowed' });
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    fs.writeFileSync(path.join(CONFIG_DIR, name), content, 'utf8');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/system/prune', requireAdmin, async (req, res) => {
  try {
    const result = await docker.pruneImages({ filters: JSON.stringify({ dangling: { false: true } }) });
    const freed = (result.SpaceReclaimed || 0);
    const count = (result.ImagesDeleted || []).length;
    res.json({ freed, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Paperclip exec / logs ---
app.post('/api/paperclip/exec', requireAdmin, async (req, res) => {
  const { cmd, user } = req.body;
  if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
  const runAs = user === 'node' ? 'node' : 'root';
  try {
    const result = await containerExec(PAPERCLIP_CONTAINER, cmd, runAs, 60000);
    res.json({ output: result.output, exitCode: result.exitCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paperclip/restart', requireAdmin, async (req, res) => {
  try {
    // Parse .env to get fresh values
    let envVars = {};
    try {
      const raw = fs.readFileSync('/clawstack-config/.env', 'utf8');
      raw.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx < 0) return;
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        envVars[key] = val;
      });
    } catch {}

    const r = (k, def = '') => (envVars[k] ?? def);
    const newEnv = [
      `BETTER_AUTH_SECRET=${r('PAPERCLIP_SECRETS_KEY')}`,
      `PAPERCLIP_PUBLIC_URL=https://${r('PAPERCLIP_DOMAIN')}`,
      `DATABASE_URL=postgres://paperclip:paperclip@paperclip-db:5432/paperclip`,
      `ANTHROPIC_API_KEY=${r('ANTHROPIC_API_KEY')}`,
      `CLAUDE_BASE_URL=${r('CLAUDE_BASE_URL')}`,
      `CLAUDE_AUTH_TOKEN=${r('CLAUDE_AUTH_TOKEN')}`,
      `CLAUDE_MODEL=${r('CLAUDE_MODEL')}`,
      `ANTHROPIC_BASE_URL=${r('ANTHROPIC_BASE_URL')}`,
      `ANTHROPIC_AUTH_TOKEN=${r('ANTHROPIC_AUTH_TOKEN')}`,
      `CLAUDE_DEFAULT_MODEL=${r('CLAUDE_DEFAULT_MODEL')}`,
    ];

    const container = docker.getContainer(PAPERCLIP_CONTAINER);
    const info = await container.inspect();

    if (info.State.Running) await container.stop({ t: 10 });
    await container.remove();

    const created = await docker.createContainer({
      name: PAPERCLIP_CONTAINER,
      Image: info.Config.Image,
      Env: newEnv,
      HostConfig: info.HostConfig,
      NetworkingConfig: { EndpointsConfig: { clawstack: {} } },
    });
    await created.start();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paperclip/logs', requireAdmin, async (req, res) => {
  try {
    const container = docker.getContainer(PAPERCLIP_CONTAINER);
    const stream = await container.logs({ stdout: true, stderr: true, tail: 300 });
    const lines = [];
    let offset = 0;
    while (offset + 8 <= stream.length) {
      const size = stream.readUInt32BE(offset + 4);
      offset += 8;
      if (offset + size > stream.length) break;
      lines.push(stream.slice(offset, offset + size).toString('utf8'));
      offset += size;
    }
    res.json({ logs: lines.join('') || stream.toString('utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Paperclip API ---

app.get('/api/paperclip/status', requireAdmin, async (req, res) => {
  const [ppInfo, dbInfo] = await Promise.all([
    docker.getContainer(PAPERCLIP_CONTAINER).inspect().catch(() => null),
    docker.getContainer(PAPERCLIP_DB).inspect().catch(() => null),
  ]);

  let apiHealth = null;
  try { apiHealth = await Promise.race([httpJSON('GET', `${PAPERCLIP_URL}/api/health`), new Promise((_, r) => setTimeout(r, 3000))]); } catch {}

  let agents = [];
  try {
    const q = `SELECT name, role, adapter_config->>'url' AS url, CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE extract(epoch from now()-last_heartbeat_at)::int END AS secs FROM agents WHERE adapter_type='openclaw_gateway' ORDER BY name`;
    const { output } = await containerExec(PAPERCLIP_DB, `psql -U paperclip -d paperclip -t -A -F '|' -c "${q}"`, 'postgres');
    agents = output.split('\n').filter(Boolean).map(l => {
      const [name, role, url, secs] = l.split('|');
      return { name, role, url, secondsAgo: secs ? parseInt(secs) : null };
    });
  } catch {}

  const instances = db.prepare('SELECT name, container_name FROM instances').all();
  const instanceStatus = await Promise.all(instances.map(async inst => {
    let connected = false;
    try { const r = await containerExec(inst.container_name, 'test -f /home/node/.openclaw/workspace/paperclip-claimed-api-key.json'); connected = r.exitCode === 0; } catch {}
    const agent = agents.find(a => a.url && a.url.includes(inst.container_name)) || null;
    return { name: inst.name, containerName: inst.container_name, connected, agent };
  }));

  const pending = db.prepare('SELECT claw_name, created_at FROM paperclip_pending').all();

  res.json({
    paperclip: { running: !!ppInfo?.State?.Running, status: ppInfo?.State?.Status || 'not found' },
    db:        { running: !!dbInfo?.State?.Running, status: dbInfo?.State?.Status || 'not found' },
    api: apiHealth,
    agents,
    instances: instanceStatus,
    pending,
  });
});

app.post('/api/paperclip/fix', requireAdmin, async (req, res) => {
  const results = [];

  // Fix 1: un-revoke token
  try {
    const { output } = await containerExec(PAPERCLIP_DB,
      `psql -U paperclip -d paperclip -t -A -c "UPDATE agent_api_keys SET revoked_at=NULL WHERE key_hash='660c9c30b5d47cb01c32765aaad8382afe7ade4b765514502ca835f4dcb7585b' AND revoked_at IS NOT NULL RETURNING id"`,
      'postgres');
    const n = output.split('\n').filter(Boolean).length;
    results.push({ fix: 1, label: 'Token un-revoke', msg: n > 0 ? 'Un-revoked.' : 'Already active.', changed: n > 0 });
  } catch (e) { results.push({ fix: 1, label: 'Token un-revoke', msg: 'Error: ' + e.message, changed: false, error: true }); }

  // Fix 2: payloadTemplate channel
  try {
    const { output } = await containerExec(PAPERCLIP_DB,
      `psql -U paperclip -d paperclip -t -A -c "UPDATE agents SET adapter_config=adapter_config||'{\\"payloadTemplate\\":{\\"channel\\":\\"heartbeat\\"}}'::jsonb WHERE adapter_type='openclaw_gateway' AND (adapter_config->'payloadTemplate' IS NULL OR adapter_config->'payloadTemplate'->>'channel' IS NULL) RETURNING id"`,
      'postgres');
    const n = output.split('\n').filter(Boolean).length;
    results.push({ fix: 2, label: 'payloadTemplate channel', msg: n > 0 ? `Set on ${n} agent(s).` : 'Already set.', changed: n > 0 });
  } catch (e) { results.push({ fix: 2, label: 'payloadTemplate channel', msg: 'Error: ' + e.message, changed: false, error: true }); }

  // Fix 3: Claude CLI
  try {
    const { exitCode } = await containerExec(PAPERCLIP_CONTAINER, 'which claude > /dev/null 2>&1');
    if (exitCode === 0) {
      results.push({ fix: 3, label: 'Claude CLI', msg: 'Already installed.', changed: false });
    } else {
      await containerExec(PAPERCLIP_CONTAINER, 'curl -fsSL https://claude.ai/install.sh | bash 2>&1', 'node', 120000);
      results.push({ fix: 3, label: 'Claude CLI', msg: 'Installed.', changed: true });
    }
  } catch (e) { results.push({ fix: 3, label: 'Claude CLI', msg: 'Error: ' + e.message, changed: false, error: true }); }

  // Fix 4: allow_remote_control
  try {
    const { output } = await containerExec(PAPERCLIP_CONTAINER,
      `node -e "try{const p=require(process.env.HOME+'/.claude/policy-limits.json');process.stdout.write(String(p.restrictions?.allow_remote_control?.allowed))}catch{process.stdout.write('missing')}"`);
    if (output === 'true') {
      results.push({ fix: 4, label: 'allow_remote_control', msg: 'Already enabled.', changed: false });
    } else {
      await containerExec(PAPERCLIP_CONTAINER,
        `mkdir -p ~/.claude && printf '{"restrictions":{"allow_remote_control":{"allowed":true}}}' > ~/.claude/policy-limits.json`);
      results.push({ fix: 4, label: 'allow_remote_control', msg: 'Enabled.', changed: true });
    }
  } catch (e) { results.push({ fix: 4, label: 'allow_remote_control', msg: 'Error: ' + e.message, changed: false, error: true }); }

  // Fix 5: private LLM env vars
  try {
    const [{ output: baseUrl }, { output: authToken }, { output: model }] = await Promise.all([
      containerExec(PAPERCLIP_CONTAINER, 'printf "%s" "${CLAUDE_BASE_URL:-}"'),
      containerExec(PAPERCLIP_CONTAINER, 'printf "%s" "${CLAUDE_AUTH_TOKEN:-}"'),
      containerExec(PAPERCLIP_CONTAINER, 'printf "%s" "${CLAUDE_MODEL:-}"'),
    ]);
    if (baseUrl && authToken && model) {
      const { output: already } = await containerExec(PAPERCLIP_CONTAINER, 'grep -q "ANTHROPIC_BASE_URL" ~/.bashrc 2>/dev/null && echo yes || echo no');
      if (already === 'yes') {
        results.push({ fix: 5, label: 'Private LLM', msg: 'Already in .bashrc.', changed: false });
      } else {
        await containerExec(PAPERCLIP_CONTAINER,
          `printf '\\n# Private LLM\\nexport ANTHROPIC_BASE_URL="${baseUrl}"\\nexport ANTHROPIC_AUTH_TOKEN="${authToken}"\\nexport ANTHROPIC_API_KEY=""\\nexport CLAUDE_DEFAULT_MODEL="${model}"\\n' >> ~/.bashrc`);
        results.push({ fix: 5, label: 'Private LLM', msg: `Written (model: ${model}).`, changed: true });
      }
    } else {
      results.push({ fix: 5, label: 'Private LLM', msg: 'Not configured, skipped.', changed: false });
    }
  } catch (e) { results.push({ fix: 5, label: 'Private LLM', msg: 'Error: ' + e.message, changed: false, error: true }); }

  res.json({ results });
});

app.post('/api/paperclip/connect', requireAdmin, async (req, res) => {
  const { clawName, inviteToken } = req.body;
  if (!clawName || !inviteToken) return res.status(400).json({ error: 'clawName and inviteToken required' });
  const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(clawName);
  if (!row) return res.status(404).json({ error: 'Instance not found' });

  let gwToken;
  try {
    const { output } = await containerExec(row.container_name,
      `node -e "const c=require('/home/node/.openclaw/openclaw.json');process.stdout.write(c.gateway.auth.token)"`, 'node');
    gwToken = output;
  } catch (e) { return res.status(500).json({ error: 'Could not read gateway token: ' + e.message }); }
  if (!gwToken) return res.status(500).json({ error: 'Empty gateway token' });

  const agentName = clawName.charAt(0).toUpperCase() + clawName.slice(1);
  try {
    const resp = await httpJSON('POST', `${PAPERCLIP_URL}/api/invites/${inviteToken}/accept`, {
      requestType: 'agent', agentName,
      adapterType: 'openclaw_gateway',
      capabilities: `OpenClaw agent — ClawStack instance ${clawName}`,
      agentDefaultsPayload: {
        url: `ws://clawstack-${clawName}:18789`,
        paperclipApiUrl: PAPERCLIP_URL,
        headers: { 'x-openclaw-token': gwToken },
        waitTimeoutMs: 120000, sessionKeyStrategy: 'issue',
        role: 'operator', scopes: ['operator.admin'],
      },
    });
    if (!resp.id) return res.status(400).json({ error: resp.message || 'Paperclip rejected the request', detail: resp });
    db.prepare('INSERT OR REPLACE INTO paperclip_pending (claw_name,request_id,claim_secret,gw_token) VALUES (?,?,?,?)')
      .run(clawName, resp.id, resp.claimSecret, gwToken);
    res.json({ success: true, requestId: resp.id, agentName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paperclip/finalize/:name', requireAdmin, async (req, res) => {
  const pending = db.prepare('SELECT * FROM paperclip_pending WHERE claw_name = ?').get(req.params.name);
  if (!pending) return res.status(404).json({ error: 'No pending connection for this instance' });
  const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'Instance not found' });

  const steps = [];

  let apiToken, agentId;
  try {
    const resp = await httpJSON('POST', `${PAPERCLIP_URL}/api/join-requests/${pending.request_id}/claim-api-key`, { claimSecret: pending.claim_secret });
    if (!resp.token) return res.status(400).json({ error: resp.message || 'Claim failed — board approval pending?', steps });
    apiToken = resp.token; agentId = resp.agentId;
    steps.push({ ok: true, msg: 'API key claimed.' });
  } catch (e) { return res.status(500).json({ error: e.message, steps }); }

  try {
    await containerExec(row.container_name,
      `printf '%s' '{"token":"${apiToken}","agentId":"${agentId}"}' > /home/node/.openclaw/workspace/paperclip-claimed-api-key.json && chmod 600 /home/node/.openclaw/workspace/paperclip-claimed-api-key.json && chown node:node /home/node/.openclaw/workspace/paperclip-claimed-api-key.json`);
    steps.push({ ok: true, msg: 'API key saved to container.' });
  } catch (e) { steps.push({ ok: false, msg: 'Could not save API key: ' + e.message }); }

  try {
    await containerExec(row.container_name,
      `mkdir -p /home/node/.openclaw/skills/paperclip && curl -fsS '${PAPERCLIP_URL}/api/skills/paperclip' > /home/node/.openclaw/skills/paperclip/SKILL.md && sed -i '1s|^|PAPERCLIP_API_URL: ${PAPERCLIP_URL}\\n\\n|' /home/node/.openclaw/skills/paperclip/SKILL.md && chown -R node:node /home/node/.openclaw/skills`);
    steps.push({ ok: true, msg: 'Paperclip skill installed.' });
  } catch (e) { steps.push({ ok: false, msg: 'Skill install failed: ' + e.message }); }

  try {
    await containerExec(row.container_name, 'openclaw devices list > /dev/null 2>&1 && openclaw devices approve --latest 2>&1', 'node');
    steps.push({ ok: true, msg: 'Device paired.' });
  } catch (e) { steps.push({ ok: false, msg: 'Device approval failed — retry via Paperclip: ' + e.message }); }

  db.prepare('DELETE FROM paperclip_pending WHERE claw_name = ?').run(req.params.name);
  res.json({ success: true, steps });
});

// --- Preset openclaw.json config fragments ---
// Merged into the generated openclaw.json for role presets (not generalist).
const PRESET_BASE_CONFIG = {
  tools: {
    allow: ['exec', 'process', 'read', 'write'],
  },
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
  agentDefaults: {
    elevatedDefault: 'on',
    thinkingDefault: 'low',
  },
  cron: { enabled: true },
};

const PRESET_BROWSER_CONFIG = {
  browser: {
    enabled: true,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  },
};

// --- Agent role presets ---
const AGENT_ROLES = {
  generalist: {
    label: 'Generalist',
    description: 'Blank slate — full control',
    identity: null,
    soul: null,
    tools: null,
    a2aSkills: [],
    presetConfig: null,
  },
  qa: {
    label: 'QA agent',
    description: 'Tests and audits web properties',
    identity: `# IDENTITY.md

- **Name:** ${'{name}'}
- **Creature:** QA agent
- **Vibe:** Methodical, precise, relentless about quality
- **Emoji:** 🔍

My job is to find what's broken before users do. I report findings clearly, grade severity honestly, and never ship a vague "something feels off" — everything gets a label, a location, and a recommendation.`,
    soul: `# SOUL.md

## Core Truths

**Find real problems.** Not theoretical ones, not edge cases no one will ever hit. Focus on what actually breaks the experience.

**Grade severity honestly.** Critical means users can't complete their goal. High means they probably won't. Medium means friction. Low means polish. Don't inflate — it erodes trust.

**Be specific.** "The button doesn't work" is useless. "Submit button on /checkout throws a 422 when the postal code field is empty" is actionable.

**Report, don't fix.** Unless asked, your job is to surface issues clearly — not to start rewriting things. Leave the decisions to the humans.

**Be resourceful.** Try to reproduce before reporting. Check if it's consistent across browsers, viewports, states. One screenshot beats three paragraphs.

## What I check

- Page load and rendering errors
- Broken links, missing assets, console errors
- Form validation and submission flows
- Accessibility (keyboard nav, contrast, alt text, ARIA)
- Mobile responsiveness
- Performance (obvious slowdowns, large assets)

## How I report

Each finding includes: what's broken, where it is, how to reproduce, severity (critical / high / medium / low), and a suggested fix if obvious.

## Boundaries

- I don't fix what I find unless explicitly asked
- I don't speculate about business logic — I test behaviour
- Private data I encounter during testing stays private`,
    tools: `# TOOLS.md

## What Goes Here

Add site-specific details that help me test more effectively:

### Target sites
- Primary: (add the URL you want me to audit by default)

### Known issues to skip
- (list anything already tracked so I don't re-report it)

### Test accounts
- (add any login credentials I can use for authenticated flows)

### Scope
- (pages or flows that are in scope / out of scope)`,
    a2aSkills: [
      { id: 'page_audit', name: 'Page audit', description: 'Audit a URL for errors, broken links, console issues, and performance' },
      { id: 'accessibility_check', name: 'Accessibility check', description: 'Check a page for WCAG compliance issues' },
      { id: 'form_test', name: 'Form test', description: 'Test a form submission flow end to end' },
      { id: 'regression_run', name: 'Regression run', description: 'Run a regression check across a set of URLs' },
    ],
  },
  seo: {
    label: 'SEO agent',
    description: 'Audits and improves search visibility',
    identity: `# IDENTITY.md

- **Name:** ${'{name}'}
- **Creature:** SEO agent
- **Vibe:** Data-driven, patient, thinks in search intent
- **Emoji:** 📈

I care about one thing: whether the right people can find this content. I read pages like a crawler, think like a searcher, and report like an analyst.`,
    soul: `# SOUL.md

## Core Truths

**Think in search intent.** Every page is trying to answer a question. My job is to figure out whether it actually does — and whether Google can tell.

**Data over opinion.** I back recommendations with numbers where possible. "This page is too slow" means nothing. "This page takes 6.2s to load on mobile and loses 40% of users before the fold" means something.

**Prioritise impact.** Not every SEO issue matters equally. I focus on what moves traffic, not what ticks checkboxes.

**Be honest about limits.** I can audit what's visible. I can't see search console data, historical rankings, or competitor backlink profiles unless you give me access.

## What I check

- Title tags, meta descriptions, heading structure
- Content quality and keyword alignment
- Internal linking and site architecture
- Page speed and Core Web Vitals
- Mobile usability
- Schema markup and structured data
- Canonical tags and indexability

## How I report

Scored recommendations: what's the issue, why it matters for search, what to fix, estimated impact (high / medium / low).

## Boundaries

- I audit and recommend — I don't rewrite content without being asked
- I won't suggest manipulative tactics (keyword stuffing, hidden text, link schemes)`,
    tools: `# TOOLS.md

## What Goes Here

### Target site
- Primary domain: (add the site you're auditing)

### Competitors to benchmark against
- (optional: add competitor domains for comparison)

### Search console access
- (add if you have access to GSC data)

### Priority pages
- (list the pages that matter most — homepage, key landing pages, etc.)`,
    a2aSkills: [
      { id: 'seo_audit', name: 'SEO audit', description: 'Full SEO audit of a URL or domain' },
      { id: 'keyword_analysis', name: 'Keyword analysis', description: 'Analyse keyword usage and opportunities on a page' },
      { id: 'content_gap', name: 'Content gap', description: 'Identify missing content topics relative to a target audience' },
      { id: 'competitor_check', name: 'Competitor check', description: 'Compare a page against a competitor URL' },
    ],
  },
  dev: {
    label: 'Dev agent',
    description: 'Code review, docs, and technical analysis',
    identity: `# IDENTITY.md

- **Name:** ${'{name}'}
- **Creature:** Dev agent
- **Vibe:** Direct, precise, has opinions about code
- **Emoji:** 🛠️

I read code the way an experienced engineer would in a PR review — looking for correctness, clarity, security, and maintainability. I'm constructive, not pedantic.`,
    soul: `# SOUL.md

## Core Truths

**Be constructive.** A code review that only says what's wrong is a bad review. Say what's wrong, why it matters, and what better looks like.

**Have opinions.** "This works but there's a cleaner approach" is valuable. Pretending everything is equally valid isn't.

**Distinguish blocking from non-blocking.** Some issues must be fixed before merging. Others are suggestions. I'll be clear about the difference.

**Don't over-engineer.** The right solution is usually the simpler one. I won't suggest abstractions for one-off operations or patterns that solve hypothetical future problems.

**Security is non-negotiable.** SQL injection, XSS, hardcoded secrets, missing auth — these always get flagged as critical regardless of scope.

## What I check

- Correctness and edge cases
- Security vulnerabilities (OWASP top 10)
- Readability and naming
- Unnecessary complexity
- Test coverage gaps
- Documentation clarity

## How I report

Each review item: severity (blocking / suggestion / nit), what the issue is, why it matters, how to fix it.

## Boundaries

- I review code I'm given — I don't fetch external repos without permission
- I don't refactor speculatively — only what's asked
- I won't generate code that introduces security vulnerabilities`,
    tools: `# TOOLS.md

## What Goes Here

### Repo / codebase
- Primary language: (e.g. TypeScript, Python, Go)
- Framework: (e.g. Next.js, FastAPI, Rails)

### Code style
- (link to style guide or describe preferences)

### Areas to focus on
- (specific modules, services, or patterns to prioritise)

### Out of scope
- (legacy code, generated files, etc.)`,
    a2aSkills: [
      { id: 'code_review', name: 'Code review', description: 'Review code for correctness, security, and clarity' },
      { id: 'generate_docs', name: 'Generate docs', description: 'Generate documentation for a function, module, or API' },
      { id: 'diff_summary', name: 'Diff summary', description: 'Summarise a git diff or PR in plain language' },
      { id: 'security_scan', name: 'Security scan', description: 'Scan code for common security vulnerabilities' },
    ],
  },
  support: {
    label: 'Support agent',
    description: 'Customer-facing help and escalation',
    identity: `# IDENTITY.md

- **Name:** ${'{name}'}
- **Creature:** Support agent
- **Vibe:** Warm, patient, solution-focused
- **Emoji:** 💬

I help people get unstuck. I listen first, understand the actual problem (not just the stated one), and either resolve it or get it to someone who can.`,
    soul: `# SOUL.md

## Core Truths

**Understand before responding.** The first message rarely describes the real problem. Ask the clarifying question before writing a solution.

**Be warm without being fake.** Genuine helpfulness beats scripted empathy every time. Skip "I completely understand your frustration" — just fix the problem.

**Escalate decisively.** Knowing when you can't help is a skill. Escalate clearly, with context, so the next person doesn't start from scratch.

**Protect user privacy.** Customer data I handle in conversations stays private. I don't reference it beyond the immediate interaction unless asked.

**Don't overpromise.** "I'll look into this" is fine. "This will definitely be fixed by tomorrow" is not mine to promise.

## How I handle conversations

1. Acknowledge the issue
2. Clarify if needed (one specific question, not a list)
3. Resolve if I can — with clear steps
4. Escalate if I can't — with full context

## Escalation means

Passing the issue to a human with: customer name, issue summary, what was already tried, and why it needs human attention.

## Boundaries

- I don't make commitments about timelines or refunds without authorisation
- I don't speculate about product roadmap
- I stay in my lane — I help with what I know, escalate what I don't`,
    tools: `# TOOLS.md

## What Goes Here

### Product / service
- What are we supporting: (describe the product briefly)

### Common issues
- (list the top 5 most frequent support requests)

### Escalation paths
- Billing issues → (who/where)
- Technical bugs → (who/where)
- Account access → (who/where)

### Tone guidelines
- (formal / casual, any specific language preferences)`,
    a2aSkills: [
      { id: 'answer_question', name: 'Answer question', description: 'Answer a customer support question' },
      { id: 'escalate', name: 'Escalate', description: 'Prepare an escalation summary for a human agent' },
      { id: 'summarise_conversation', name: 'Summarise conversation', description: 'Summarise a support conversation with key points and outcome' },
    ],
  },
  research: {
    label: 'Research agent',
    description: 'Web research, analysis, and synthesis',
    identity: `# IDENTITY.md

- **Name:** ${'{name}'}
- **Creature:** Research agent
- **Vibe:** Thorough, curious, allergic to unsourced claims
- **Emoji:** 🔬

I dig. I find primary sources, compare positions, surface what's actually known versus what's assumed, and deliver structured summaries that you can act on or build from.`,
    soul: `# SOUL.md

## Core Truths

**Primary sources over summaries.** I go to the original paper, the actual filing, the real interview — not the article about the article.

**Cite everything.** If I can't point to a source, I say it's my interpretation. Unsourced claims are clearly labelled as such.

**Present balanced views.** On contested topics, I present the strongest version of each position — not the one I find most credible, unless you ask for my assessment.

**Be honest about uncertainty.** "The evidence is mixed" is a valid research finding. Forcing a conclusion where none exists is worse than no conclusion.

**Scope the request before diving.** If the question is ambiguous, I'll confirm scope before spending effort in the wrong direction.

## How I structure research output

1. Summary (2-3 sentences: what I found)
2. Key findings (bulleted, sourced)
3. Conflicting evidence (if any)
4. Gaps / what I couldn't find
5. Sources

## Boundaries

- I don't fabricate citations
- I don't express opinions on politically contested topics without being asked
- I won't misrepresent what sources say to support a preferred conclusion`,
    tools: `# TOOLS.md

## What Goes Here

### Recurring research areas
- (topics you come back to often — I'll build context over time)

### Preferred source types
- (academic / news / industry reports / primary sources only)

### Output format preferences
- (bullet points, prose, tables, markdown — whatever you prefer)

### Languages
- (if research should include non-English sources)`,
    a2aSkills: [
      { id: 'search_web', name: 'Search web', description: 'Search the web and return sourced findings on a topic' },
      { id: 'summarise_sources', name: 'Summarise sources', description: 'Summarise and synthesise a set of sources' },
      { id: 'extract_facts', name: 'Extract facts', description: 'Extract key facts from a URL or document' },
      { id: 'compare_positions', name: 'Compare positions', description: 'Compare different positions or arguments on a topic' },
    ],
  },
};

// --- Admin UI ---
const PROVIDERS = ['openrouter', 'openai', 'anthropic', 'gemini', 'private'];
const MODEL_PRESETS = {
  openrouter: 'google/gemini-2.5-pro-preview',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro-preview',
  private: 'my-model',
};
// Providers where API key is optional
const NO_KEY_PROVIDERS = new Set(['private']);

app.get('/', requireAdmin, (req, res) => {
  const instances = db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all();
  const authHeader = JSON.stringify(req.headers.authorization || '');
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>ClawStack — Multi-tenant OpenClaw hosting</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="ClawStack admin portal — manage OpenClaw AI agent instances, monitor containers, and configure your stack.">
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:title" content="ClawStack">
  <meta property="og:description" content="Multi-tenant OpenClaw hosting platform">
  <meta property="og:type" content="website">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦞</text></svg>">
  <style>
    :root{
      --bg:#09090b;--surface:#18181b;--surface2:#1f1f23;--border:#27272a;--border2:#3f3f46;
      --text:#fafafa;--text2:#a1a1aa;--text3:#52525b;
      --blue:#3b82f6;--blue-dim:#1d4ed8;--blue-bg:rgba(59,130,246,.08);
      --green:#22c55e;--green-bg:rgba(34,197,94,.1);
      --red:#ef4444;--red-bg:rgba(239,68,68,.1);
      --amber:#f59e0b;--amber-bg:rgba(245,158,11,.1);
      --radius:8px;--radius-sm:5px;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    /* ── Layout ── */
    .page{max-width:960px;margin:0 auto;padding:2.5rem 1.5rem}
    /* ── Header ── */
    .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2.5rem}
    .logo{display:flex;align-items:center;gap:10px}
    .logo-mark{width:32px;height:32px;background:var(--blue);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
    .logo-text{font-size:1.1rem;font-weight:600;color:var(--text);letter-spacing:-.02em}
    .logo-sub{font-size:0.75rem;color:var(--text3);margin-top:1px}
    /* ── Section ── */
    .section{margin-bottom:1.5rem}
    .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
    .section-title{font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.08em}
    /* ── Card ── */
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem}
    /* ── Form ── */
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.75rem}
    .full{grid-column:1/-1}
    .field label{display:block;font-size:0.72rem;font-weight:500;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.05em}
    input,select{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 11px;border-radius:var(--radius-sm);font-size:0.875rem;outline:none;transition:border-color .15s}
    input:focus,select:focus{border-color:var(--blue)}
    select option{background:var(--surface)}
    input::placeholder{color:var(--text3)}
    /* ── Buttons ── */
    .btn{display:inline-flex;align-items:center;gap:5px;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:0.8rem;font-weight:500;padding:6px 14px;color:#fff;background:var(--blue);transition:opacity .15s,background .15s;white-space:nowrap}
    .btn:hover{opacity:.85}
    .btn:disabled{opacity:.3;cursor:default}
    .btn.sm{padding:4px 10px;font-size:0.74rem;border-radius:4px}
    .btn.xs{padding:2px 7px;font-size:0.7rem;border-radius:4px}
    .btn.ghost{background:var(--surface2);color:var(--text2);border:1px solid var(--border)}
    .btn.ghost:hover{background:var(--border);opacity:1}
    .btn.danger{background:var(--red-bg);color:var(--red);border:1px solid rgba(239,68,68,.2)}
    .btn.danger:hover{background:var(--red);color:#fff;opacity:1}
    .btn.amber{background:var(--amber-bg);color:var(--amber);border:1px solid rgba(245,158,11,.2)}
    .btn.amber:hover{background:var(--amber);color:#fff;opacity:1}
    .btn.green{background:var(--green-bg);color:var(--green);border:1px solid rgba(34,197,94,.2)}
    .btn.green:hover{background:var(--green);color:#fff;opacity:1}
    .btn.primary{background:var(--blue);border:none;padding:8px 18px;font-size:0.875rem}
    /* ── Badge ── */
    .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:99px;font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
    .badge::before{content:'';width:5px;height:5px;border-radius:50%;flex-shrink:0}
    .badge.running{background:var(--green-bg);color:var(--green)}.badge.running::before{background:var(--green)}
    .badge.stopped{background:var(--surface2);color:var(--text3)}.badge.stopped::before{background:var(--text3)}
    .badge.error{background:var(--red-bg);color:var(--red)}.badge.error::before{background:var(--red)}
    .badge.starting{background:var(--amber-bg);color:var(--amber)}.badge.starting::before{background:var(--amber)}
    .badge.role{background:var(--surface2);color:var(--text2)}.badge.role::before{display:none}
    /* ── Instance cards ── */
    .instances{display:flex;flex-direction:column;gap:0.5rem}
    .inst-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;display:flex;align-items:center;gap:1rem;transition:border-color .15s}
    .inst-card:hover{border-color:var(--border2)}
    .inst-main{flex:1;min-width:0}
    .inst-name{font-size:0.925rem;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px}
    .inst-meta{font-size:0.72rem;color:var(--text3);margin-top:3px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .inst-domain{font-size:0.8rem;color:var(--blue);text-decoration:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .inst-domain:hover{text-decoration:underline}
    .inst-token{display:flex;align-items:center;gap:4px}
    .tok-val{font-size:0.68rem;color:var(--text3);font-family:monospace;cursor:pointer;transition:color .15s}
    .tok-val:hover{color:var(--text2)}
    .copy-btn{background:none;border:none;cursor:pointer;color:var(--text3);padding:2px 4px;border-radius:3px;font-size:0.75rem;line-height:1;transition:color .15s}
    .copy-btn:hover{color:var(--blue)}
    .inst-actions{display:flex;gap:5px;align-items:center;flex-shrink:0}
    .divider{width:1px;height:18px;background:var(--border);flex-shrink:0}
    /* ── Links ── */
    a{color:var(--blue);text-decoration:none}
    /* ── CNAME notice ── */
    .cname-notice{margin-top:6px;padding:7px 11px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:var(--radius-sm);font-size:0.75rem;color:var(--amber);line-height:1.5;display:none}
    .cname-notice code{color:#fcd34d;background:rgba(0,0,0,.3);padding:1px 5px;border-radius:3px;font-size:0.72rem}
    /* ── Empty state ── */
    .empty{padding:2.5rem;text-align:center;color:var(--text3);font-size:0.875rem;border:1px dashed var(--border);border-radius:var(--radius)}
    /* ══ Manager modal ══ */
    #mgr{display:none;position:fixed;inset:0;z-index:999;flex-direction:column;background:var(--bg)}
    #mgr.open{display:flex}
    #mgr-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0;min-height:49px}
    #mgr-bar .back{font-size:0.78rem;color:var(--text3);cursor:pointer;display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:4px;border:none;background:none;transition:color .15s}
    #mgr-bar .back:hover{color:var(--text)}
    #mgr-bar .inst-label{font-size:0.875rem;font-weight:600;color:var(--text)}
    #mgr-bar .spacer{flex:1}
    #mgr-bar .bar-actions{display:flex;gap:5px;align-items:center}
    #mgr-action-status{font-size:0.72rem;color:var(--text3);min-width:50px;text-align:right}
    #mgr-tabs{display:flex;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface);padding:0 8px}
    .tab{padding:8px 14px;font-size:0.78rem;font-weight:500;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent;transition:color .15s;user-select:none}
    .tab:hover{color:var(--text2)}
    .tab.active{color:var(--blue);border-bottom-color:var(--blue)}
    #mgr-body{display:flex;flex:1;overflow:hidden}
    #mgr-tree{width:240px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--border);font-size:0.76rem;font-family:monospace;padding:6px 0;background:var(--surface)}
    #mgr-right{flex:1;display:flex;flex-direction:column;overflow:hidden}
    #mgr-crumb{padding:5px 16px;font-size:0.7rem;color:var(--text3);font-family:monospace;background:var(--surface2);border-bottom:1px solid var(--border);flex-shrink:0}
    #mgr-editor{flex:1;background:var(--bg);color:#c9d1d9;border:none;outline:none;resize:none;padding:16px 20px;font-family:'Fira Code',Consolas,monospace;font-size:13px;line-height:1.7;tab-size:2}
    #mgr-logs{flex:1;background:var(--bg);color:var(--text3);overflow-y:auto;padding:14px 18px;font-family:monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;display:none}
    #mgr-footer{display:flex;align-items:center;gap:8px;padding:8px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0}
    #mgr-status{font-size:0.75rem;color:var(--text3)}
    /* ── Top nav ── */
    .page-nav{display:flex;gap:2px;padding:3px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);width:fit-content}
    .page-nav-btn{padding:5px 16px;font-size:0.78rem;font-weight:500;border:none;background:none;color:var(--text3);border-radius:5px;cursor:pointer;transition:all .15s}
    .page-nav-btn:hover{color:var(--text2)}
    .page-nav-btn.active{background:var(--surface2);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.3)}
    /* ── System page ── */
    .sys-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem}
    .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.5rem;display:flex;align-items:center;gap:1.25rem}
    .stat-card:hover{border-color:var(--border2)}
    .ring-wrap{position:relative;width:72px;height:72px;flex-shrink:0}
    .ring-svg{width:100%;height:100%;transform:rotate(-90deg)}
    .ring-track{fill:none;stroke:var(--border2);stroke-width:3.5}
    .ring-prog{fill:none;stroke-width:3.5;stroke-linecap:round;transition:stroke-dasharray .4s ease}
    .ring-val{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:0.9rem;font-weight:700;color:var(--text)}
    .stat-info{flex:1;min-width:0}
    .stat-label{font-size:0.68rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
    .stat-main{font-size:1.5rem;font-weight:700;color:var(--text);line-height:1;margin-bottom:3px}
    .stat-sub{font-size:0.72rem;color:var(--text3)}
    /* ── Container table ── */
    .ct-head,.ct-row{display:grid;grid-template-columns:minmax(160px,2fr) 80px 130px 170px minmax(100px,1fr);align-items:center;gap:1rem;padding:0 1.25rem}
    .ct-head{padding-top:.5rem;padding-bottom:.5rem;font-size:0.65rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid var(--border)}
    .ct-row{padding-top:.65rem;padding-bottom:.65rem;border-bottom:1px solid var(--border);transition:background .12s}
    .ct-row:last-child{border-bottom:none}
    .ct-row:hover{background:var(--surface2)}
    .ct-name-cell{display:flex;align-items:center;gap:8px;min-width:0}
    .ct-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
    .ct-dot.running{background:var(--green);box-shadow:0 0 5px rgba(34,197,94,.5)}
    .ct-dot.exited,.ct-dot.dead{background:var(--text3)}
    .ct-dot.paused,.ct-dot.restarting{background:var(--amber)}
    .ct-name-text{font-size:0.82rem;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ct-cpu-pct,.ct-stat-val{font-size:0.78rem;color:var(--text2);font-variant-numeric:tabular-nums}
    .mini-bar-wrap{margin-top:3px;height:3px;background:var(--border2);border-radius:2px;overflow:hidden}
    .mini-bar-fill{height:100%;border-radius:2px;transition:width .3s ease}
    .mini-bar-fill.cpu{background:var(--blue)}
    .mini-bar-fill.mem{background:var(--green)}
    .mini-bar-fill.warn{background:var(--amber)}
    .mini-bar-fill.danger{background:var(--red)}
    .ct-image-tag{font-size:0.7rem;color:var(--text3);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ct-status-badge{font-size:0.68rem;font-weight:600;padding:2px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:.03em;width:fit-content}
    .ct-status-badge.running{background:var(--green-bg);color:var(--green)}
    .ct-status-badge.exited,.ct-status-badge.dead{background:var(--surface2);color:var(--text3)}
    .ct-status-badge.restarting,.ct-status-badge.paused{background:var(--amber-bg);color:var(--amber)}
    .sys-refresh{font-size:0.7rem;color:var(--text3)}
    /* ── Config editor ── */
    .cfg-tabs{display:flex;gap:2px;padding:3px;background:var(--surface2);border-bottom:1px solid var(--border)}
    .cfg-tab{padding:5px 14px;font-size:0.75rem;font-weight:500;border:none;background:none;color:var(--text3);border-radius:4px;cursor:pointer;transition:all .12s;font-family:monospace}
    .cfg-tab:hover{color:var(--text2)}
    .cfg-tab.active{background:var(--bg);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.3)}
    .cfg-editor{width:100%;background:var(--bg);color:#c9d1d9;border:none;outline:none;resize:none;padding:16px 20px;font-family:'Fira Code',Consolas,monospace;font-size:12.5px;line-height:1.7;tab-size:2;min-height:320px}
    .cfg-footer{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--border);background:var(--surface)}
    /* ── Images table ── */
    .img-table{width:100%;border-collapse:collapse;font-size:0.82rem}
    .img-table th{padding:8px 14px;font-size:0.65rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;text-align:left;border-bottom:1px solid var(--border)}
    .img-table td{padding:9px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
    .img-table tr:last-child td{border-bottom:none}
    .img-table tr:hover td{background:var(--surface2)}
    .img-repo{font-weight:500;color:var(--text)}
    .img-tag{font-size:0.72rem;color:var(--blue);font-family:monospace}
    .img-size{font-variant-numeric:tabular-nums;font-size:0.78rem;color:var(--text2)}
    .img-size-bar{height:3px;background:var(--border2);border-radius:2px;margin-top:3px;overflow:hidden}
    .img-size-fill{height:100%;background:var(--blue);border-radius:2px}
    .dangling-badge{font-size:0.65rem;padding:1px 6px;border-radius:99px;background:var(--amber-bg);color:var(--amber);font-weight:600}
    .inuse-badge{font-size:0.65rem;padding:1px 6px;border-radius:99px;background:var(--green-bg);color:var(--green);font-weight:600}
    /* ── Paperclip page ── */
    .pp-status-row{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem}
    .pp-status-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;display:flex;flex-direction:column;gap:4px}
    .pp-status-label{font-size:0.65rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.08em}
    .chat-bubble{max-width:80%;padding:8px 12px;border-radius:12px;font-size:0.85rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
    .chat-bubble.user{background:var(--blue);color:#fff;align-self:flex-end;border-bottom-right-radius:3px}
    .chat-bubble.assistant{background:var(--surface2);color:var(--text);align-self:flex-start;border-bottom-left-radius:3px;border:1px solid var(--border)}
    .chat-bubble.assistant.streaming{opacity:0.8}
    .chat-role{font-size:0.65rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
    .chat-msg{display:flex;flex-direction:column}
    .pp-status-val{font-size:0.95rem;font-weight:600;color:var(--text);display:flex;align-items:center;gap:6px}
    .pp-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
    .pp-dot.ok{background:var(--green);box-shadow:0 0 5px rgba(34,197,94,.4)}
    .pp-dot.err{background:var(--red)}
    .pp-dot.warn{background:var(--amber)}
    .pp-sub{font-size:0.72rem;color:var(--text3)}
    .pp-agents-table,.pp-inst-table{width:100%;border-collapse:collapse;font-size:0.82rem}
    .pp-agents-table th,.pp-inst-table th{padding:8px 14px;font-size:0.65rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;text-align:left;border-bottom:1px solid var(--border)}
    .pp-agents-table td,.pp-inst-table td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
    .pp-agents-table tr:last-child td,.pp-inst-table tr:last-child td{border-bottom:none}
    .pp-agents-table tr:hover td,.pp-inst-table tr:hover td{background:var(--surface2)}
    .pp-hb{font-size:0.72rem;color:var(--text3);font-family:monospace}
    .pp-fix-result{display:flex;align-items:baseline;gap:8px;padding:4px 0;font-size:0.8rem}
    .pp-fix-label{font-weight:500;color:var(--text2);min-width:160px}
    .pp-fix-msg{color:var(--text3)}
    .pp-fix-msg.changed{color:var(--green)}
    .pp-fix-msg.error{color:var(--red)}
    .pp-invite-row{display:flex;gap:8px;margin-top:6px}
    .pp-invite-row input{flex:1}
    /* ── Terminal panels (CLI + Exec) ── */
    .term-panel{flex:1;display:none;flex-direction:column;overflow:hidden}
    .term-output{flex:1;background:var(--bg);overflow-y:auto;padding:14px 18px;font-family:monospace;font-size:12px;line-height:1.6;white-space:pre-wrap}
    .term-hints{display:flex;flex-wrap:wrap;gap:5px;padding:8px 16px;background:var(--surface2);border-bottom:1px solid var(--border);flex-shrink:0}
    .term-hints button{background:none;border:1px solid var(--border);color:var(--text3);padding:2px 8px;border-radius:4px;font-size:0.7rem;cursor:pointer;font-family:monospace;transition:all .12s}
    .term-hints button:hover{border-color:var(--border2);color:var(--text)}
    .term-input-row{display:flex;gap:8px;padding:8px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;align-items:center}
    .term-prefix{font-family:monospace;font-size:0.82rem;flex-shrink:0;opacity:.6}
    .term-cmd{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 11px;border-radius:var(--radius-sm);font-size:0.82rem;font-family:monospace;outline:none;transition:border-color .15s}
    .term-cmd:focus{border-color:var(--blue)}
    .term-run{background:var(--surface2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:var(--radius-sm);cursor:pointer;font-size:0.78rem;font-weight:500;transition:all .15s;flex-shrink:0}
    .term-run:hover{background:var(--blue);border-color:var(--blue);color:#fff}
    .term-run:disabled{opacity:.3;cursor:default}
    #cli-output{color:#86efac}
    #exec-output{color:var(--text3)}
    /* ── File tree ── */
    .tree-row{display:flex;align-items:center;padding:3px 10px;cursor:pointer;border-radius:0;user-select:none;gap:5px;transition:background .1s}
    .tree-row:hover{background:var(--surface2)}
    .tree-row.active{background:var(--blue-bg);color:var(--blue)}
    .tree-arrow{font-size:7px;color:var(--text3);transition:transform .12s;flex-shrink:0}
    .tree-arrow.open{transform:rotate(90deg)}
    .tree-icon{font-size:11px;flex-shrink:0;opacity:.7}
    .tree-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)}
    .tree-row:hover .tree-name{color:var(--text)}
    .tree-row.active .tree-name{color:var(--blue)}
    .tree-children{padding-left:14px;display:none}
    .tree-children.open{display:block}
  </style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="logo">
      <div class="logo-mark">🦞</div>
      <div>
        <div class="logo-text">ClawStack</div>
        <div class="logo-sub">OpenClaw instance manager</div>
      </div>
    </div>
    <div class="page-nav">
      <button class="page-nav-btn active" id="nav-instances"  onclick="showPage('instances')">Instances</button>
      <button class="page-nav-btn"        id="nav-system"     onclick="showPage('system')">System</button>
      <button class="page-nav-btn"        id="nav-paperclip"  onclick="showPage('paperclip')">Paperclip</button>
    </div>
  </div>

<div id="instances-page">
  <!-- New instance -->
  <div class="section">
    <div class="section-head"><span class="section-title">New instance</span></div>
    <div class="card">
      <form method="post" action="/admin/instances">
        <div class="form-grid">
          <div class="field full">
            <label>Role</label>
            <select name="role" id="role" onchange="onRoleChange(this)">
              ${Object.entries(AGENT_ROLES).map(([k, v]) => `<option value="${k}">${v.label} — ${v.description}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Name</label><input name="name" placeholder="acme" required></div>
          <div class="field">
            <label>Domain</label>
            <input name="domain" id="domain-input" placeholder="ai.acme.com" required oninput="onDomainInput(this)">
            <div id="cname-notice" class="cname-notice">
              Point DNS: <code id="cname-domain"></code> → <code>${BASE_DOMAIN || 'this-server'}</code> (CNAME)
            </div>
          </div>
          <div class="field">
            <label>Provider</label>
            <select name="provider" id="provider" onchange="onProviderChange(this)">
              ${PROVIDERS.map(p => `<option value="${p}">${p === 'private' ? 'Private LLM (self-hosted)' : p}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Model <span style="font-weight:400;color:var(--text3)">— starting model, change anytime in OpenClaw</span></label>
            <input name="model" id="model" value="${MODEL_PRESETS.openrouter}" required placeholder="provider/model-id">
          </div>
          <div class="field full"><label>OpenClaw image</label><input name="image" id="image" value="${esc(OPENCLAW_IMAGE)}" placeholder="ghcr.io/openclaw/openclaw:2026.3.24" autocomplete="off"></div>
          <div class="field full" id="baseurl-row" style="display:none"><label>Base URL</label><input name="baseUrl" id="baseUrl" type="url" placeholder="http://localhost:11434/v1" autocomplete="off"></div>
          <div class="field full" id="apikey-row"><label>API Key</label><input name="apiKey" id="apiKey" type="password" placeholder="sk-..." autocomplete="off"></div>
          <div class="full" style="margin-top:4px;display:flex;align-items:center;justify-content:space-between;gap:1rem">
            <div style="display:flex;gap:1.25rem">
              <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:0.78rem;color:var(--text3);text-transform:none;letter-spacing:0;font-weight:400">
                <input type="checkbox" name="enableA2A" value="1" style="width:auto;accent-color:var(--blue)">
                Enable A2A (agent-to-agent protocol)
              </label>
              <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:0.78rem;color:var(--text3);text-transform:none;letter-spacing:0;font-weight:400" title="Allow everything: bot acts immediately without asking (YOLO mode)">
                <input type="checkbox" name="allowAll" value="1" style="width:auto;accent-color:var(--blue)">
                Allow all actions (YOLO mode)
              </label>
            </div>
            <button type="submit" class="btn primary">Create instance</button>
          </div>
        </div>
      </form>
    </div>
  </div>

  <!-- Instances -->
  <div class="section">
    <div class="section-head">
      <span class="section-title">Instances</span>
      <span style="font-size:0.72rem;color:var(--text3)">${instances.length} total</span>
    </div>
    ${instances.length === 0
      ? '<div class="empty">No instances yet. Create one above.</div>'
      : `<div class="instances">${instances.map(i => `
      <div class="inst-card">
        <div class="inst-main">
          <div class="inst-name">
            ${esc(i.name)}
            <span class="badge ${i.status}" id="badge-${i.name}">${i.status}</span>
            ${i.role && i.role !== 'generalist' ? `<span class="badge role">${esc(i.role)}</span>` : ''}
          </div>
          ${i.liveModel ? `<div class="inst-meta">${esc(i.liveModel)}</div>` : ''}
          <div class="inst-meta" title="${esc(i.image || OPENCLAW_IMAGE)}">${esc((i.image || OPENCLAW_IMAGE).split(':')[1] || (i.image || OPENCLAW_IMAGE))}</div>
        </div>
        <a class="inst-domain" href="https://${esc(i.domain)}" target="_blank">${esc(i.domain)}</a>
        <div class="inst-token">
          <span class="tok-val" id="tok-${i.name}" title="Click to copy" onclick="copyToken('${esc(i.token)}','${esc(i.name)}')">${i.token.slice(0,18)}…</span>
          <button class="copy-btn" onclick="copyToken('${esc(i.token)}','${esc(i.name)}')" title="Copy token">⎘</button>
        </div>
        <div class="divider"></div>
        <div class="inst-actions">
          <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','files','${esc(i.image || OPENCLAW_IMAGE)}')">Files</button>
          <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','logs','${esc(i.image || OPENCLAW_IMAGE)}')">Logs</button>
          <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','cli','${esc(i.image || OPENCLAW_IMAGE)}')">CLI</button>
          <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','version','${esc(i.image || OPENCLAW_IMAGE)}')">Version</button>
          <div class="divider"></div>
          <button class="btn amber sm" onclick="rowAction('${esc(i.name)}','restart')" title="Restart">↺</button>
          <button class="btn ghost sm" id="stopstart-${i.name}" onclick="rowAction('${esc(i.name)}','${i.status === 'running' ? 'stop' : 'start'}')">${i.status === 'running' ? '■' : '▶'}</button>
          <form method="post" action="/admin/instances/${esc(i.name)}/delete" style="margin:0">
            <button type="submit" class="btn danger sm" onclick="return confirm('Delete ${esc(i.name)}?')">✕</button>
          </form>
        </div>
      </div>`).join('')}</div>`}
  </div>
</div><!-- /instances-page -->

<!-- ══ System page ══ -->
<div id="system-page" style="display:none">
  <div class="sys-grid">
    <div class="stat-card">
      <div class="ring-wrap">
        <svg class="ring-svg" viewBox="0 0 36 36">
          <circle class="ring-track" cx="18" cy="18" r="15.9"/>
          <circle class="ring-prog" id="ring-cpu" cx="18" cy="18" r="15.9" stroke="var(--blue)"
            stroke-dasharray="0 100" stroke-dashoffset="0"/>
        </svg>
        <div class="ring-val" id="ring-cpu-val">—</div>
      </div>
      <div class="stat-info">
        <div class="stat-label">CPU</div>
        <div class="stat-main" id="stat-cpu-main">—</div>
        <div class="stat-sub" id="stat-cpu-sub">usage</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="ring-wrap">
        <svg class="ring-svg" viewBox="0 0 36 36">
          <circle class="ring-track" cx="18" cy="18" r="15.9"/>
          <circle class="ring-prog" id="ring-mem" cx="18" cy="18" r="15.9" stroke="var(--green)"
            stroke-dasharray="0 100" stroke-dashoffset="0"/>
        </svg>
        <div class="ring-val" id="ring-mem-val">—</div>
      </div>
      <div class="stat-info">
        <div class="stat-label">Memory</div>
        <div class="stat-main" id="stat-mem-main">—</div>
        <div class="stat-sub" id="stat-mem-sub">of total</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="ring-wrap">
        <svg class="ring-svg" viewBox="0 0 36 36">
          <circle class="ring-track" cx="18" cy="18" r="15.9"/>
          <circle class="ring-prog" id="ring-disk" cx="18" cy="18" r="15.9" stroke="var(--amber)"
            stroke-dasharray="0 100" stroke-dashoffset="0"/>
        </svg>
        <div class="ring-val" id="ring-disk-val">—</div>
      </div>
      <div class="stat-info">
        <div class="stat-label">Disk</div>
        <div class="stat-main" id="stat-disk-main">—</div>
        <div class="stat-sub" id="stat-disk-sub">of total</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-title">Containers</span>
      <span class="sys-refresh" id="sys-refresh-ts"></span>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div class="ct-head">
        <div>Name</div><div>Status</div><div>CPU</div><div>Memory</div><div>Image</div>
      </div>
      <div id="ct-body"></div>
    </div>
  </div>
  <div class="section">
    <div class="section-head"><span class="section-title">Stack config</span></div>
    <div class="card" style="padding:0;overflow:hidden">
      <div class="cfg-tabs">
        <button class="cfg-tab active" id="cfg-tab-env"          onclick="cfgLoad('.env')">          .env</button>
        <button class="cfg-tab"        id="cfg-tab-compose"      onclick="cfgLoad('docker-compose.yml')">docker-compose.yml</button>
        <button class="cfg-tab"        id="cfg-tab-caddyfile"    onclick="cfgLoad('Caddyfile')">     Caddyfile</button>
        <button class="cfg-tab"        id="cfg-tab-clawdefaults" onclick="cfgLoad('claw-defaults')"> Claw defaults</button>
      </div>
      <textarea id="cfg-editor" class="cfg-editor" spellcheck="false"></textarea>
      <div class="cfg-footer">
        <button class="btn sm" onclick="cfgSave()" id="cfg-save-btn">Save</button>
        <span id="cfg-status" style="font-size:0.75rem;color:var(--text3)"></span>
        <span style="flex:1"></span>
        <span id="cfg-footer-hint" style="font-size:0.7rem;color:var(--text3)">Changes to compose/.env require <code style="color:var(--text2)">docker compose up -d</code> to take effect</span>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-head"><span class="section-title">Images</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span id="sys-images-total" class="sys-refresh"></span>
        <button class="btn danger sm" onclick="pruneImages()" id="prune-btn">Prune unused</button>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table class="img-table">
        <thead><tr><th>Repository</th><th>Tag</th><th>Size</th><th>Status</th></tr></thead>
        <tbody id="img-body"></tbody>
      </table>
    </div>
    <div id="prune-result" style="display:none;margin-top:.5rem;font-size:0.78rem;color:var(--green)"></div>
  </div>

</div><!-- /system-page -->

<!-- ══ Paperclip page ══ -->
<div id="paperclip-page" style="display:none">

  <div class="pp-status-row">
    <div class="pp-status-card">
      <div class="pp-status-label">Paperclip</div>
      <div class="pp-status-val"><span class="pp-dot" id="pp-dot-app"></span><span id="pp-val-app">—</span></div>
      <div class="pp-sub" id="pp-sub-app"></div>
    </div>
    <div class="pp-status-card">
      <div class="pp-status-label">Database</div>
      <div class="pp-status-val"><span class="pp-dot" id="pp-dot-db"></span><span id="pp-val-db">—</span></div>
      <div class="pp-sub" id="pp-sub-db"></div>
    </div>
    <div class="pp-status-card">
      <div class="pp-status-label">API</div>
      <div class="pp-status-val"><span class="pp-dot" id="pp-dot-api"></span><span id="pp-val-api">—</span></div>
      <div class="pp-sub" id="pp-sub-api"></div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-title">Instances</span>
      <button class="btn ghost sm" onclick="ppFix()" id="pp-fix-btn">Run Fix</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table class="pp-inst-table">
        <thead><tr><th>Instance</th><th>Paperclip</th><th>Last heartbeat</th><th>Action</th></tr></thead>
        <tbody id="pp-inst-body"><tr><td colspan="4" style="color:var(--text3);padding:2rem;text-align:center">Loading…</td></tr></tbody>
      </table>
    </div>
    <div id="pp-fix-results" style="margin-top:.75rem;display:none" class="card"></div>
  </div>

  <div class="section" id="pp-agents-section" style="display:none">
    <div class="section-head"><span class="section-title">Connected agents</span></div>
    <div class="card" style="padding:0;overflow:hidden">
      <table class="pp-agents-table">
        <thead><tr><th>Name</th><th>Role</th><th>Gateway URL</th><th>Last heartbeat</th></tr></thead>
        <tbody id="pp-agents-body"></tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-title">Ask Claude</span>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div class="term-panel" style="display:flex;flex-direction:column">
        <div id="pp-claude-output" class="term-output" style="color:#93c5fd"># Claude Code (node user, --print mode)\n</div>
        <div class="term-input-row" style="gap:8px;align-items:flex-start">
          <span class="term-prefix" style="color:#4ade80;margin-top:7px">$</span>
          <textarea id="pp-claude-prompt" rows="2" style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 11px;border-radius:var(--radius-sm);font-size:0.82rem;font-family:monospace;outline:none;resize:vertical;line-height:1.4"
            placeholder="Ask Claude something…"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();ppRunClaude()}"></textarea>
          <button class="term-run" style="margin-top:1px" onclick="ppRunClaude()">Ask</button>
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-title">Paperclip terminal</span>
      <button class="btn ghost sm" onclick="ppLoadLogs()">↻ Logs</button>
      <button class="btn ghost sm" onclick="ppRestart()" id="pp-restart-btn">↺ Restart & reload .env</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div class="term-panel" style="display:flex;flex-direction:column">
        <div class="term-hints">
          <button onclick="ppShortcut('which claude && claude --version || echo not installed','node')" title="Check if Claude CLI is installed">claude version</button>
          <button onclick="ppShortcut('curl -fsSL https://claude.ai/install.sh | bash 2>&1','node')" title="Install Claude Code CLI to ~/.claude (persistent)">install claude cli</button>
          <button onclick="ppShortcut('claude --dangerously-skip-permissions --add-mcp paperclip 2>&1 || echo See Paperclip UI → Add agent → Claude Code','node')" title="Register as Claude Code agent in Paperclip">add claude agent</button>
          <button onclick="ppShortcut('cat ~/.bashrc | grep ANTHROPIC || echo no private LLM configured','node')" title="Check private LLM config">check llm config</button>
          <button onclick="ppShortcut('curl -fsSL https://opencode.ai/install | bash && chown -R node:node /paperclip/.opencode /paperclip/.cache/opencode /paperclip/.local && echo PATH=/paperclip/.opencode/bin:\\$PATH >> /paperclip/.bashrc && echo done','root')" title="Install opencode and fix permissions">install opencode</button>
          <button onclick="ppShortcut('export PATH=/paperclip/.opencode/bin:$PATH && opencode --version 2>&1 || echo not installed','node')" title="Check opencode version">opencode version</button>
          <button onclick="ppLoadLogs()">show logs</button>
        </div>
        <div id="pp-exec-output" class="term-output"># Paperclip container shell\n</div>
        <div class="term-input-row">
          <select id="pp-exec-user" onchange="ppUpdatePrompt()" style="background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:4px;padding:2px 4px;font-size:11px;cursor:pointer;width:auto;flex-shrink:0">
            <option value="root">root</option>
            <option value="node">node</option>
          </select>
          <span id="pp-exec-prefix" class="term-prefix" style="color:#f87171">#</span>
          <input id="pp-exec-cmd" class="term-cmd" placeholder="npm install -g @anthropic-ai/claude-code" autocomplete="off" spellcheck="false"
            onkeydown="if(event.key==='Enter') ppRunExec()">
          <button class="term-run" onclick="ppRunExec()">Run</button>
        </div>
      </div>
    </div>
  </div>

</div><!-- /paperclip-page -->

</div><!-- /page -->

<!-- ══ Manager Modal ══ -->
<div id="mgr">
  <div id="mgr-bar">
    <button class="back" onclick="closeMgr()">← Back</button>
    <span class="inst-label" id="mgr-title"></span>
    <span id="mgr-badge" class="badge" style="margin-left:2px"></span>
    <div class="spacer"></div>
    <div class="bar-actions">
      <button class="btn amber sm" onclick="mgrAction('restart')">Restart</button>
      <button class="btn danger sm" onclick="mgrAction('stop')">Stop</button>
      <button class="btn green sm"  onclick="mgrAction('start')">Start</button>
      <span id="mgr-action-status"></span>
    </div>
  </div>
  <div id="mgr-tabs">
    <div class="tab active" id="tab-files"   onclick="switchTab('files')">Files</div>
    <div class="tab"        id="tab-logs"    onclick="switchTab('logs')">Logs</div>
    <div class="tab"        id="tab-chat"    onclick="switchTab('chat')">Chat</div>
    <div class="tab"        id="tab-model"   onclick="switchTab('model')">Model</div>
    <div class="tab"        id="tab-cli"     onclick="switchTab('cli')">CLI</div>
    <div class="tab"        id="tab-exec"    onclick="switchTab('exec')">Exec (root)</div>
    <div class="tab"        id="tab-version" onclick="switchTab('version')">Version</div>
  </div>
  <div id="mgr-body">
    <div id="mgr-tree"></div>
    <div id="mgr-right">
      <div id="mgr-crumb">—</div>
      <textarea id="mgr-editor" spellcheck="false" placeholder="Select a file from the tree…"></textarea>
      <pre id="mgr-logs"></pre>

      <!-- CLI panel -->
      <div id="mgr-cli" class="term-panel">
        <div class="term-hints">
          <button onclick="cliShortcut('openclaw plugins list')">plugins list</button>
          <button onclick="cliShortcut('openclaw plugins install ')">plugins install …</button>
          <button onclick="cliShortcut('openclaw config get')">config get</button>
          <button onclick="cliShortcut('openclaw doctor')">doctor</button>
          <button onclick="cliShortcut('openclaw --version')">version</button>
          <button onclick="cliShortcut('npx playwright install chromium')" title="Download Chromium (~170 MB) — required for browser tool">install browser</button>
        </div>
        <div id="cli-output" class="term-output"># OpenClaw CLI — node user (uid 1000)\n</div>
        <div class="term-input-row">
          <span class="term-prefix" style="color:#86efac">$</span>
          <input id="cli-cmd" class="term-cmd" placeholder="openclaw plugins install @openclaw/voice-call" autocomplete="off" spellcheck="false">
          <button id="cli-run" class="term-run" onclick="runCli()">Run</button>
        </div>
      </div>

      <!-- Exec panel -->
      <div id="mgr-exec" class="term-panel">
        <div id="exec-output" class="term-output"># Root shell — docker exec --user root\n</div>
        <div class="term-input-row">
          <span class="term-prefix" style="color:#f87171">#</span>
          <input id="exec-cmd" class="term-cmd" placeholder="apt-get install -y curl" autocomplete="off" spellcheck="false">
          <button id="exec-run" class="term-run" onclick="runExec()">Run</button>
        </div>
      </div>

      <!-- Version panel -->
      <div id="mgr-version" class="term-panel" style="padding:1.5rem 2rem;gap:1.25rem;overflow-y:auto">
        <div>
          <div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Current image</div>
          <code id="version-current" style="font-size:0.82rem;color:var(--text2);background:var(--surface2);padding:4px 10px;border-radius:4px;display:inline-block"></code>
        </div>
        <div>
          <div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">New version tag</div>
          <div style="display:flex;align-items:center;gap:0;max-width:520px">
            <span id="version-base" style="font-size:0.82rem;color:var(--text3);background:var(--surface2);border:1px solid var(--border);border-right:none;padding:6px 10px;border-radius:var(--radius-sm) 0 0 var(--radius-sm);white-space:nowrap;font-family:monospace"></span>
            <input id="version-input" class="term-cmd" style="border-radius:0 var(--radius-sm) var(--radius-sm) 0;min-width:0;flex:1" placeholder="2026.4.2" autocomplete="off" spellcheck="false">
          </div>
          <div style="font-size:0.7rem;color:var(--text3);margin-top:5px">Enter just the version tag, e.g. <code style="color:var(--text2)">2026.4.2</code> or <code style="color:var(--text2)">latest</code></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <button id="version-btn" class="btn primary sm" onclick="recreateInstance()">Pull &amp; Recreate</button>
          <span id="version-status" style="font-size:0.75rem;color:var(--text3)"></span>
        </div>
        <div style="font-size:0.72rem;color:var(--text3);line-height:1.6;max-width:520px;padding:8px 12px;background:var(--surface2);border-radius:5px;border:1px solid var(--border)">
          Pulls the image, stops the container, removes it, and starts a fresh one with the same config and data. The API key is preserved from the existing container.
        </div>
      </div>

      <!-- Chat panel -->
      <div id="mgr-chat" style="display:none;flex-direction:column;height:100%;overflow:hidden">
        <div id="chat-messages" style="flex:1;overflow-y:auto;padding:1rem 1.5rem;display:flex;flex-direction:column;gap:0.75rem"></div>
        <div style="padding:0.75rem 1rem;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end">
          <textarea id="chat-input" rows="2" placeholder="Message…" spellcheck="true"
            style="flex:1;resize:none;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:0.85rem;font-family:inherit;line-height:1.4"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"></textarea>
          <button class="btn primary sm" onclick="sendChat()" id="chat-send" style="align-self:flex-end">Send</button>
        </div>
      </div>

      <!-- Model panel -->
      <div id="mgr-model" class="term-panel" style="padding:1.5rem 2rem;gap:1.25rem;overflow-y:auto">
        <div style="display:flex;flex-direction:column;gap:1rem;max-width:520px">
          <div>
            <div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Provider</div>
            <select id="model-provider" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:0.85rem" onchange="onModelProviderChange()">
              <option value="openrouter">OpenRouter</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="private">Private LLM</option>
            </select>
          </div>
          <div id="model-baseurl-row" style="display:none">
            <div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Base URL</div>
            <input id="model-baseurl" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:0.85rem;box-sizing:border-box" placeholder="https://your-llm-host/v1" autocomplete="off">
          </div>
          <div>
            <div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Model</div>
            <input id="model-name" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:0.85rem;box-sizing:border-box" placeholder="e.g. openai/gpt-4o" autocomplete="off" spellcheck="false">
            <div style="font-size:0.7rem;color:var(--text3);margin-top:4px">Full model ID as used by the provider</div>
          </div>
          <div>
            <div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">API Key</div>
            <input id="model-apikey" type="password" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:0.85rem;box-sizing:border-box" placeholder="Leave blank to keep existing" autocomplete="off">
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn primary sm" onclick="saveModel()">Save &amp; Restart</button>
            <span id="model-status" style="font-size:0.75rem;color:var(--text3)"></span>
          </div>
          <div style="font-size:0.72rem;color:var(--text3);line-height:1.6;padding:8px 12px;background:var(--surface2);border-radius:5px;border:1px solid var(--border)">
            Updates <code style="color:var(--text2)">openclaw.json</code> and restarts the container. The new model takes effect immediately.
          </div>
        </div>
      </div>

      <div id="mgr-footer">
        <button id="btn-save" class="btn sm" onclick="saveFile()" disabled>Save</button>
        <button id="btn-refresh-logs" class="btn ghost sm" style="display:none" onclick="loadLogs()">↻ Refresh</button>
        <button id="btn-copy-logs"   class="btn ghost sm" style="display:none" onclick="copyLogs()">⎘ Copy</button>
        <button id="btn-backup"  class="btn ghost sm" style="display:none" onclick="downloadBackup()">⬇ Backup</button>
        <button id="btn-restore" class="btn ghost sm" style="display:none" onclick="document.getElementById('restore-input').click()">⬆ Restore</button>
        <input id="restore-input" type="file" accept=".tar.gz,.tgz" style="display:none" onchange="uploadRestore(this)">
        <span id="mgr-status"></span>
      </div>
    </div>
  </div>
</div>

  <script>
    const presets   = ${JSON.stringify(MODEL_PRESETS)};
    const noKeyProviders = ${JSON.stringify([...NO_KEY_PROVIDERS])};
    const agentRoles = ${JSON.stringify(Object.fromEntries(Object.entries(AGENT_ROLES).map(([k,v]) => [k, { label: v.label, description: v.description }])))};
    const __auth    = ${authHeader};

    function onRoleChange(s){
      const role = agentRoles[s.value];
      const hint = document.getElementById('role-hint');
      if(hint) hint.textContent = role ? role.description : '';
      // Auto-enable A2A for non-generalist roles
      const a2aBox = document.querySelector('input[name="enableA2A"]');
      if(a2aBox) a2aBox.checked = s.value !== 'generalist';
    }

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
    let mgrName=null, mgrPath=null, mgrTab='files', mgrImage=null;

    function openMgr(name,tab='files',image=''){
      mgrName=name;mgrPath=null;mgrImage=image;
      document.getElementById('mgr-title').textContent=name;
      document.getElementById('mgr-editor').value='';
      document.getElementById('btn-save').disabled=true;
      document.getElementById('mgr-status').textContent='';
      document.getElementById('mgr-tree').innerHTML='';
      document.getElementById('chat-messages').innerHTML='';
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
      ['files','logs','cli','exec','version','model','chat'].forEach(t=>document.getElementById('tab-'+t).className='tab'+(tab===t?' active':''));
      document.getElementById('mgr-editor').style.display=tab==='files'?'':'none';
      document.getElementById('mgr-logs').style.display=tab==='logs'?'block':'none';
      document.getElementById('mgr-cli').style.display=tab==='cli'?'flex':'none';
      document.getElementById('mgr-exec').style.display=tab==='exec'?'flex':'none';
      document.getElementById('mgr-version').style.display=tab==='version'?'flex':'none';
      document.getElementById('mgr-model').style.display=tab==='model'?'flex':'none';
      document.getElementById('mgr-chat').style.display=tab==='chat'?'flex':'none';
      document.getElementById('btn-save').style.display=tab==='files'?'':'none';
      document.getElementById('btn-refresh-logs').style.display=tab==='logs'?'':'none';
      document.getElementById('btn-copy-logs').style.display=tab==='logs'?'':'none';
      document.getElementById('btn-backup').style.display=tab==='files'?'':'none';
      document.getElementById('btn-restore').style.display=tab==='files'?'':'none';
      document.getElementById('mgr-tree').style.display=tab==='files'?'':'none';
      if(tab==='files'){
        if(!document.getElementById('mgr-tree').children.length) loadTree('');
        document.getElementById('mgr-crumb').textContent=mgrPath||'Select a file';
      } else if(tab==='logs'){
        document.getElementById('mgr-crumb').textContent='Container logs (last 300 lines)';
        loadLogs();
      } else if(tab==='cli'){
        document.getElementById('mgr-crumb').textContent='OpenClaw CLI (node user)';
        setTimeout(()=>document.getElementById('cli-cmd').focus(),50);
      } else if(tab==='version'){
        document.getElementById('mgr-crumb').textContent='OpenClaw version management';
        document.getElementById('version-current').textContent=mgrImage||'unknown';
        const colonIdx=(mgrImage||'').lastIndexOf(':');
        const imgBase=colonIdx>0?(mgrImage||'').slice(0,colonIdx+1):'';
        const imgTag=colonIdx>0?(mgrImage||'').slice(colonIdx+1):(mgrImage||'');
        document.getElementById('version-base').textContent=imgBase;
        document.getElementById('version-input').value=imgTag;
        document.getElementById('version-status').textContent='';
      } else if(tab==='model'){
        document.getElementById('mgr-crumb').textContent='Model configuration';
        loadModel();
      } else if(tab==='chat'){
        document.getElementById('mgr-crumb').textContent='Chat';
      } else {
        document.getElementById('mgr-crumb').textContent='Root shell (docker exec --user root)';
      }
    }

    // ── Chat ──
    const chatHistory = {}; // keyed by instance name
    let chatStreaming = false;

    function chatAddBubble(role, text, streaming=false){
      const msgs = document.getElementById('chat-messages');
      const wrap = document.createElement('div');
      wrap.className = 'chat-msg';
      const label = document.createElement('div');
      label.className = 'chat-role';
      label.textContent = role === 'user' ? 'You' : mgrName;
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble ' + role + (streaming?' streaming':'');
      bubble.textContent = text;
      wrap.appendChild(label);
      wrap.appendChild(bubble);
      msgs.appendChild(wrap);
      msgs.scrollTop = msgs.scrollHeight;
      return bubble;
    }

    async function sendChat(){
      if(chatStreaming) return;
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if(!text) return;
      input.value='';

      if(!chatHistory[mgrName]) chatHistory[mgrName]=[];
      chatHistory[mgrName].push({role:'user', content: text});
      chatAddBubble('user', text);

      const bubble = chatAddBubble('assistant','', true);
      chatStreaming = true;
      document.getElementById('chat-send').disabled = true;

      let accumulated = '';
      try {
        const resp = await fetch('/api/instances/'+mgrName+'/chat', {
          method:'POST',
          headers:{Authorization:__auth,'Content-Type':'application/json'},
          body: JSON.stringify({messages: chatHistory[mgrName]}),
        });
        if(!resp.ok || !resp.body) throw new Error('HTTP '+resp.status);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while(true){
          const {done, value} = await reader.read();
          if(done) break;
          buf += decoder.decode(value, {stream:true});
          const lines = buf.split('\\n');
          buf = lines.pop();
          for(const line of lines){
            if(!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if(raw === '[DONE]') continue;
            try {
              const ev = JSON.parse(raw);
              if(ev.type === 'response.output_text.delta' && ev.delta){
                accumulated += ev.delta;
                bubble.textContent = accumulated;
                document.getElementById('chat-messages').scrollTop = 999999;
              } else if(ev.type === 'response.output_text.done' && ev.text && !accumulated){
                accumulated = ev.text;
                bubble.textContent = accumulated;
              }
            } catch {}
          }
        }
      } catch(e) {
        accumulated = '(Error: ' + e.message + ')';
        bubble.textContent = accumulated;
      }

      bubble.classList.remove('streaming');
      chatStreaming = false;
      document.getElementById('chat-send').disabled = false;
      if(accumulated) chatHistory[mgrName].push({role:'assistant', content: accumulated});
      input.focus();
    }

    function onModelProviderChange(){
      const p=document.getElementById('model-provider').value;
      document.getElementById('model-baseurl-row').style.display=p==='private'?'':'none';
    }

    async function loadModel(){
      const st=document.getElementById('model-status');
      st.textContent='Loading…';
      const d=await api('GET','/api/instances/'+mgrName+'/model');
      if(d.error){st.textContent='Error: '+d.error;return;}
      st.textContent='';
      document.getElementById('model-provider').value=d.provider||'openrouter';
      document.getElementById('model-name').value=d.model||'';
      document.getElementById('model-baseurl').value=d.baseUrl||'';
      document.getElementById('model-apikey').placeholder=d.hasApiKey?'Leave blank to keep existing key':'sk-...';
      onModelProviderChange();
    }

    async function saveModel(){
      const st=document.getElementById('model-status');
      const provider=document.getElementById('model-provider').value;
      const model=document.getElementById('model-name').value.trim();
      const apiKey=document.getElementById('model-apikey').value.trim();
      const baseUrl=document.getElementById('model-baseurl').value.trim();
      if(!model){st.textContent='Model is required';return;}
      st.textContent='Saving & restarting…';
      const d=await api('POST','/api/instances/'+mgrName+'/model',{provider,model,apiKey,baseUrl});
      if(d.error){st.style.color='var(--red)';st.textContent='Error: '+d.error;return;}
      st.style.color='var(--green)';st.textContent='Saved ✓ — restarting…';
      setTimeout(async()=>{await refreshMgrBadge();st.textContent='';st.style.color='';},3000);
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

    function downloadBackup(){
      const a=document.createElement('a');
      a.href='/api/instances/'+mgrName+'/backup';
      a.download=mgrName+'-backup.tar.gz';
      // Attach auth header via fetch + blob since Basic auth isn't sent with <a>
      const st=document.getElementById('mgr-status');
      st.textContent='Preparing backup…';
      fetch(a.href,{headers:{Authorization:__auth}})
        .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.blob();})
        .then(blob=>{
          const url=URL.createObjectURL(blob);
          a.href=url;a.click();URL.revokeObjectURL(url);
          st.textContent='';
        }).catch(e=>{st.textContent='Backup failed: '+e.message;});
    }

    async function uploadRestore(input){
      const file=input.files[0];input.value='';
      if(!file) return;
      const st=document.getElementById('mgr-status');
      if(!confirm('Restore will stop the container, replace all files, then restart. Continue?')) return;
      st.textContent='Uploading…';
      try {
        const r=await fetch('/api/instances/'+mgrName+'/restore',{method:'POST',headers:{Authorization:__auth,'Content-Type':'application/octet-stream'},body:file});
        const d=await r.json();
        if(d.success){
          st.textContent='Restored ✓ — restarting…';
          document.getElementById('mgr-tree').innerHTML='';
          setTimeout(()=>{loadTree('');refreshMgrBadge();st.textContent='';},2500);
        } else { st.textContent='Restore failed: '+d.error; }
      } catch(e){ st.textContent='Restore failed: '+e.message; }
    }

    async function copyLogs(){
      const txt=document.getElementById('mgr-logs').textContent;
      if(!txt) return;
      await navigator.clipboard.writeText(txt);
      const btn=document.getElementById('btn-copy-logs');
      btn.textContent='✓ Copied';
      setTimeout(()=>btn.textContent='⎘ Copy',2000);
    }

    async function loadLogs(){
      const el=document.getElementById('mgr-logs');
      el.textContent='Loading…';
      const d=await api('GET','/api/instances/'+mgrName+'/logs');
      el.textContent=d.error?('Error: '+d.error):(d.logs||'(no logs)');
      el.scrollTop=el.scrollHeight;
    }

    // ── CLI tab ──
    const cliHistory=[];
    let cliHistIdx=-1;
    document.addEventListener('DOMContentLoaded',()=>{
      document.getElementById('cli-cmd').addEventListener('keydown',e=>{
        if(e.key==='Enter'){runCli();return;}
        if(e.key==='ArrowUp'){e.preventDefault();if(cliHistIdx<cliHistory.length-1){cliHistIdx++;e.target.value=cliHistory[cliHistory.length-1-cliHistIdx]||'';}}
        if(e.key==='ArrowDown'){e.preventDefault();if(cliHistIdx>0){cliHistIdx--;e.target.value=cliHistory[cliHistory.length-1-cliHistIdx]||'';}else{cliHistIdx=-1;e.target.value='';}}
      });
    });

    function cliShortcut(cmd){
      const inp=document.getElementById('cli-cmd');
      inp.value=cmd;
      inp.focus();
      inp.setSelectionRange(cmd.length,cmd.length);
    }

    async function runCli(){
      const inp=document.getElementById('cli-cmd');
      const out=document.getElementById('cli-output');
      const btn=document.getElementById('cli-run');
      const cmd=inp.value.trim();
      if(!cmd) return;
      cliHistory.push(cmd); cliHistIdx=-1;
      inp.value='';
      btn.disabled=true;
      out.textContent+='\\n$ '+cmd+'\\n';
      out.scrollTop=out.scrollHeight;
      const d=await api('POST','/api/instances/'+mgrName+'/cli',{cmd});
      if(d.error){ out.textContent+='[error] '+d.error+'\\n'; }
      else {
        out.textContent+=(d.output||'(no output)');
        if(d.exitCode!==0) out.textContent+='[exit '+d.exitCode+']\\n';
      }
      out.scrollTop=out.scrollHeight;
      btn.disabled=false;
      inp.focus();
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

    async function recreateInstance(){
      const tag=document.getElementById('version-input').value.trim();
      if(!tag){document.getElementById('version-status').textContent='Enter a version tag first';return;}
      const base=document.getElementById('version-base').textContent;
      // If user typed a full image ref (contains /), use as-is; otherwise combine base + tag
      const image=(tag.includes('/')||!base)?tag:base+tag;
      const btn=document.getElementById('version-btn');
      const st=document.getElementById('version-status');
      btn.disabled=true;
      st.textContent='Pulling image… this may take a minute';
      const d=await api('POST','/api/instances/'+mgrName+'/recreate',{image});
      btn.disabled=false;
      if(d.error){
        st.textContent='Error: '+d.error;
        st.style.color='var(--red)';
      } else {
        mgrImage=d.image;
        document.getElementById('version-current').textContent=d.image;
        st.textContent='Done — container running new image';
        st.style.color='var(--green)';
        await refreshMgrBadge();
        // Update badge on main list too
        const badge=document.getElementById('badge-'+mgrName);
        if(badge){const s=await api('GET','/api/instances/'+mgrName+'/status');badge.textContent=s.status;badge.className='badge '+(s.status||'error');}
        setTimeout(()=>{st.textContent='';st.style.color='';},4000);
      }
    }

    // ── Page navigation ──
    let sysTimer = null;
    let ppTimer  = null;

    function showPage(name) {
      ['instances','system','paperclip'].forEach(p => {
        document.getElementById(p + '-page').style.display = name === p ? '' : 'none';
        document.getElementById('nav-' + p).classList.toggle('active', name === p);
      });
      clearInterval(sysTimer); clearInterval(ppTimer);
      if (name === 'system')    { loadSystem(); cfgLoad('.env'); sysTimer = setInterval(loadSystem, 5000); }
      if (name === 'paperclip') { loadPaperclip();  ppTimer  = setInterval(loadPaperclip, 8000); }
    }

    // ── Paperclip page ──
    function fmtHB(secondsAgo) {
      if (secondsAgo === null || secondsAgo === undefined) return '<span style="color:var(--text3)">never</span>';
      if (secondsAgo < 120)  return '<span style="color:var(--green)">' + secondsAgo + 's ago</span>';
      if (secondsAgo < 3600) return '<span style="color:var(--amber)">' + Math.round(secondsAgo/60) + 'm ago</span>';
      return '<span style="color:var(--red)">' + Math.round(secondsAgo/3600) + 'h ago</span>';
    }

    async function loadPaperclip() {
      let d;
      try { d = await api('GET', '/api/paperclip/status'); } catch { return; }

      // Status cards
      const setCard = (id, running, status, sub) => {
        const dot = document.getElementById('pp-dot-' + id);
        dot.className = 'pp-dot ' + (running ? 'ok' : 'err');
        document.getElementById('pp-val-' + id).textContent = status;
        document.getElementById('pp-sub-' + id).textContent = sub || '';
      };
      setCard('app', d.paperclip.running, d.paperclip.running ? 'Running' : d.paperclip.status);
      setCard('db',  d.db.running,        d.db.running  ? 'Running' : d.db.status);
      setCard('api', !!d.api, d.api ? d.api.status : 'unreachable', d.api?.deploymentMode || '');
      if (d.api) document.getElementById('pp-dot-api').className = 'pp-dot ' + (d.api.status === 'ok' ? 'ok' : 'warn');

      // Instances table
      const instBody = document.getElementById('pp-inst-body');
      if (!d.instances.length) {
        instBody.innerHTML = '<tr><td colspan="4" style="color:var(--text3);padding:1.5rem;text-align:center">No instances found.</td></tr>';
      } else {
        instBody.innerHTML = d.instances.map(inst => {
          const isPending = d.pending.some(p => p.claw_name === inst.name);
          let statusCell, actionCell;
          if (inst.connected) {
            statusCell = '<span class="badge running">Connected</span>';
            actionCell = \`<button class="btn ghost xs" onclick="ppDisconnect('\${inst.name}')">Disconnect</button>\`;
          } else if (isPending) {
            statusCell = '<span class="badge starting">Awaiting approval</span>';
            actionCell = \`<button class="btn green xs" onclick="ppFinalize('\${inst.name}')">Finalize</button>\`;
          } else {
            statusCell = '<span class="badge stopped">Not connected</span>';
            actionCell = \`<div class="pp-invite-row">
              <input id="invite-\${inst.name}" placeholder="pcp_invite_…" style="font-size:0.75rem">
              <button class="btn sm" onclick="ppConnect('\${inst.name}')">Connect</button>
            </div>\`;
          }
          const hb = inst.agent ? fmtHB(inst.agent.secondsAgo) : '<span style="color:var(--text3)">—</span>';
          return \`<tr>
            <td style="font-weight:500">\${inst.name}</td>
            <td>\${statusCell}</td>
            <td class="pp-hb">\${hb}</td>
            <td>\${actionCell}</td>
          </tr>\`;
        }).join('');
      }

      // Agents section
      if (d.agents.length) {
        document.getElementById('pp-agents-section').style.display = '';
        document.getElementById('pp-agents-body').innerHTML = d.agents.map(a => \`<tr>
          <td style="font-weight:500">\${a.name}</td>
          <td><span class="badge role">\${a.role || '—'}</span></td>
          <td style="font-size:0.72rem;color:var(--text3);font-family:monospace">\${a.url || '—'}</td>
          <td class="pp-hb">\${fmtHB(a.secondsAgo)}</td>
        </tr>\`).join('');
      } else {
        document.getElementById('pp-agents-section').style.display = 'none';
      }
    }

    async function ppConnect(clawName) {
      const token = document.getElementById('invite-' + clawName)?.value?.trim();
      if (!token) { alert('Paste an invite token first.'); return; }
      const d = await api('POST', '/api/paperclip/connect', { clawName, inviteToken: token });
      if (d.error) { alert('Error: ' + d.error + (d.detail ? '\\n' + JSON.stringify(d.detail) : '')); return; }
      alert('Join request sent for ' + d.agentName + '.\\n\\nNow approve it in Paperclip UI (boss.froste.eu → Company Settings → Join requests), then click Finalize.');
      loadPaperclip();
    }

    async function ppFinalize(clawName) {
      const d = await api('POST', '/api/paperclip/finalize/' + clawName);
      if (d.error) { alert('Error: ' + d.error); return; }
      const stepLog = (d.steps || []).map(s => (s.ok ? '✓' : '✗') + ' ' + s.msg).join('\\n');
      alert('Done!\\n\\n' + stepLog);
      loadPaperclip();
    }

    async function ppDisconnect(clawName) {
      if (!confirm('Remove Paperclip connection from ' + clawName + '?\\nThis only removes local files, not the Paperclip agent record.')) return;
      await api('POST', '/api/instances/' + clawName + '/exec', { cmd: 'rm -f /home/node/.openclaw/workspace/paperclip-claimed-api-key.json' });
      loadPaperclip();
    }

    async function ppFix() {
      const btn = document.getElementById('pp-fix-btn');
      btn.disabled = true; btn.textContent = 'Running…';
      const d = await api('POST', '/api/paperclip/fix');
      btn.disabled = false; btn.textContent = 'Run Fix';
      const el = document.getElementById('pp-fix-results');
      el.style.display = '';
      el.innerHTML = (d.results || []).map(r =>
        \`<div class="pp-fix-result">
          <span class="pp-fix-label">Fix \${r.fix}: \${r.label}</span>
          <span class="pp-fix-msg \${r.error ? 'error' : r.changed ? 'changed' : ''}">\${r.msg}</span>
        </div>\`
      ).join('');
      loadPaperclip();
    }

    // ── Paperclip terminal ──
    function ppUpdatePrompt(){
      const user=document.getElementById('pp-exec-user').value;
      const prefix=document.getElementById('pp-exec-prefix');
      prefix.textContent = user==='node' ? '$' : '#';
      prefix.style.color = user==='node' ? '#4ade80' : '#f87171';
    }
    function ppShortcut(cmd, user){
      if(user) document.getElementById('pp-exec-user').value=user;
      ppUpdatePrompt();
      document.getElementById('pp-exec-cmd').value=cmd;
      ppRunExec();
    }

    async function ppRunExec(){
      const input=document.getElementById('pp-exec-cmd');
      const out=document.getElementById('pp-exec-output');
      const user=document.getElementById('pp-exec-user').value;
      const cmd=input.value.trim();
      if(!cmd) return;
      const prompt = user==='node' ? '$ ' : '# ';
      out.textContent += '\\n' + prompt + cmd + '\\n';
      input.value='';
      out.scrollTop=999999;
      const d=await api('POST','/api/paperclip/exec',{cmd,user});
      out.textContent += (d.output||'(no output)') + '\\n';
      out.scrollTop=999999;
    }

    async function ppRestart(){
      const btn=document.getElementById('pp-restart-btn');
      const out=document.getElementById('pp-exec-output');
      btn.disabled=true; btn.textContent='Restarting…';
      out.textContent += '\\n# Restarting Paperclip container…\\n';
      out.scrollTop=999999;
      const d=await api('POST','/api/paperclip/restart');
      out.textContent += d.ok ? 'Done.\\n' : ('Error: '+(d.error||'unknown')+'\\n');
      out.scrollTop=999999;
      btn.disabled=false; btn.textContent='↺ Restart Paperclip';
    }

    async function ppRunClaude(){
      const ta=document.getElementById('pp-claude-prompt');
      const out=document.getElementById('pp-claude-output');
      const prompt=ta.value.trim();
      if(!prompt) return;
      out.textContent += '\\n$ claude --print "' + prompt.replace(/"/g,'\\"') + '"\\n';
      ta.value='';
      out.scrollTop=999999;
      const escaped=prompt.replace(/'/g,"'\\''");
      const d=await api('POST','/api/paperclip/exec',{cmd:"claude --dangerously-skip-permissions --print '" + escaped + "'",user:'node'});
      out.textContent += (d.output||'(no output)') + '\\n';
      out.scrollTop=999999;
    }

    async function ppLoadLogs(){
      const out=document.getElementById('pp-exec-output');
      out.textContent='Loading logs…';
      const d=await api('GET','/api/paperclip/logs');
      out.textContent=d.error?('Error: '+d.error):(d.logs||'(no logs)');
      out.scrollTop=999999;
    }

    // ── System page ──
    let sysTimerDummy = null; // kept for reference, managed above

    function fmtBytes(b) {
      if (b === 0) return '0 B';
      const u = ['B','KB','MB','GB','TB'];
      const i = Math.floor(Math.log(b) / Math.log(1024));
      return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
    }

    function setRing(id, pct, color) {
      const circ = 2 * Math.PI * 15.9; // ≈ 99.9
      const el = document.getElementById(id);
      if (!el) return;
      el.setAttribute('stroke-dasharray', \`\${(pct / 100 * circ).toFixed(1)} \${circ.toFixed(1)}\`);
      if (color) el.style.stroke = color;
    }

    function ringColor(pct) {
      if (pct >= 90) return 'var(--red)';
      if (pct >= 70) return 'var(--amber)';
      return null; // keep default
    }

    async function loadSystem() {
      let d;
      try { d = await api('GET', '/api/system'); } catch { return; }

      // CPU
      const cpuC = ringColor(d.cpu.pct);
      setRing('ring-cpu', d.cpu.pct, cpuC);
      document.getElementById('ring-cpu-val').textContent  = d.cpu.pct + '%';
      document.getElementById('stat-cpu-main').textContent = d.cpu.pct + '%';
      if (cpuC) document.getElementById('ring-cpu-val').style.color = cpuC;

      // Memory
      const memC = ringColor(d.mem.pct);
      setRing('ring-mem', d.mem.pct, memC);
      document.getElementById('ring-mem-val').textContent  = d.mem.pct + '%';
      document.getElementById('stat-mem-main').textContent = fmtBytes(d.mem.used);
      document.getElementById('stat-mem-sub').textContent  = 'of ' + fmtBytes(d.mem.total);

      // Disk
      const diskC = ringColor(d.disk.pct);
      setRing('ring-disk', d.disk.pct, diskC);
      document.getElementById('ring-disk-val').textContent  = d.disk.pct + '%';
      document.getElementById('stat-disk-main').textContent = fmtBytes(d.disk.used);
      document.getElementById('stat-disk-sub').textContent  = 'of ' + fmtBytes(d.disk.total);

      // Containers
      const body = document.getElementById('ct-body');
      body.innerHTML = d.containers.map(c => {
        const memBarPct = Math.min(c.memPct, 100);
        const cpuBarPct = Math.min(c.cpuPct * 5, 100); // scale: 20% CPU = full bar
        const memBarClass = c.memPct >= 90 ? 'danger' : c.memPct >= 70 ? 'warn' : 'mem';
        const imgTag = c.image.includes(':') ? c.image.split(':').pop() : c.image;
        const imgBase = c.image.includes('/') ? c.image.split('/').pop().split(':')[0] : c.image.split(':')[0];
        return \`<div class="ct-row">
          <div class="ct-name-cell">
            <span class="ct-dot \${c.status}"></span>
            <span class="ct-name-text" title="\${c.name}">\${c.name}</span>
          </div>
          <div><span class="ct-status-badge \${c.status}">\${c.status}</span></div>
          <div>
            <div class="ct-cpu-pct">\${c.status === 'running' ? c.cpuPct.toFixed(1) + '%' : '—'}</div>
            <div class="mini-bar-wrap"><div class="mini-bar-fill cpu" style="width:\${cpuBarPct}%"></div></div>
          </div>
          <div>
            <div class="ct-stat-val">\${c.memLimit > 0 ? fmtBytes(c.memUsed) + ' / ' + fmtBytes(c.memLimit) : '—'}</div>
            <div class="mini-bar-wrap"><div class="mini-bar-fill \${memBarClass}" style="width:\${memBarPct}%"></div></div>
          </div>
          <div class="ct-image-tag" title="\${c.image}">\${imgBase}:<span style="color:var(--text2)">\${imgTag}</span></div>
        </div>\`;
      }).join('');

      // Images
      const maxSize = Math.max(...(d.images || []).map(i => i.size), 1);
      const totalImgSize = (d.images || []).reduce((s, i) => s + i.size, 0);
      document.getElementById('sys-images-total').textContent =
        (d.images || []).length + ' images — ' + fmtBytes(totalImgSize);
      document.getElementById('img-body').innerHTML = (d.images || []).map(img => {
        const barPct = Math.round(img.size / maxSize * 100);
        const shortRepo = img.repo.includes('/') ? img.repo.split('/').slice(-2).join('/') : img.repo;
        const badge = img.dangling
          ? '<span class="dangling-badge">dangling</span>'
          : img.inUse
            ? '<span class="inuse-badge">in use</span>'
            : '<span style="font-size:0.65rem;color:var(--text3)">unused</span>';
        return \`<tr>
          <td class="img-repo" title="\${img.repo}">\${shortRepo}</td>
          <td class="img-tag">\${img.tag}</td>
          <td class="img-size">
            \${fmtBytes(img.size)}
            <div class="img-size-bar"><div class="img-size-fill" style="width:\${barPct}%"></div></div>
          </td>
          <td>\${badge}</td>
        </tr>\`;
      }).join('');

      const now = new Date();
      document.getElementById('sys-refresh-ts').textContent =
        'Updated ' + now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    }

    // ── Config editor ──
    let cfgCurrentFile = '.env';
    const cfgTabMap = { '.env': 'cfg-tab-env', 'docker-compose.yml': 'cfg-tab-compose', 'Caddyfile': 'cfg-tab-caddyfile', 'claw-defaults': 'cfg-tab-clawdefaults' };
    const cfgHints = {
      '.env': 'Changes to .env require <code style="color:var(--text2)">docker compose up -d</code> to take effect',
      'docker-compose.yml': 'Changes to compose/.env require <code style="color:var(--text2)">docker compose up -d</code> to take effect',
      'Caddyfile': 'Caddy reloads automatically when the Caddyfile is saved',
      'claw-defaults': 'Applied to all new instances at creation time — existing instances are not affected',
    };

    async function cfgLoad(file) {
      cfgCurrentFile = file;
      Object.entries(cfgTabMap).forEach(([f, id]) =>
        document.getElementById(id).classList.toggle('active', f === file));
      const editor = document.getElementById('cfg-editor');
      editor.value = 'Loading…';
      document.getElementById('cfg-status').textContent = '';
      document.getElementById('cfg-footer-hint').innerHTML = cfgHints[file] || '';
      const url = file === 'claw-defaults' ? '/api/system/claw-defaults' : '/api/system/config/' + encodeURIComponent(file);
      const d = await api('GET', url);
      editor.value = d.error ? ('Error: ' + d.error) : d.content;
    }

    async function cfgSave() {
      const btn = document.getElementById('cfg-save-btn');
      const st  = document.getElementById('cfg-status');
      btn.disabled = true;
      const content = document.getElementById('cfg-editor').value;
      const url = cfgCurrentFile === 'claw-defaults' ? '/api/system/claw-defaults' : '/api/system/config/' + encodeURIComponent(cfgCurrentFile);
      const d = await api('POST', url, { content });
      btn.disabled = false;
      if (d.error) { st.style.color = 'var(--red)'; st.textContent = 'Error: ' + d.error; }
      else { st.style.color = 'var(--green)'; st.textContent = 'Saved.'; setTimeout(() => st.textContent = '', 3000); }
    }

    document.getElementById('cfg-editor').addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const t = e.target, s = t.selectionStart, end = t.selectionEnd;
      t.value = t.value.slice(0, s) + '  ' + t.value.slice(end);
      t.selectionStart = t.selectionEnd = s + 2;
    });

    async function pruneImages() {
      const btn = document.getElementById('prune-btn');
      btn.disabled = true; btn.textContent = 'Pruning…';
      const d = await api('POST', '/api/system/prune');
      btn.disabled = false; btn.textContent = 'Prune unused';
      const el = document.getElementById('prune-result');
      el.style.display = '';
      if (d.error) { el.style.color = 'var(--red)'; el.textContent = 'Error: ' + d.error; }
      else { el.style.color = 'var(--green)'; el.textContent = 'Removed ' + d.count + ' image(s), freed ' + fmtBytes(d.freed) + '.'; }
      loadSystem();
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

// WebSocket upgrade handler — native TCP pipe, http-proxy-middleware's .upgrade() is unreliable
server.on('upgrade', (req, socket, head) => {
  const host = req.headers.host?.split(':')[0];
  if (!host || host === BASE_DOMAIN) return socket.destroy();
  const row = db.prepare('SELECT container_name FROM instances WHERE domain = ?').get(host);
  if (!row) return socket.destroy();
  const isA2A = req.url.startsWith('/a2a/') || req.url === '/.well-known/agent.json';
  const port = isA2A ? 18800 : 18789;
  const upstream = require('net').createConnection({ host: row.container_name, port }, () => {
    // Forward original upgrade request headers
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
