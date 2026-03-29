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
// Migration: add role column if missing
try { db.exec(`ALTER TABLE instances ADD COLUMN role TEXT DEFAULT 'generalist'`); } catch {}

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

// --- Bootstrap: write OpenClaw config files before container starts ---
function bootstrapInstance({ name, domain, provider, apiKey, model, token, baseUrl, enableA2A, role }) {
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
      mode: 'local',
      bind: 'lan',
      remote: { url: `https://${domain}` },
      auth: { token: token },
      http: {
        endpoints: {
          responses: { enabled: true }
        }
      },
      controlUi: {
        allowedOrigins: [
          'http://localhost:18789',
          `https://${domain}`
        ],
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
  const { name, domain, provider, model, baseUrl, enableA2A, role } = req.body;
  const apiKey = NO_KEY_PROVIDERS.has(provider) ? (req.body.apiKey || 'none') : req.body.apiKey;
  if (!name || !domain || !provider || !model || (!NO_KEY_PROVIDERS.has(provider) && !apiKey))
    return res.status(400).json({ error: 'name, domain, provider, model required (and apiKey for this provider)' });
  if (provider === 'private' && !baseUrl)
    return res.status(400).json({ error: 'baseUrl required for Private LLM provider' });

  const containerName = `clawstack-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const token = crypto.randomBytes(32).toString('hex');

  try {
    db.prepare('INSERT INTO instances (name, domain, container_name, token, provider, model, role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, domain.toLowerCase(), containerName, token, provider, model, role || 'generalist');
  } catch (e) {
    return res.status(400).json({ error: 'name or domain already exists' });
  }

  try {
    bootstrapInstance({ name, domain, provider, apiKey, model, token, baseUrl, enableA2A: !!enableA2A, role: role || 'generalist' });
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
        Memory: 900 * 1024 * 1024,       // 900 MB hard limit
        MemorySwap: 1200 * 1024 * 1024,  // 1.2 GB incl. swap
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
  <title>ClawStack</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
  </div>

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
          <div class="field full" id="baseurl-row" style="display:none"><label>Base URL</label><input name="baseUrl" id="baseUrl" type="url" placeholder="http://localhost:11434/v1" autocomplete="off"></div>
          <div class="field full" id="apikey-row"><label>API Key</label><input name="apiKey" id="apiKey" type="password" placeholder="sk-..." autocomplete="off"></div>
          <div class="full" style="margin-top:4px;display:flex;align-items:center;justify-content:space-between;gap:1rem">
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:0.78rem;color:var(--text3);text-transform:none;letter-spacing:0;font-weight:400">
              <input type="checkbox" name="enableA2A" value="1" style="width:auto;accent-color:var(--blue)">
              Enable A2A (agent-to-agent protocol)
            </label>
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
        </div>
        <a class="inst-domain" href="https://${esc(i.domain)}" target="_blank">${esc(i.domain)}</a>
        <div class="inst-token">
          <span class="tok-val" id="tok-${i.name}" title="Click to copy" onclick="copyToken('${esc(i.token)}','${esc(i.name)}')">${i.token.slice(0,18)}…</span>
          <button class="copy-btn" onclick="copyToken('${esc(i.token)}','${esc(i.name)}')" title="Copy token">⎘</button>
        </div>
        <div class="divider"></div>
        <div class="inst-actions">
          <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','files')">Files</button>
          <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','logs')">Logs</button>
          <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','cli')">CLI</button>
          <div class="divider"></div>
          <button class="btn amber sm" onclick="rowAction('${esc(i.name)}','restart')" title="Restart">↺</button>
          <button class="btn ghost sm" id="stopstart-${i.name}" onclick="rowAction('${esc(i.name)}','${i.status === 'running' ? 'stop' : 'start'}')">${i.status === 'running' ? '■' : '▶'}</button>
          <form method="post" action="/admin/instances/${esc(i.name)}/delete" style="margin:0">
            <button type="submit" class="btn danger sm" onclick="return confirm('Delete ${esc(i.name)}?')">✕</button>
          </form>
        </div>
      </div>`).join('')}</div>`}
  </div>

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
    <div class="tab active" id="tab-files" onclick="switchTab('files')">Files</div>
    <div class="tab"        id="tab-logs"  onclick="switchTab('logs')">Logs</div>
    <div class="tab"        id="tab-cli"   onclick="switchTab('cli')">CLI</div>
    <div class="tab"        id="tab-exec"  onclick="switchTab('exec')">Exec (root)</div>
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

      <div id="mgr-footer">
        <button id="btn-save" class="btn sm" onclick="saveFile()" disabled>Save</button>
        <button id="btn-refresh-logs" class="btn ghost sm" style="display:none" onclick="loadLogs()">↻ Refresh</button>
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
      ['files','logs','cli','exec'].forEach(t=>document.getElementById('tab-'+t).className='tab'+(tab===t?' active':''));
      document.getElementById('mgr-editor').style.display=tab==='files'?'':'none';
      document.getElementById('mgr-logs').style.display=tab==='logs'?'block':'none';
      document.getElementById('mgr-cli').style.display=tab==='cli'?'flex':'none';
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
      } else if(tab==='cli'){
        document.getElementById('mgr-crumb').textContent='OpenClaw CLI (node user)';
        setTimeout(()=>document.getElementById('cli-cmd').focus(),50);
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
