'use strict';
const fs = require('fs');

const { PAPERCLIP_CONTAINER, PAPERCLIP_DB, PAPERCLIP_URL } = require('../lib/config');
const db = require('../lib/db');
const { docker, containerExec, httpJSON } = require('../lib/docker');
const { requireAdmin } = require('../lib/auth');

function parseEnvFile(raw) {
  const vars = {};
  raw.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx < 0) return;
    const key = line.slice(0, idx).trim();
    let val    = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    vars[key] = val;
  });
  return vars;
}

function register(app) {
  // ── Exec in Paperclip container ──
  app.post('/api/paperclip/exec', requireAdmin, async (req, res) => {
    const { cmd, user } = req.body;
    if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
    try {
      const result = await containerExec(PAPERCLIP_CONTAINER, cmd, user === 'node' ? 'node' : 'root', 60000);
      res.json({ output: result.output, exitCode: result.exitCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Restart Paperclip (reload .env) ──
  app.post('/api/paperclip/restart', requireAdmin, async (req, res) => {
    try {
      let envVars = {};
      try { envVars = parseEnvFile(fs.readFileSync('/clawstack-config/.env', 'utf8')); } catch {}

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
      const info      = await container.inspect();
      if (info.State.Running) await container.stop({ t: 10 });
      await container.remove();
      const created = await docker.createContainer({
        name: PAPERCLIP_CONTAINER,
        Image: info.Config.Image,
        Env: newEnv,
        HostConfig: info.HostConfig,
        NetworkingConfig: { EndpointsConfig: { clawstack: { Aliases: ['paperclip'] } } },
      });
      await created.start();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Recreate with new image (version upgrade) ──
  app.post('/api/paperclip/recreate', requireAdmin, async (req, res) => {
    try {
      let envVars = {};
      try { envVars = parseEnvFile(fs.readFileSync('/clawstack-config/.env', 'utf8')); } catch {}

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
        `ANTHROPIC_MODEL=${r('ANTHROPIC_MODEL')}`,
      ];

      const container = docker.getContainer(PAPERCLIP_CONTAINER);
      const info      = await container.inspect();
      const newImage  = (req.body.image || info.Config.Image).trim();

      if (info.State.Running) await container.stop({ t: 10 });
      await container.remove();

      await new Promise((resolve, reject) => {
        docker.pull(newImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, err => err ? reject(err) : resolve());
        });
      });

      const created = await docker.createContainer({
        name: PAPERCLIP_CONTAINER,
        Image: newImage,
        Env: newEnv,
        HostConfig: info.HostConfig,
        NetworkingConfig: { EndpointsConfig: { clawstack: { Aliases: ['paperclip'] } } },
      });
      await created.start();
      res.json({ ok: true, image: newImage });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Logs ──
  app.get('/api/paperclip/logs', requireAdmin, async (req, res) => {
    try {
      const container = docker.getContainer(PAPERCLIP_CONTAINER);
      const stream    = await container.logs({ stdout: true, stderr: true, tail: 300 });
      const lines = [];
      let offset = 0;
      while (offset + 8 <= stream.length) {
        const size = stream.readUInt32BE(offset + 4); offset += 8;
        if (offset + size > stream.length) break;
        lines.push(stream.slice(offset, offset + size).toString('utf8')); offset += size;
      }
      res.json({ logs: lines.join('') || stream.toString('utf8') });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Status ──
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
      paperclip: { running: !!ppInfo?.State?.Running, status: ppInfo?.State?.Status || 'not found', image: ppInfo?.Config?.Image || null },
      db:        { running: !!dbInfo?.State?.Running, status: dbInfo?.State?.Status || 'not found' },
      api: apiHealth,
      agents,
      instances: instanceStatus,
      pending,
    });
  });

  // ── Fix ──
  app.post('/api/paperclip/fix', requireAdmin, async (req, res) => {
    const results = [];

    try {
      const { output } = await containerExec(PAPERCLIP_DB,
        `psql -U paperclip -d paperclip -t -A -c "UPDATE agent_api_keys SET revoked_at=NULL WHERE key_hash='660c9c30b5d47cb01c32765aaad8382afe7ade4b765514502ca835f4dcb7585b' AND revoked_at IS NOT NULL RETURNING id"`,
        'postgres');
      const n = output.split('\n').filter(Boolean).length;
      results.push({ fix: 1, label: 'Token un-revoke', msg: n > 0 ? 'Un-revoked.' : 'Already active.', changed: n > 0 });
    } catch (e) { results.push({ fix: 1, label: 'Token un-revoke', msg: 'Error: ' + e.message, changed: false, error: true }); }

    try {
      const { output } = await containerExec(PAPERCLIP_DB,
        `psql -U paperclip -d paperclip -t -A -c "UPDATE agents SET adapter_config=adapter_config||'{\\"payloadTemplate\\":{\\"channel\\":\\"heartbeat\\"}}'::jsonb WHERE adapter_type='openclaw_gateway' AND (adapter_config->'payloadTemplate' IS NULL OR adapter_config->'payloadTemplate'->>'channel' IS NULL) RETURNING id"`,
        'postgres');
      const n = output.split('\n').filter(Boolean).length;
      results.push({ fix: 2, label: 'payloadTemplate channel', msg: n > 0 ? `Set on ${n} agent(s).` : 'Already set.', changed: n > 0 });
    } catch (e) { results.push({ fix: 2, label: 'payloadTemplate channel', msg: 'Error: ' + e.message, changed: false, error: true }); }

    try {
      const { exitCode } = await containerExec(PAPERCLIP_CONTAINER, 'which claude > /dev/null 2>&1');
      if (exitCode === 0) {
        results.push({ fix: 3, label: 'Claude CLI', msg: 'Already installed.', changed: false });
      } else {
        await containerExec(PAPERCLIP_CONTAINER, 'curl -fsSL https://claude.ai/install.sh | bash 2>&1', 'node', 120000);
        results.push({ fix: 3, label: 'Claude CLI', msg: 'Installed.', changed: true });
      }
    } catch (e) { results.push({ fix: 3, label: 'Claude CLI', msg: 'Error: ' + e.message, changed: false, error: true }); }

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

  // ── Connect instance to Paperclip ──
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

  // ── Finalize Paperclip connection ──
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
}

module.exports = { register };
