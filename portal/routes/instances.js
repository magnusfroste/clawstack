'use strict';
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');

const { INSTANCES_DIR, INSTANCES_HOST_DIR, OPENCLAW_IMAGE, NO_KEY_PROVIDERS, PROVIDER_CONFIGS } = require('../lib/config');
const db          = require('../lib/db');
const { docker, containerExec } = require('../lib/docker');
const { bootstrapInstance } = require('../lib/bootstrap');
const { requireAdmin, checkAuth } = require('../lib/auth');

function resolveInstancePath(instanceName, relPath) {
  const base = path.join(INSTANCES_DIR, instanceName);
  const full = path.resolve(base, relPath || '');
  if (full !== base && !full.startsWith(base + path.sep))
    throw new Error('Path traversal not allowed');
  return full;
}

// If the user typed just a tag like "latest" or "2026.4.12", prepend the base image.
function resolveImage(input) {
  const img = (input || OPENCLAW_IMAGE).trim();
  if (img.includes('/')) return img;
  const base = OPENCLAW_IMAGE.includes(':') ? OPENCLAW_IMAGE.slice(0, OPENCLAW_IMAGE.lastIndexOf(':') + 1) : OPENCLAW_IMAGE + ':';
  return base + img;
}

function register(app) {
  // ── List instances ──
  app.get('/api/instances', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT id, name, domain, container_name, token, provider, model, status, image, created_at FROM instances ORDER BY created_at DESC').all();
    rows.forEach(row => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, row.name, 'config', 'openclaw.json'), 'utf8'));
        row.liveModel = cfg?.agents?.defaults?.model?.primary || cfg?.agents?.list?.[0]?.model || null;
      } catch { row.liveModel = null; }
    });
    res.json(rows);
  });

  // ── Create instance ──
  app.post('/api/instances', requireAdmin, async (req, res) => {
    const { name, domain, provider, model, baseUrl, enableA2A, role, image, allowAll } = req.body;
    const apiKey = NO_KEY_PROVIDERS.has(provider) ? (req.body.apiKey || 'none') : req.body.apiKey;
    if (!name || !domain || !provider || !model || (!NO_KEY_PROVIDERS.has(provider) && !apiKey))
      return res.status(400).json({ error: 'name, domain, provider, model required (and apiKey for this provider)' });
    if (provider === 'private' && !baseUrl)
      return res.status(400).json({ error: 'baseUrl required for Private LLM provider' });

    const containerName  = `clawstack-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const token          = crypto.randomBytes(32).toString('hex');
    const instanceImage  = resolveImage(image);

    try {
      db.prepare('INSERT INTO instances (name, domain, container_name, token, provider, model, role, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, domain.toLowerCase(), containerName, token, provider, model, role || 'generalist', instanceImage);
    } catch {
      return res.status(400).json({ error: 'name or domain already exists' });
    }

    try {
      bootstrapInstance({ name, domain, provider, apiKey, model, token, baseUrl, enableA2A: !!enableA2A, role: role || 'generalist', allowAll: !!allowAll });
    } catch (e) {
      db.prepare('DELETE FROM instances WHERE name = ?').run(name);
      return res.status(500).json({ error: `Bootstrap failed: ${e.message}` });
    }

    try {
      await new Promise((resolve, reject) => {
        docker.pull(instanceImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, err => err ? reject(err) : resolve());
        });
      });
    } catch (e) {
      db.prepare('DELETE FROM instances WHERE name = ?').run(name);
      return res.status(500).json({ error: `Pull failed: ${e.message}` });
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
          Memory:      1536 * 1024 * 1024,
          MemorySwap:  2048 * 1024 * 1024,
          CpuQuota:    150000,
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

  // ── Delete instance ──
  app.delete('/api/instances/:name', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT * FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    try { const c = docker.getContainer(row.container_name); await c.stop().catch(() => {}); await c.remove().catch(() => {}); } catch {}
    db.prepare('DELETE FROM instances WHERE name = ?').run(req.params.name);
    res.json({ success: true });
  });

  // ── Recreate with new image ──
  app.post('/api/instances/:name/recreate', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT * FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    const newImage = resolveImage(req.body.image || row.image);
    let apiKey = '';
    try {
      const info = await docker.getContainer(row.container_name).inspect();
      const env  = (info.Config.Env || []).find(e => e.startsWith('OPENCLAW_PROVIDER_API_KEY='));
      if (env) apiKey = env.slice('OPENCLAW_PROVIDER_API_KEY='.length);
    } catch {}
    try { const c = docker.getContainer(row.container_name); await c.stop().catch(() => {}); await c.remove().catch(() => {}); } catch {}
    try {
      await new Promise((resolve, reject) => {
        docker.pull(newImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, err => err ? reject(err) : resolve());
        });
      });
    } catch (e) { return res.status(500).json({ error: `Pull failed: ${e.message}` }); }
    db.prepare('UPDATE instances SET image = ?, status = ? WHERE name = ?').run(newImage, 'starting', row.name);
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
          Memory:     1536 * 1024 * 1024,
          MemorySwap: 2048 * 1024 * 1024,
          CpuQuota:   150000,
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

  // ── File management ──
  // Accepts admin Basic auth OR instance Bearer token (gateway token) — CORS-enabled for external tools.
  function fileCors(req, res, next) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  }

  app.options('/api/instances/:name/files', fileCors, (req, res) => res.sendStatus(204));

  app.get('/api/instances/:name/files', fileCors, (req, res) => {
    const row = db.prepare('SELECT id, token FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!checkAuth(req, row.token)) {
      res.set('WWW-Authenticate', 'Basic realm="ClawStack"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
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

  app.post('/api/instances/:name/files', fileCors, (req, res) => {
    const row = db.prepare('SELECT id, token FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!checkAuth(req, row.token)) {
      res.set('WWW-Authenticate', 'Basic realm="ClawStack"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
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

  // ── Backup / Restore ──
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
    const dir     = path.join(INSTANCES_DIR, req.params.name);
    const tmpFile = path.join('/tmp', `${req.params.name}-restore.tar.gz`);
    try {
      fs.writeFileSync(tmpFile, req.body);
      const container = docker.getContainer(row.container_name);
      await container.stop().catch(() => {});
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
    } finally { fs.unlink(tmpFile, () => {}); }
  });

  // ── Container actions ──
  app.post('/api/instances/:name/action', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT container_name, status FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    try {
      const container = docker.getContainer(row.container_name);
      if      (req.body.action === 'stop')    { await container.stop().catch(() => {}); db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('stopped', req.params.name); }
      else if (req.body.action === 'start')   { await container.start();                db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('running', req.params.name); }
      else if (req.body.action === 'restart') { await container.restart().catch(() => {}); db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('running', req.params.name); }
      else return res.status(400).json({ error: 'unknown action' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Logs ──
  app.get('/api/instances/:name/logs', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    try {
      const container = docker.getContainer(row.container_name);
      const buf = await container.logs({ stdout: true, stderr: true, tail: parseInt(req.query.tail) || 300, timestamps: true });
      let offset = 0; const lines = [];
      while (offset + 8 <= buf.length) {
        const size = buf.readUInt32BE(offset + 4); offset += 8;
        if (offset + size > buf.length) break;
        lines.push(buf.slice(offset, offset + size).toString('utf8')); offset += size;
      }
      res.json({ logs: lines.join('') });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Exec (root) ──
  app.post('/api/instances/:name/exec', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    const { cmd } = req.body;
    if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
    try {
      const result = await containerExec(row.container_name, cmd, 'root', 30000);
      res.json({ output: result.output, exitCode: result.exitCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── CLI (node user) ──
  app.post('/api/instances/:name/cli', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    const { cmd } = req.body;
    if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
    try {
      const container = docker.getContainer(row.container_name);
      const exec = await container.exec({
        Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true,
        User: 'node', Env: ['HOME=/home/node'],
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const chunks = [];
      await new Promise((resolve, reject) => {
        stream.on('data', d => chunks.push(d));
        stream.on('end', resolve); stream.on('error', reject);
        setTimeout(resolve, 60000);
      });
      const buf = Buffer.concat(chunks);
      let offset = 0; const lines = [];
      while (offset + 8 <= buf.length) {
        const size = buf.readUInt32BE(offset + 4); offset += 8;
        if (offset + size > buf.length) break;
        lines.push(buf.slice(offset, offset + size).toString('utf8')); offset += size;
      }
      const output   = lines.join('') || buf.toString('utf8');
      const inspect  = await exec.inspect();
      res.json({ output, exitCode: inspect.ExitCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Model config ──
  app.get('/api/instances/:name/model', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT name FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    try {
      const cfg        = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, req.params.name, 'config', 'openclaw.json'), 'utf8'));
      const primary    = cfg?.agents?.defaults?.model?.primary || '';
      const providers  = cfg?.models?.providers || {};
      const providerKey = Object.keys(providers)[0] || '';
      const providerCfg = providers[providerKey] || {};
      res.json({
        provider: providerKey,
        model:    primary.includes('/') ? primary.split('/').slice(1).join('/') : primary,
        baseUrl:  providerCfg.baseUrl || '',
        hasApiKey: !!providerCfg.apiKey && !providerCfg.apiKey.startsWith('${'),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/instances/:name/model', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT name, container_name FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    const { provider, model, apiKey, baseUrl } = req.body;
    if (!provider || !model) return res.status(400).json({ error: 'provider and model required' });
    try {
      const cfgPath    = path.join(INSTANCES_DIR, req.params.name, 'config', 'openclaw.json');
      const cfg        = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const providerConf = { ...(PROVIDER_CONFIGS[provider] || { baseUrl: baseUrl || '', api: 'openai-completions' }) };
      if (provider === 'private' && baseUrl) providerConf.baseUrl = baseUrl;
      const modelId = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
      cfg.models = cfg.models || {};
      cfg.models.providers = {
        [provider]: {
          ...providerConf,
          apiKey: apiKey || cfg.models?.providers?.[provider]?.apiKey || '${OPENCLAW_PROVIDER_API_KEY}',
          models: [{ id: modelId, name: modelId }],
        }
      };
      cfg.agents = cfg.agents || {};
      cfg.agents.defaults = cfg.agents.defaults || {};
      cfg.agents.defaults.model = { primary: `${provider}/${modelId}` };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      fs.chownSync(cfgPath, 1000, 1000);
      const container = docker.getContainer(row.container_name);
      await container.restart();
      db.prepare('UPDATE instances SET provider = ?, model = ? WHERE name = ?').run(provider, model, row.name);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Chat (SSE proxy) ──
  app.post('/api/instances/:name/chat', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT container_name, token FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

    const last = messages[messages.length - 1];
    const input = last?.content ?? '';
    const body = Buffer.from(JSON.stringify({ model: 'openclaw', input, stream: true }));
    const opts = {
      hostname: row.container_name, port: 18789, path: '/v1/responses', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${row.token}`, 'Content-Length': body.length },
    };
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const proxyReq = require('http').request(opts, proxyRes => {
      proxyRes.on('data', chunk => res.write(chunk));
      proxyRes.on('end', () => res.end());
    });
    proxyReq.on('error', err => { if (!res.headersSent) res.status(502).json({ error: err.message }); else res.end(); });
    proxyReq.write(body);
    proxyReq.end();
  });

  // ── Status ──
  app.get('/api/instances/:name/status', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT container_name FROM instances WHERE name = ?').get(req.params.name);
    if (!row) return res.status(404).json({ error: 'not found' });
    try {
      const info   = await docker.getContainer(row.container_name).inspect();
      const status = info.State.Running ? 'running' : (info.State.Status || 'stopped');
      db.prepare('UPDATE instances SET status = ? WHERE name = ?').run(status, req.params.name);
      res.json({ status });
    } catch {
      db.prepare('UPDATE instances SET status = ? WHERE name = ?').run('error', req.params.name);
      res.json({ status: 'error' });
    }
  });

  // ── Form handlers ──
  app.post('/admin/instances', requireAdmin, async (req, res) => {
    const auth = req.headers.authorization;
    const r = await fetch('http://localhost:3000/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    if (!r.ok) return res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;background:#0f0f0f;color:#e5e5e5"><p>Error: ${data.error}</p><a href="/" style="color:#60a5fa">Back</a></body></html>`);
    res.redirect('/');
  });

  app.post('/admin/instances/:name/delete', requireAdmin, async (req, res) => {
    await fetch(`http://localhost:3000/api/instances/${req.params.name}`, {
      method: 'DELETE', headers: { 'Authorization': req.headers.authorization },
    });
    res.redirect('/');
  });
}

module.exports = { register };
