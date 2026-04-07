'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  CONFIG_DIR, ALLOWED_CONFIG_FILES, CLAW_DEFAULTS_FILE, BASELINE_CLAW_DEFAULTS,
  PROVIDERS, MODEL_PRESETS, NO_KEY_PROVIDERS, BASE_DOMAIN, OPENCLAW_IMAGE,
} = require('../lib/config');
const db           = require('../lib/db');
const { docker }   = require('../lib/docker');
const { AGENT_ROLES, loadClawDefaults } = require('../lib/bootstrap');
const { requireAdmin }  = require('../lib/auth');
const { createTerminalToken } = require('../lib/terminal');

function readProcStat() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const vals = line.trim().split(/\s+/).slice(1).map(Number);
  const idle  = vals[3] + (vals[4] || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function register(app) {
  // ── Caddy on-demand TLS verification (no auth) ──
  app.get('/api/verify-domain', (req, res) => {
    const domain = req.query.domain;
    if (!domain) return res.status(400).send('domain required');
    const row = db.prepare('SELECT id FROM instances WHERE domain = ?').get(domain);
    return row ? res.status(200).send('ok') : res.status(404).send('not found');
  });

  // ── Init data for frontend bootstrap ──
  app.get('/api/init-data', requireAdmin, (req, res) => {
    res.json({
      baseDomain:   BASE_DOMAIN || '',
      defaultImage: OPENCLAW_IMAGE,
      providers:    PROVIDERS,
      modelPresets: MODEL_PRESETS,
      noKeyProviders: [...NO_KEY_PROVIDERS],
      agentRoles: Object.fromEntries(
        Object.entries(AGENT_ROLES).map(([k, v]) => [k, { label: v.label, description: v.description }])
      ),
    });
  });

  // ── Terminal token ──
  app.post('/api/terminal/token', requireAdmin, (req, res) => {
    const { container, user } = req.body;
    if (!container || typeof container !== 'string')
      return res.status(400).json({ error: 'container required' });
    const token = createTerminalToken(container, user === 'node' ? 'node' : 'root');
    res.json({ token });
  });

  // ── System stats ──
  app.get('/api/system', requireAdmin, async (req, res) => {
    const t1 = readProcStat();
    await new Promise(r => setTimeout(r, 300));
    const t2 = readProcStat();
    const idleDelta  = t2.idle  - t1.idle;
    const totalDelta = t2.total - t1.total;
    const cpuPct = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;

    const memData  = fs.readFileSync('/proc/meminfo', 'utf8');
    const getKB    = key => parseInt(memData.match(new RegExp(key + ':\\s+(\\d+)'))?.[1] || 0) * 1024;
    const memTotal = getKB('MemTotal');
    const memUsed  = memTotal - getKB('MemAvailable');

    let diskUsed = 0, diskTotal = 1;
    try {
      const dfLine = execSync('df -B1 /instances 2>/dev/null | tail -1').toString().trim().split(/\s+/);
      diskTotal = parseInt(dfLine[1]) || 1;
      diskUsed  = parseInt(dfLine[2]) || 0;
    } catch {}

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
        const ncpu     = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
        const cpuPct   = sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * ncpu * 1000) / 10 : 0;
        const memUsed  = Math.max(0, (s.memory_stats.usage || 0) - (s.memory_stats.stats?.cache || 0));
        const memLimit = s.memory_stats.limit || 0;
        const memPct   = memLimit > 0 ? Math.round(memUsed / memLimit * 100) : 0;
        return { ...base, cpuPct, memUsed, memLimit, memPct };
      } catch { return base; }
    }));
    containers.sort((a, b) => (b.status === 'running' ? 1 : 0) - (a.status === 'running' ? 1 : 0));

    const rawImages  = await docker.listImages({ all: false });
    const usedIds    = new Set(all.map(c => c.ImageID));
    const images     = rawImages.map(img => {
      const repoTag = (img.RepoTags?.[0]) || (img.RepoDigests?.[0]?.split('@')[0] + ':<none>') || '<none>:<none>';
      const [repo, tag] = repoTag.includes(':') ? repoTag.split(':') : [repoTag, '<none>'];
      return { id: img.Id.replace('sha256:', '').slice(0, 12), repo, tag, size: img.Size, dangling: !img.RepoTags || img.RepoTags[0] === '<none>:<none>', inUse: usedIds.has(img.Id) };
    }).sort((a, b) => b.size - a.size);

    res.json({
      cpu:  { pct: cpuPct },
      mem:  { used: memUsed,  total: memTotal,  pct: Math.round(memUsed  / memTotal  * 100) },
      disk: { used: diskUsed, total: diskTotal, pct: Math.round(diskUsed / diskTotal * 100) },
      containers, images,
    });
  });

  // ── Config file editor ──
  app.get('/api/system/config/:file', requireAdmin, (req, res) => {
    const name = req.params.file;
    if (!ALLOWED_CONFIG_FILES.includes(name)) return res.status(400).json({ error: 'Not allowed' });
    try { res.json({ content: fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8') }); }
    catch (e) { res.status(404).json({ error: e.message }); }
  });

  app.post('/api/system/config/:file', requireAdmin, (req, res) => {
    const name = req.params.file;
    if (!ALLOWED_CONFIG_FILES.includes(name)) return res.status(400).json({ error: 'Not allowed' });
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    try { fs.writeFileSync(path.join(CONFIG_DIR, name), content, 'utf8'); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Claw defaults ──
  app.get('/api/system/claw-defaults', requireAdmin, (req, res) => {
    res.json({ content: JSON.stringify(loadClawDefaults(), null, 2) });
  });

  app.post('/api/system/claw-defaults', requireAdmin, (req, res) => {
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    try {
      JSON.parse(content);
      fs.writeFileSync(CLAW_DEFAULTS_FILE, content, 'utf8');
      res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Prune images ──
  app.post('/api/system/prune', requireAdmin, async (req, res) => {
    try {
      const result = await docker.pruneImages({ filters: JSON.stringify({ dangling: { false: true } }) });
      res.json({ freed: result.SpaceReclaimed || 0, count: (result.ImagesDeleted || []).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register };
