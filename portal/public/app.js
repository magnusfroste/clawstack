'use strict';

// ── Bootstrap: fetch init-data and populate form, then load instances ──
let __initData = {};

async function init() {
  const d = await api('GET', '/api/init-data');
  if (d.error) { console.error('init-data error:', d.error); return; }
  __initData = d;

  // CNAME target
  document.getElementById('cname-target').textContent = d.baseDomain || 'this-server';

  // Default image
  document.getElementById('image').value = d.defaultImage || '';

  // Role dropdown
  const roleEl = document.getElementById('role');
  Object.entries(d.agentRoles || {}).forEach(([k, v]) => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = `${v.label} — ${v.description}`;
    roleEl.appendChild(opt);
  });

  // Provider dropdown
  const provEl = document.getElementById('provider');
  (d.providers || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p === 'private' ? 'Private LLM (self-hosted)' : p;
    provEl.appendChild(opt);
  });

  // Default model
  if (d.modelPresets?.openrouter) document.getElementById('model').value = d.modelPresets.openrouter;

  // Load instances list
  await loadInstances();

  // Handle direct URL loads
  const path = location.pathname;
  const instMatch = path.match(/^\/instances\/([^/]+)$/);
  if (instMatch) {
    const name = decodeURIComponent(instMatch[1]);
    history.replaceState({ instance: name, tab: 'files' }, '', path);
    const found = (__cachedInstances || []).find(i => i.name === name);
    openMgr(name, 'files', found ? (found.image || __initData.defaultImage || '') : '', false);
  } else if (path === '/system') {
    history.replaceState({ page: 'system' }, '', path);
    showPage('system', false);
  } else if (path === '/paperclip') {
    history.replaceState({ page: 'paperclip' }, '', path);
    showPage('paperclip', false);
  } else {
    history.replaceState({ page: 'instances' }, '', '/');
  }
}

let __cachedInstances = [];
let newFormOpen = false, newFormInitialized = false;

const ROLE_EMOJI = { flowwink: '🦞', qa: '🔍', seo: '📈', dev: '🛠️', support: '💬', research: '🔬', generalist: '🤖' };
const ROLE_COLOR = { flowwink: 'var(--blue)', qa: 'var(--amber)', seo: 'var(--green)', dev: 'var(--blue-dim)', support: 'var(--green)', research: 'var(--amber)' };

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const d = Math.floor(diff / 86400000), h = Math.floor(diff / 3600000), m = Math.floor(diff / 60000);
  return d > 0 ? d + 'd ago' : h > 0 ? h + 'h ago' : m > 0 ? m + 'm ago' : 'just now';
}

function toggleNewForm() {
  newFormOpen = !newFormOpen;
  document.getElementById('new-inst-card').style.display = newFormOpen ? '' : 'none';
  document.getElementById('new-inst-toggle').textContent = newFormOpen ? '▾ Collapse' : '+ New';
}

function filterInstances() {
  const q = (document.getElementById('inst-search').value || '').toLowerCase().trim();
  renderInstanceCards(q ? __cachedInstances.filter(i =>
    i.name.toLowerCase().includes(q) ||
    i.domain.toLowerCase().includes(q) ||
    (i.liveModel || '').toLowerCase().includes(q) ||
    (i.provider || '').toLowerCase().includes(q)
  ) : __cachedInstances);
}

function renderInstanceCards(instances) {
  const list = document.getElementById('instances-list');
  const q = document.getElementById('inst-search').value.trim();
  if (!instances.length) {
    list.innerHTML = `<div class="empty">${q ? 'No instances match "' + esc(q) + '"' : 'No agents deployed yet. Create one above.'}</div>`;
    return;
  }
  const defaultImage = __initData.defaultImage || '';
  list.innerHTML = `<div class="instances">${instances.map(i => {
    const img = i.image || defaultImage;
    const imgTag = img.split(':')[1] || img;
    const age = relativeTime(i.created_at);
    const emoji = ROLE_EMOJI[i.role] || '🤖';
    const st = i.status || 'stopped';
    return `<div class="inst-card ${esc(st)} role-${esc(i.role || 'generalist')}">
      <div class="inst-avatar">${emoji}</div>
      <div class="inst-main">
        <div class="inst-name">
          <a class="inst-name-link" href="/instances/${esc(i.name)}" onclick="event.preventDefault();openMgr('${esc(i.name)}','files','${esc(img)}')">${esc(i.name)}</a>
          <span class="badge ${st}" id="badge-${i.name}">${st}</span>
        </div>
        <div class="inst-meta">${i.liveModel ? esc(i.liveModel) + ' · ' : ''}${i.role && i.role !== 'generalist' ? esc(i.role) : 'generalist'}</div>
        <div class="inst-meta" title="${esc(img)}">${esc(imgTag)}${age ? ` · ${age}` : ''}</div>
      </div>
      <a class="inst-domain" href="https://${esc(i.domain)}" target="_blank">${esc(i.domain)}</a>
      <div class="inst-token">
        <span class="tok-val" id="tok-${i.name}" title="Click to copy" onclick="copyToken('${esc(i.token)}','${esc(i.name)}')">${i.token.slice(0,18)}…</span>
        <button class="copy-btn" onclick="copyToken('${esc(i.token)}','${esc(i.name)}')" title="Copy token">⎘</button>
      </div>
      <div class="divider"></div>
      <div class="inst-actions">
        <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','files','${esc(img)}')">Files</button>
        <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','logs','${esc(img)}')">Logs</button>
        <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','chat','${esc(img)}')">Chat</button>
        <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','cli','${esc(img)}')">CLI</button>
        <button class="btn ghost sm" onclick="openMgr('${esc(i.name)}','version','${esc(img)}')">Version</button>
        <div class="divider"></div>
        <button class="btn amber sm" onclick="rowAction('${esc(i.name)}','restart')" title="Restart">↺</button>
        <button class="btn ghost sm" id="stopstart-${i.name}" onclick="rowAction('${esc(i.name)}','${i.status === 'running' ? 'stop' : 'start'}')">${i.status === 'running' ? '■' : '▶'}</button>
        <button class="btn danger sm" onclick="deleteInstance('${esc(i.name)}')" title="Delete instance">✕</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ── Delete confirmation ──
let __pendingDelete = null;

function deleteInstance(name) {
  __pendingDelete = name;
  document.getElementById('del-modal-name').textContent = name;
  document.getElementById('del-confirm-input').value = '';
  document.getElementById('del-confirm-input').classList.remove('shake');
  document.getElementById('del-modal').classList.add('open');
  setTimeout(() => document.getElementById('del-confirm-input').focus(), 80);
}

async function confirmDelete() {
  const val = document.getElementById('del-confirm-input').value.trim();
  if (val !== __pendingDelete) {
    const inp = document.getElementById('del-confirm-input');
    inp.classList.remove('shake');
    void inp.offsetWidth;
    inp.classList.add('shake');
    return;
  }
  document.getElementById('del-modal').classList.remove('open');
  await api('DELETE', '/api/instances/' + __pendingDelete);
  __pendingDelete = null;
  await loadInstances();
  toast('Instance deleted', 'info');
}

function cancelDelete() {
  document.getElementById('del-modal').classList.remove('open');
  __pendingDelete = null;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('del-modal').classList.contains('open')) cancelDelete();
});

async function loadInstances() {
  const countEl = document.getElementById('instances-count');
  const d = await api('GET', '/api/instances');
  if (d.error || !Array.isArray(d)) {
    document.getElementById('instances-list').innerHTML = `<div class="empty">Error loading instances: ${esc(String(d.error || 'unknown'))}</div>`;
    return;
  }
  __cachedInstances = d;
  countEl.textContent = `${d.length} total`;
  if (!newFormInitialized) {
    newFormInitialized = true;
    if (d.length > 0) {
      newFormOpen = false;
      document.getElementById('new-inst-card').style.display = 'none';
      document.getElementById('new-inst-toggle').textContent = '+ New';
    }
  }
  filterInstances();
}

// ── Core API helper ──
async function api(method, url, body) {
  const opts = { method, headers: { Authorization: window.__auth } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  return r.json().catch(() => ({ error: 'bad response' }));
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Copy token ──
function copyToken(token, name) {
  navigator.clipboard.writeText(token).then(() => {
    const el = document.getElementById('tok-' + name);
    const prev = el.textContent;
    el.textContent = 'Copied!'; el.style.color = '#4ade80';
    setTimeout(() => { el.textContent = prev; el.style.color = ''; }, 1500);
  });
}

// ── Row quick actions ──
async function rowAction(name, action) {
  const badge = document.getElementById('badge-' + name);
  const btn   = document.getElementById('stopstart-' + name);
  if (badge) { badge.textContent = '…'; badge.className = 'badge starting'; }
  await api('POST', '/api/instances/' + name + '/action', { action });
  const d = await api('GET', '/api/instances/' + name + '/status');
  if (badge) { badge.textContent = d.status; badge.className = 'badge ' + (d.status || 'error'); }
  if (btn)   { btn.textContent = d.status === 'running' ? '■' : '▶'; btn.onclick = () => rowAction(name, d.status === 'running' ? 'stop' : 'start'); }
}

// ── Status polling ──
async function pollStatus() {
  document.querySelectorAll('[id^="badge-"]').forEach(async el => {
    const name = el.id.slice(6);
    const d = await api('GET', '/api/instances/' + name + '/status').catch(() => ({}));
    if (d.status) { el.textContent = d.status; el.className = 'badge ' + (d.status || 'error'); }
  });
}
setInterval(pollStatus, 15000);

// ── Form: provider / role changes ──
function onRoleChange(s) {
  const role       = s.value;
  const isFlowwink = role === 'flowwink';

  const a2aBox  = document.querySelector('input[name="enableA2A"]');
  const yoloBox = document.querySelector('input[name="allowAll"]');
  if (a2aBox)  a2aBox.checked  = false;
  if (yoloBox) yoloBox.checked = isFlowwink;

  document.getElementById('mcp-row').style.display    = isFlowwink ? '' : 'none';
  document.getElementById('mcpkey-row').style.display = isFlowwink ? '' : 'none';
  document.getElementById('mcpUrl').required          = isFlowwink;
  document.getElementById('mcpKey').required          = isFlowwink;

  const roleData = (__initData.agentRoles || {})[role];
  const preview  = document.getElementById('role-preview');
  if (roleData && role !== 'generalist') {
    const emoji = ROLE_EMOJI[role] || '';
    preview.innerHTML = `<span style="margin-right:6px">${emoji}</span>${esc(roleData.description)}`;
    preview.style.display = '';
  } else {
    preview.style.display = 'none';
  }
}

function onProviderChange(s) {
  const m = document.getElementById('model');
  if ((__initData.modelPresets || {})[s.value]) m.value = __initData.modelPresets[s.value];
  const isPrivate = s.value === 'private';
  document.getElementById('baseurl-row').style.display = isPrivate ? '' : 'none';
  document.getElementById('baseUrl').required = isPrivate;
  const keyInp = document.getElementById('apiKey');
  const noKey  = (__initData.noKeyProviders || []).includes(s.value);
  keyInp.placeholder = isPrivate ? 'optional — leave blank if not required' : 'sk-...';
  keyInp.required = !noKey;
}

function onDomainInput(inp) {
  const v = inp.value.trim();
  const notice = document.getElementById('cname-notice');
  const label  = document.getElementById('cname-domain');
  if (v && v.includes('.')) { notice.style.display = ''; label.textContent = v; }
  else { notice.style.display = 'none'; }
}

// ── Manager modal ──
let mgrName = null, mgrPath = null, mgrTab = 'files', mgrImage = null, mgrDomain = null, mgrDirty = false;

function openMgr(name, tab = 'files', image = '', pushUrl = true) {
  mgrName = name; mgrPath = null; mgrImage = image;
  const inst = (__cachedInstances || []).find(i => i.name === name);
  mgrDomain = inst ? inst.domain : null;
  const domLink = document.getElementById('mgr-domain-link');
  if (mgrDomain) {
    domLink.href = 'https://' + mgrDomain;
    document.getElementById('mgr-domain-text').textContent = mgrDomain;
    domLink.style.display = '';
  } else { domLink.style.display = 'none'; }
  if (!chatHistory[name]) {
    try { const s = localStorage.getItem('chat_' + name); if (s) chatHistory[name] = JSON.parse(s); } catch {}
  }
  mgrDirty = false;
  document.getElementById('mgr-title').textContent = name;
  document.getElementById('mgr-editor').value = '';
  document.getElementById('btn-save').disabled = true;
  document.getElementById('mgr-status').textContent = '';
  document.getElementById('mgr-tree').innerHTML = '';
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('logs-filter').value = '';
  document.getElementById('mgr').classList.add('open');
  if (pushUrl && location.pathname !== '/instances/' + name) {
    history.pushState({ instance: name, tab }, '', '/instances/' + name);
  }
  refreshMgrBadge();
  switchTab(tab);
}
function closeMgr(pushUrl = true) {
  if (mgrDirty && !confirm('You have unsaved changes. Close anyway?')) return;
  mgrDirty = false;
  clearInterval(logsTimer); logsTimer = null;
  mgrCloseTerminal();
  document.getElementById('mgr').classList.remove('open');
  mgrName = null;
  if (pushUrl && location.pathname !== '/') {
    history.pushState({}, '', '/');
  }
}

window.addEventListener('popstate', e => {
  if (e.state && e.state.instance) {
    openMgr(e.state.instance, e.state.tab || 'files', '', false);
  } else {
    closeMgr(false);
  }
});

async function refreshMgrBadge() {
  const d = await api('GET', '/api/instances/' + mgrName + '/status');
  const b = document.getElementById('mgr-badge');
  b.textContent = d.status || '?'; b.className = 'badge ' + (d.status || 'error');
}

function switchTab(tab) {
  if (mgrTab === 'files' && mgrDirty && tab !== 'files') {
    if (!confirm('You have unsaved changes. Switch tab anyway?')) return;
    mgrDirty = false;
  }
  clearInterval(logsTimer); logsTimer = null;
  document.getElementById('logs-filter-bar').style.display = 'none';
  mgrTab = tab;
  ['files','logs','cli','exec','terminal','version','model','chat'].forEach(t =>
    document.getElementById('tab-' + t).className = 'tab' + (tab === t ? ' active' : '')
  );
  document.getElementById('mgr-editor').style.display        = tab === 'files'    ? ''      : 'none';
  document.getElementById('mgr-logs').style.display          = tab === 'logs'     ? 'block' : 'none';
  document.getElementById('mgr-cli').style.display           = tab === 'cli'      ? 'flex'  : 'none';
  document.getElementById('mgr-exec').style.display          = tab === 'exec'     ? 'flex'  : 'none';
  document.getElementById('mgr-terminal').style.display      = tab === 'terminal' ? 'flex'  : 'none';
  document.getElementById('mgr-version').style.display       = tab === 'version'  ? 'flex'  : 'none';
  document.getElementById('mgr-model').style.display         = tab === 'model'    ? 'flex'  : 'none';
  document.getElementById('mgr-chat').style.display          = tab === 'chat'     ? 'flex'  : 'none';
  document.getElementById('btn-save').style.display          = tab === 'files'    ? ''      : 'none';
  document.getElementById('btn-refresh-logs').style.display  = tab === 'logs'     ? ''      : 'none';
  document.getElementById('btn-copy-logs').style.display     = tab === 'logs'     ? ''      : 'none';
  document.getElementById('btn-backup').style.display        = tab === 'files'    ? ''      : 'none';
  document.getElementById('btn-restore').style.display       = tab === 'files'    ? ''      : 'none';
  document.getElementById('mgr-tree').style.display          = tab === 'files'    ? ''      : 'none';

  if (tab === 'files') {
    if (!document.getElementById('mgr-tree').children.length) loadTree('');
    document.getElementById('mgr-crumb').textContent = mgrPath || 'Select a file';
  } else if (tab === 'logs') {
    document.getElementById('mgr-crumb').textContent = 'Container logs (last 300 lines)';
    document.getElementById('logs-filter-bar').style.display = '';
    loadLogs();
    logsTimer = setInterval(loadLogs, 5000);
  } else if (tab === 'cli') {
    document.getElementById('mgr-crumb').textContent = 'OpenClaw CLI (node user)';
    setTimeout(() => document.getElementById('cli-cmd').focus(), 50);
  } else if (tab === 'version') {
    document.getElementById('mgr-crumb').textContent = 'OpenClaw version management';
    document.getElementById('version-current').textContent = mgrImage || 'unknown';
    const colonIdx = (mgrImage || '').lastIndexOf(':');
    const imgBase = colonIdx > 0 ? (mgrImage || '').slice(0, colonIdx + 1) : '';
    const imgTag  = colonIdx > 0 ? (mgrImage || '').slice(colonIdx + 1)    : (mgrImage || '');
    document.getElementById('version-base').textContent = imgBase;
    document.getElementById('version-input').value = imgTag;
    document.getElementById('version-status').textContent = '';
  } else if (tab === 'model') {
    document.getElementById('mgr-crumb').textContent = 'Model configuration';
    loadModel();
  } else if (tab === 'chat') {
    document.getElementById('mgr-crumb').textContent = 'Chat';
    api('GET', '/api/instances/' + mgrName + '/model').then(d => {
      if (!d.error && d.model) document.getElementById('mgr-crumb').textContent = `Chat — ${d.provider}/${d.model}`;
    });
    const msgs = document.getElementById('chat-messages');
    if (!msgs.children.length && chatHistory[mgrName]?.length) {
      chatHistory[mgrName].forEach(m => chatAddBubble(m.role, m.content));
      msgs.scrollTop = msgs.scrollHeight;
    }
    setTimeout(() => document.getElementById('chat-input').focus(), 50);
  } else if (tab === 'terminal') {
    document.getElementById('mgr-crumb').textContent = 'Interactive PTY terminal';
  } else {
    document.getElementById('mgr-crumb').textContent = 'Root shell (docker exec --user root)';
  }
}

// ── Chat ──
const chatHistory = {};
let chatStreaming  = false;

function renderMarkdown(text) {
  const blocks = [];
  text = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code)}</code></pre>`);
    return '\x00BLOCK' + (blocks.length - 1) + '\x00';
  });
  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\n/g, '<br>');
  text = text.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[i]);
  return text;
}

function saveChatHistory(name) {
  try {
    const msgs = (chatHistory[name] || []).slice(-60);
    localStorage.setItem('chat_' + name, JSON.stringify(msgs));
  } catch {}
}

function clearChat() {
  chatHistory[mgrName] = [];
  try { localStorage.removeItem('chat_' + mgrName); } catch {}
  document.getElementById('chat-messages').innerHTML = '';
}

function chatAddBubble(role, text, streaming = false) {
  const msgs  = document.getElementById('chat-messages');
  const wrap  = document.createElement('div');
  wrap.className = 'chat-msg';
  const label = document.createElement('div');
  label.className = 'chat-role';
  label.textContent = role === 'user' ? 'You' : mgrName;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble ' + role + (streaming ? ' streaming' : '');
  if (role === 'assistant' && !streaming && text) bubble.innerHTML = renderMarkdown(text);
  else bubble.textContent = text;
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return bubble;
}

async function sendChat() {
  if (chatStreaming) return;
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';
  if (!chatHistory[mgrName]) chatHistory[mgrName] = [];
  chatHistory[mgrName].push({ role: 'user', content: text });
  saveChatHistory(mgrName);
  chatAddBubble('user', text);
  const bubble = chatAddBubble('assistant', '', true);
  chatStreaming = true;
  document.getElementById('chat-send').disabled = true;
  let accumulated = '';
  try {
    const resp = await fetch('/api/instances/' + mgrName + '/chat', {
      method: 'POST',
      headers: { Authorization: window.__auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory[mgrName] }),
    });
    if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'response.output_text.delta' && ev.delta) {
            accumulated += ev.delta;
            bubble.textContent = accumulated;
            document.getElementById('chat-messages').scrollTop = 999999;
          } else if (ev.type === 'response.output_text.done' && ev.text && !accumulated) {
            accumulated = ev.text;
            bubble.textContent = accumulated;
          }
        } catch {}
      }
    }
  } catch (e) {
    accumulated = '(Error: ' + e.message + ')';
    bubble.textContent = accumulated;
  }
  bubble.classList.remove('streaming');
  if (accumulated) bubble.innerHTML = renderMarkdown(accumulated);
  chatStreaming = false;
  document.getElementById('chat-send').disabled = false;
  if (accumulated) {
    chatHistory[mgrName].push({ role: 'assistant', content: accumulated });
    saveChatHistory(mgrName);
  }
  input.focus();
}

function onModelProviderChange() {
  const p = document.getElementById('model-provider').value;
  document.getElementById('model-baseurl-row').style.display = p === 'private' ? '' : 'none';
  if (p !== 'private') document.getElementById('model-baseurl').value = '';
}

async function loadModel() {
  const st = document.getElementById('model-status');
  st.textContent = 'Loading…';
  const d = await api('GET', '/api/instances/' + mgrName + '/model');
  if (d.error) { st.textContent = 'Error: ' + d.error; return; }
  st.textContent = '';
  document.getElementById('model-provider').value = d.provider || 'openrouter';
  document.getElementById('model-name').value     = d.model    || '';
  document.getElementById('model-baseurl').value  = d.baseUrl  || '';
  document.getElementById('model-apikey').placeholder = d.hasApiKey ? 'Leave blank to keep existing key' : 'sk-...';
  onModelProviderChange();
}

async function saveModel() {
  const st       = document.getElementById('model-status');
  const provider = document.getElementById('model-provider').value;
  const model    = document.getElementById('model-name').value.trim();
  const apiKey   = document.getElementById('model-apikey').value.trim();
  const baseUrl  = document.getElementById('model-baseurl').value.trim();
  if (!model) { st.textContent = 'Model is required'; return; }
  st.textContent = 'Saving & restarting…';
  const d = await api('POST', '/api/instances/' + mgrName + '/model', { provider, model, apiKey, baseUrl });
  if (d.error) { st.style.color = 'var(--red)'; st.textContent = 'Error: ' + d.error; toast('Model update failed: ' + d.error, 'error'); return; }
  st.style.color = 'var(--green)'; st.textContent = 'Saved ✓ — restarting…';
  toast('Model updated — restarting container', 'success');
  setTimeout(async () => { await refreshMgrBadge(); st.textContent = ''; st.style.color = ''; }, 3000);
}

// ── File tree ──
const tree = document.getElementById('mgr-tree');
tree.addEventListener('click', async e => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  if (row.dataset.type === 'file') {
    tree.querySelectorAll('.tree-row').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
    loadFile(row.dataset.path);
  } else {
    const arrow    = row.querySelector('.tree-arrow');
    const children = row.nextElementSibling;
    const opening  = !children.classList.contains('open');
    if (arrow) arrow.classList.toggle('open', opening);
    children.classList.toggle('open', opening);
    if (opening && children.children.length === 0) {
      children.innerHTML = '<div style="padding:3px 8px;color:#333">Loading…</div>';
      const d = await api('GET', '/api/instances/' + mgrName + '/files?path=' + encodeURIComponent(row.dataset.path));
      children.innerHTML = d.error
        ? '<div style="padding:3px 8px;color:#f87171">' + esc(d.error) + '</div>'
        : buildTree(d.entries, row.dataset.path);
    }
  }
});

async function loadTree(dirPath) {
  tree.innerHTML = '<div style="padding:6px 8px;color:#333">Loading…</div>';
  const d = await api('GET', '/api/instances/' + mgrName + '/files?path=' + encodeURIComponent(dirPath));
  tree.innerHTML = d.error
    ? '<div style="padding:6px 8px;color:#f87171">' + esc(d.error) + '</div>'
    : buildTree(d.entries, dirPath);
}

function buildTree(entries, parent) {
  return entries.map(e => {
    const p = parent ? parent + '/' + e.name : e.name;
    if (e.type === 'dir') return `
      <div class="tree-row" data-type="dir" data-path="${esc(p)}">
        <span class="tree-arrow">▶</span>
        <span class="tree-icon" style="color:#6b7280">📁</span>
        <span class="tree-name">${esc(e.name)}</span>
      </div>
      <div class="tree-children"></div>`;
    const icon = p.endsWith('.json') ? '{}' : p.endsWith('.md') ? '📝' : p.endsWith('.log') || p.endsWith('.jsonl') ? '📋' : '📄';
    return `<div class="tree-row" data-type="file" data-path="${esc(p)}">
      <span class="tree-arrow" style="visibility:hidden">▶</span>
      <span class="tree-icon" style="color:#4b5563">${icon}</span>
      <span class="tree-name">${esc(e.name)}</span>
    </div>`;
  }).join('');
}

async function loadFile(path) {
  document.getElementById('mgr-crumb').textContent  = path;
  document.getElementById('mgr-status').textContent = 'Loading…';
  document.getElementById('btn-save').disabled = true;
  const d = await api('GET', '/api/instances/' + mgrName + '/files?path=' + encodeURIComponent(path));
  if (d.error) { document.getElementById('mgr-status').textContent = d.error; return; }
  mgrPath = path;
  document.getElementById('mgr-editor').value       = d.content;
  document.getElementById('mgr-status').textContent = '';
  document.getElementById('btn-save').disabled       = false;
  mgrDirty = false;
}

async function saveFile() {
  if (!mgrPath) return;
  const content = document.getElementById('mgr-editor').value;
  if (mgrPath.endsWith('.json') && !mgrPath.endsWith('.jsonl')) {
    try { JSON.parse(content); } catch (e) { document.getElementById('mgr-status').textContent = 'Invalid JSON: ' + e.message; return; }
  }
  document.getElementById('mgr-status').textContent = 'Saving…';
  document.getElementById('btn-save').disabled = true;
  const d = await api('POST', '/api/instances/' + mgrName + '/files', { path: mgrPath, content });
  document.getElementById('btn-save').disabled = false;
  if (d.success) {
    mgrDirty = false;
    document.getElementById('mgr-status').textContent = '';
    const isConfig = mgrPath.endsWith('openclaw.json');
    if (isConfig) {
      toastAction('openclaw.json saved — restart container to apply?', 'Restart', async () => {
        const r = await api('POST', '/api/instances/' + mgrName + '/action', { action: 'restart' });
        if (r.success) { toast('Restarting…', 'info'); setTimeout(refreshMgrBadge, 4000); }
        else toast('Restart failed: ' + r.error, 'error');
      });
    } else {
      toast('Saved ' + mgrPath, 'success');
    }
  } else {
    document.getElementById('mgr-status').textContent = 'Error: ' + d.error;
    toast('Save failed: ' + d.error, 'error');
  }
}

function downloadBackup() {
  const st = document.getElementById('mgr-status');
  st.textContent = 'Preparing backup…';
  fetch('/api/instances/' + mgrName + '/backup', { headers: { Authorization: window.__auth } })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url; a.download = mgrName + '-backup.tar.gz'; a.click();
      URL.revokeObjectURL(url); st.textContent = '';
    }).catch(e => { st.textContent = 'Backup failed: ' + e.message; });
}

async function uploadRestore(input) {
  const file = input.files[0]; input.value = '';
  if (!file) return;
  const st = document.getElementById('mgr-status');
  if (!confirm('Restore will stop the container, replace all files, then restart. Continue?')) return;
  st.textContent = 'Uploading…';
  try {
    const r = await fetch('/api/instances/' + mgrName + '/restore', {
      method: 'POST',
      headers: { Authorization: window.__auth, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const d = await r.json();
    if (d.success) {
      st.textContent = 'Restored ✓ — restarting…';
      document.getElementById('mgr-tree').innerHTML = '';
      setTimeout(() => { loadTree(''); refreshMgrBadge(); st.textContent = ''; }, 2500);
    } else { st.textContent = 'Restore failed: ' + d.error; }
  } catch (e) { st.textContent = 'Restore failed: ' + e.message; }
}

async function copyLogs() {
  const txt = document.getElementById('mgr-logs').textContent;
  if (!txt) return;
  await navigator.clipboard.writeText(txt);
  const btn = document.getElementById('btn-copy-logs');
  btn.textContent = '✓ Copied';
  setTimeout(() => btn.textContent = '⎘ Copy', 2000);
}

async function loadLogs() {
  const el = document.getElementById('mgr-logs');
  const atBottom = !el.textContent || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const d = await api('GET', '/api/instances/' + mgrName + '/logs');
  const raw = d.error ? ('Error: ' + d.error) : (d.logs || '(no logs)');
  el.dataset.raw = raw;
  filterLogs();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function filterLogs() {
  const el = document.getElementById('mgr-logs');
  const raw = el.dataset.raw || '';
  const q = (document.getElementById('logs-filter').value || '').toLowerCase();
  if (!q) { el.textContent = raw; return; }
  el.textContent = raw.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n');
}

// ── CLI tab ──
const cliHistory = []; let cliHistIdx = -1;

document.getElementById('cli-cmd').addEventListener('keydown', e => {
  if (e.key === 'Enter') { runCli(); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); if (cliHistIdx < cliHistory.length - 1) { cliHistIdx++; e.target.value = cliHistory[cliHistory.length - 1 - cliHistIdx] || ''; } }
  if (e.key === 'ArrowDown') { e.preventDefault(); if (cliHistIdx > 0) { cliHistIdx--; e.target.value = cliHistory[cliHistory.length - 1 - cliHistIdx] || ''; } else { cliHistIdx = -1; e.target.value = ''; } }
});

function cliShortcut(cmd) {
  const inp = document.getElementById('cli-cmd');
  inp.value = cmd; inp.focus(); inp.setSelectionRange(cmd.length, cmd.length);
}

async function runCli() {
  const inp = document.getElementById('cli-cmd');
  const out = document.getElementById('cli-output');
  const btn = document.getElementById('cli-run');
  const cmd = inp.value.trim();
  if (!cmd) return;
  cliHistory.push(cmd); cliHistIdx = -1;
  inp.value = ''; btn.disabled = true;
  out.textContent += '\n$ ' + cmd + '\n';
  out.scrollTop = out.scrollHeight;
  const d = await api('POST', '/api/instances/' + mgrName + '/cli', { cmd });
  if (d.error) { out.textContent += '[error] ' + d.error + '\n'; }
  else { out.textContent += (d.output || '(no output)'); if (d.exitCode !== 0) out.textContent += '[exit ' + d.exitCode + ']\n'; }
  out.scrollTop = out.scrollHeight;
  btn.disabled = false; inp.focus();
}

// ── Exec tab ──
const execHistory = []; let execHistIdx = -1;

document.getElementById('exec-cmd').addEventListener('keydown', e => {
  if (e.key === 'Enter') { runExec(); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); if (execHistIdx < execHistory.length - 1) { execHistIdx++; e.target.value = execHistory[execHistory.length - 1 - execHistIdx] || ''; } }
  if (e.key === 'ArrowDown') { e.preventDefault(); if (execHistIdx > 0) { execHistIdx--; e.target.value = execHistory[execHistory.length - 1 - execHistIdx] || ''; } else { execHistIdx = -1; e.target.value = ''; } }
});

async function runExec() {
  const inp = document.getElementById('exec-cmd');
  const out = document.getElementById('exec-output');
  const btn = document.getElementById('exec-run');
  const cmd = inp.value.trim();
  if (!cmd) return;
  execHistory.push(cmd); execHistIdx = -1;
  inp.value = ''; btn.disabled = true;
  out.textContent += '\n# ' + cmd + '\n';
  out.scrollTop = out.scrollHeight;
  const d = await api('POST', '/api/instances/' + mgrName + '/exec', { cmd });
  if (d.error) { out.textContent += '[error] ' + d.error + '\n'; }
  else { out.textContent += (d.output || '(no output)'); if (d.exitCode !== 0) out.textContent += '[exit ' + d.exitCode + ']\n'; }
  out.scrollTop = out.scrollHeight;
  btn.disabled = false; inp.focus();
}

async function mgrAction(action) {
  const s = document.getElementById('mgr-action-status');
  s.textContent = action + '…';
  await api('POST', '/api/instances/' + mgrName + '/action', { action });
  await refreshMgrBadge();
  s.textContent = 'Done';
  setTimeout(() => s.textContent = '', 2500);
}

async function recreateInstance() {
  const tag = document.getElementById('version-input').value.trim();
  if (!tag) { document.getElementById('version-status').textContent = 'Enter a version tag first'; return; }
  if (!confirm(`Recreate ${mgrName} with image tag "${tag}"? The container will be stopped and replaced.`)) return;
  const base  = document.getElementById('version-base').textContent;
  const image = (tag.includes('/') || !base) ? tag : base + tag;
  const btn   = document.getElementById('version-btn');
  const st    = document.getElementById('version-status');
  btn.disabled = true;
  st.textContent = 'Pulling image… this may take a minute';
  const d = await api('POST', '/api/instances/' + mgrName + '/recreate', { image });
  btn.disabled = false;
  if (d.error) { st.textContent = 'Error: ' + d.error; st.style.color = 'var(--red)'; }
  else {
    mgrImage = d.image;
    document.getElementById('version-current').textContent = d.image;
    st.textContent = 'Done — container running new image'; st.style.color = 'var(--green)';
    await refreshMgrBadge();
    const badge = document.getElementById('badge-' + mgrName);
    if (badge) { const s = await api('GET', '/api/instances/' + mgrName + '/status'); badge.textContent = s.status; badge.className = 'badge ' + (s.status || 'error'); }
    setTimeout(() => { st.textContent = ''; st.style.color = ''; }, 4000);
  }
}

// ── Page navigation ──
let sysTimer = null, ppTimer = null, logsTimer = null;

function showPage(name, pushUrl = true) {
  ['instances', 'system', 'paperclip'].forEach(p => {
    document.getElementById(p + '-page').style.display = name === p ? '' : 'none';
    document.getElementById('nav-' + p).classList.toggle('active', name === p);
  });
  clearInterval(sysTimer); clearInterval(ppTimer);
  if (name === 'system')    { loadSystem(); cfgLoad('.env'); sysTimer = setInterval(loadSystem, 5000); }
  if (name === 'paperclip') { loadPaperclip(); ppTimer = setInterval(loadPaperclip, 8000); }
  const urlMap = { instances: '/', system: '/system', paperclip: '/paperclip' };
  if (pushUrl && urlMap[name] && location.pathname !== urlMap[name]) {
    history.pushState({ page: name }, '', urlMap[name]);
  }
}

window.addEventListener('popstate', e => {
  if (e.state && e.state.page) {
    showPage(e.state.page, false);
  } else if (e.state && e.state.instance) {
    openMgr(e.state.instance, e.state.tab || 'files', '', false);
  } else {
    // Fallback: determine page from URL
    const p = location.pathname;
    if (p === '/system') showPage('system', false);
    else if (p === '/paperclip') showPage('paperclip', false);
    else { closeMgr(false); showPage('instances', false); }
  }
});

// ── Paperclip page ──
function fmtHB(secondsAgo) {
  if (secondsAgo === null || secondsAgo === undefined) return '<span style="color:var(--text3)">never</span>';
  if (secondsAgo < 120)  return `<span style="color:var(--green)">${secondsAgo}s ago</span>`;
  if (secondsAgo < 3600) return `<span style="color:var(--amber)">${Math.round(secondsAgo/60)}m ago</span>`;
  return `<span style="color:var(--red)">${Math.round(secondsAgo/3600)}h ago</span>`;
}

async function loadPaperclip() {
  let d;
  try { d = await api('GET', '/api/paperclip/status'); } catch { return; }

  const setCard = (id, running, status, sub) => {
    document.getElementById('pp-dot-' + id).className = 'pp-dot ' + (running ? 'ok' : 'err');
    document.getElementById('pp-val-' + id).textContent = status;
    document.getElementById('pp-sub-' + id).textContent = sub || '';
  };
  setCard('app', d.paperclip.running, d.paperclip.running ? 'Running' : d.paperclip.status);
  if (d.paperclip.image) {
    document.getElementById('pp-version-current').textContent = d.paperclip.image;
    const inp = document.getElementById('pp-version-input');
    if (!inp.value) inp.value = d.paperclip.image;
  }
  setCard('db',  d.db.running,        d.db.running  ? 'Running' : d.db.status);
  setCard('api', !!d.api, d.api ? d.api.status : 'unreachable', d.api?.deploymentMode || '');
  if (d.api) document.getElementById('pp-dot-api').className = 'pp-dot ' + (d.api.status === 'ok' ? 'ok' : 'warn');

  const instBody = document.getElementById('pp-inst-body');
  if (!d.instances.length) {
    instBody.innerHTML = '<tr><td colspan="4" style="color:var(--text3);padding:1.5rem;text-align:center">No instances found.</td></tr>';
  } else {
    instBody.innerHTML = d.instances.map(inst => {
      const isPending = d.pending.some(p => p.claw_name === inst.name);
      let statusCell, actionCell;
      if (inst.connected) {
        statusCell = '<span class="badge running">Connected</span>';
        actionCell = `<button class="btn ghost xs" onclick="ppDisconnect('${inst.name}')">Disconnect</button>`;
      } else if (isPending) {
        statusCell = '<span class="badge starting">Awaiting approval</span>';
        actionCell = `<button class="btn green xs" onclick="ppFinalize('${inst.name}')">Finalize</button>`;
      } else {
        statusCell = '<span class="badge stopped">Not connected</span>';
        actionCell = `<div class="pp-invite-row">
          <input id="invite-${inst.name}" placeholder="pcp_invite_…" style="font-size:0.75rem">
          <button class="btn sm" onclick="ppConnect('${inst.name}')">Connect</button>
        </div>`;
      }
      const hb = inst.agent ? fmtHB(inst.agent.secondsAgo) : '<span style="color:var(--text3)">—</span>';
      return `<tr>
        <td style="font-weight:500">${inst.name}</td>
        <td>${statusCell}</td>
        <td class="pp-hb">${hb}</td>
        <td>${actionCell}</td>
      </tr>`;
    }).join('');
  }

  if (d.agents.length) {
    document.getElementById('pp-agents-section').style.display = '';
    document.getElementById('pp-agents-body').innerHTML = d.agents.map(a => `<tr>
      <td style="font-weight:500">${a.name}</td>
      <td><span class="badge role">${a.role || '—'}</span></td>
      <td style="font-size:0.72rem;color:var(--text3);font-family:monospace">${a.url || '—'}</td>
      <td class="pp-hb">${fmtHB(a.secondsAgo)}</td>
    </tr>`).join('');
  } else {
    document.getElementById('pp-agents-section').style.display = 'none';
  }
}

async function ppConnect(clawName) {
  const token = document.getElementById('invite-' + clawName)?.value?.trim();
  if (!token) { alert('Paste an invite token first.'); return; }
  const d = await api('POST', '/api/paperclip/connect', { clawName, inviteToken: token });
  if (d.error) { alert('Error: ' + d.error + (d.detail ? '\n' + JSON.stringify(d.detail) : '')); return; }
  alert('Join request sent for ' + d.agentName + '.\n\nNow approve it in Paperclip UI, then click Finalize.');
  loadPaperclip();
}

async function ppFinalize(clawName) {
  const d = await api('POST', '/api/paperclip/finalize/' + clawName);
  if (d.error) { alert('Error: ' + d.error); return; }
  const stepLog = (d.steps || []).map(s => (s.ok ? '✓' : '✗') + ' ' + s.msg).join('\n');
  alert('Done!\n\n' + stepLog);
  loadPaperclip();
}

async function ppDisconnect(clawName) {
  if (!confirm('Remove Paperclip connection from ' + clawName + '?\nThis only removes local files, not the Paperclip agent record.')) return;
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
    `<div class="pp-fix-result">
      <span class="pp-fix-label">Fix ${r.fix}: ${r.label}</span>
      <span class="pp-fix-msg ${r.error ? 'error' : r.changed ? 'changed' : ''}">${r.msg}</span>
    </div>`
  ).join('');
  loadPaperclip();
}

// ── Paperclip exec shell ──
function ppUpdatePrompt() {
  const user   = document.getElementById('pp-exec-user').value;
  const prefix = document.getElementById('pp-exec-prefix');
  prefix.textContent = user === 'node' ? '$' : '#';
  prefix.style.color = user === 'node' ? '#4ade80' : '#f87171';
}
function ppShortcut(cmd, user) {
  if (user) document.getElementById('pp-exec-user').value = user;
  ppUpdatePrompt();
  document.getElementById('pp-exec-cmd').value = cmd;
  ppRunExec();
}
async function ppRunExec() {
  const input = document.getElementById('pp-exec-cmd');
  const out   = document.getElementById('pp-exec-output');
  const user  = document.getElementById('pp-exec-user').value;
  const cmd   = input.value.trim();
  if (!cmd) return;
  const prompt = user === 'node' ? '$ ' : '# ';
  out.textContent += '\n' + prompt + cmd + '\n';
  input.value = ''; out.scrollTop = 999999;
  const d = await api('POST', '/api/paperclip/exec', { cmd, user });
  out.textContent += (d.output || '(no output)') + '\n';
  out.scrollTop = 999999;
}
async function ppRestart() {
  const btn = document.getElementById('pp-restart-btn');
  const out = document.getElementById('pp-exec-output');
  btn.disabled = true; btn.textContent = 'Restarting…';
  out.textContent += '\n# Restarting Paperclip container…\n';
  out.scrollTop = 999999;
  const d = await api('POST', '/api/paperclip/restart');
  out.textContent += d.ok ? 'Done.\n' : ('Error: ' + (d.error || 'unknown') + '\n');
  out.scrollTop = 999999;
  btn.disabled = false; btn.textContent = '↺ Restart Paperclip';
}
async function ppRecreate() {
  const image  = document.getElementById('pp-version-input').value.trim();
  const status = document.getElementById('pp-version-status');
  if (!image) { status.textContent = 'Enter an image first'; return; }
  status.style.color = 'var(--text3)'; status.textContent = 'Pulling image… this may take a minute';
  const d = await api('POST', '/api/paperclip/recreate', { image });
  if (d.error) { status.style.color = 'var(--red)'; status.textContent = 'Error: ' + d.error; return; }
  status.style.color = 'var(--green)'; status.textContent = 'Done — running ' + d.image;
  document.getElementById('pp-version-current').textContent = d.image;
  setTimeout(() => { status.textContent = ''; status.style.color = ''; loadPaperclip(); }, 4000);
}

async function ppRunClaude() {
  const ta  = document.getElementById('pp-claude-prompt');
  const out = document.getElementById('pp-claude-output');
  const prompt = ta.value.trim();
  if (!prompt) return;
  out.textContent += '\n$ claude --print "' + prompt.replace(/"/g, '\\"') + '"\n';
  ta.value = ''; out.scrollTop = 999999;
  const escaped = prompt.replace(/'/g, "'\\''");
  const d = await api('POST', '/api/paperclip/exec', { cmd: "claude --dangerously-skip-permissions --print '" + escaped + "'", user: 'node' });
  out.textContent += (d.output || '(no output)') + '\n';
  out.scrollTop = 999999;
}
async function ppLoadLogs() {
  const out = document.getElementById('pp-exec-output');
  out.textContent = 'Loading logs…';
  const d = await api('GET', '/api/paperclip/logs');
  out.textContent = d.error ? ('Error: ' + d.error) : (d.logs || '(no logs)');
  out.scrollTop = 999999;
}

// ── PTY terminal (xterm.js) — shared helpers ──
const XTERM_THEME = {
  background: '#09090b', foreground: '#fafafa', cursor: '#3b82f6',
  black: '#09090b', red: '#ef4444', green: '#22c55e', yellow: '#f59e0b',
  blue: '#3b82f6', magenta: '#8b5cf6', cyan: '#06b6d4', white: '#e5e7eb',
  brightBlack: '#374151', brightRed: '#fca5a5', brightGreen: '#86efac',
  brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#c4b5fd',
  brightCyan: '#67e8f9', brightWhite: '#f9fafb',
};

async function openPtyTerminal(containerId, user, containerEl) {
  // Open and fit the terminal first so we know the real cols/rows before
  // the exec starts — critical for TUI apps like opencode that render
  // immediately on startup and don't handle late resizes gracefully.
  const term     = new Terminal({ theme: XTERM_THEME, fontSize: 13, fontFamily: 'Fira Code, Consolas, monospace', cursorBlink: true });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(containerEl);
  fitAddon.fit();

  const cols = term.cols;
  const rows = term.rows;

  const d = await api('POST', '/api/terminal/token', { container: containerId, user, cols, rows });
  if (d.error) { term.dispose(); alert('Terminal error: ' + d.error); return null; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws    = new WebSocket(`${proto}//${location.host}/ws/terminal?token=${d.token}`);
  ws.binaryType = 'arraybuffer';

  return { term, fitAddon, ws };
}

function wireTerminal(term, fitAddon, ws, containerEl) {
  // term is already opened on containerEl by openPtyTerminal
  ws.onopen = () => {
    // Size is already set server-side; send once more in case connection was slow
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = e => { term.write(new Uint8Array(e.data)); };
  ws.onclose   = () => { term.write('\r\n[Connection closed]\r\n'); };
  ws.onerror   = () => { term.write('\r\n[WebSocket error]\r\n'); };

  term.onData(data => {
    if (ws.readyState === 1) ws.send(new TextEncoder().encode(data));
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });

  const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
  ro.observe(containerEl);
  return ro;
}

// ── PTY: Paperclip ──
let ppPtyTerm = null, ppPtyWs = null, ppPtyRo = null;

async function ppOpenTerminal() {
  const user      = document.getElementById('pp-pty-user').value;
  const container = 'clawstack-paperclip-1';
  const card      = document.getElementById('pp-pty-card');
  card.style.display = '';
  document.getElementById('pp-pty-open-btn').style.display  = 'none';
  document.getElementById('pp-pty-close-btn').style.display = '';

  const containerEl = document.getElementById('pp-pty-container');
  const result = await openPtyTerminal(container, user, containerEl);
  if (!result) { card.style.display = 'none'; document.getElementById('pp-pty-open-btn').style.display = ''; document.getElementById('pp-pty-close-btn').style.display = 'none'; return; }
  const { term, fitAddon, ws } = result;
  ppPtyTerm = term; ppPtyWs = ws;
  ppPtyRo = wireTerminal(term, fitAddon, ws, containerEl);
}

function ppCloseTerminal() {
  if (ppPtyWs)  { ppPtyWs.close(); ppPtyWs = null; }
  if (ppPtyTerm) { ppPtyTerm.dispose(); ppPtyTerm = null; }
  if (ppPtyRo)  { ppPtyRo.disconnect(); ppPtyRo = null; }
  document.getElementById('pp-pty-card').style.display         = 'none';
  document.getElementById('pp-pty-open-btn').style.display     = '';
  document.getElementById('pp-pty-close-btn').style.display    = 'none';
  document.getElementById('pp-pty-container').innerHTML        = '';
}

// ── PTY: Manager Modal ──
let mgrPtyTerm = null, mgrPtyWs = null, mgrPtyRo = null;

async function mgrOpenTerminal() {
  if (!mgrName) return;
  const user   = document.getElementById('mgr-pty-user').value;
  const status = document.getElementById('mgr-pty-status');

  // Find container name for instance
  const inst   = await api('GET', '/api/instances/' + mgrName + '/status');
  const d      = await api('GET', '/api/instances');
  const row    = Array.isArray(d) ? d.find(i => i.name === mgrName) : null;
  if (!row) { status.textContent = 'Instance not found'; return; }

  status.textContent = 'Connecting…';
  document.getElementById('mgr-pty-open-btn').style.display  = 'none';
  document.getElementById('mgr-pty-close-btn').style.display = '';

  const containerEl = document.getElementById('mgr-pty-container');
  const result = await openPtyTerminal(row.container_name, user, containerEl);
  if (!result) { status.textContent = 'Failed to open terminal'; document.getElementById('mgr-pty-open-btn').style.display = ''; document.getElementById('mgr-pty-close-btn').style.display = 'none'; return; }

  const { term, fitAddon, ws } = result;
  mgrPtyTerm = term; mgrPtyWs = ws;
  status.textContent = '';
}

function mgrCloseTerminal() {
  if (mgrPtyWs)  { mgrPtyWs.close(); mgrPtyWs = null; }
  if (mgrPtyTerm) { mgrPtyTerm.dispose(); mgrPtyTerm = null; }
  if (mgrPtyRo)  { mgrPtyRo.disconnect(); mgrPtyRo = null; }
  const c = document.getElementById('mgr-pty-container');
  if (c) c.innerHTML = '';
  const openBtn  = document.getElementById('mgr-pty-open-btn');
  const closeBtn = document.getElementById('mgr-pty-close-btn');
  if (openBtn)  openBtn.style.display  = '';
  if (closeBtn) closeBtn.style.display = 'none';
}

// ── System page ──
function fmtBytes(b) {
  if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}

function setRing(id, pct, color) {
  const circ = 2 * Math.PI * 15.9;
  const el   = document.getElementById(id);
  if (!el) return;
  el.setAttribute('stroke-dasharray', `${(pct / 100 * circ).toFixed(1)} ${circ.toFixed(1)}`);
  if (color) el.style.stroke = color;
}

function ringColor(pct) {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 70) return 'var(--amber)';
  return null;
}

async function loadSystem() {
  let d;
  try { d = await api('GET', '/api/system'); } catch { return; }

  const cpuC = ringColor(d.cpu.pct);
  setRing('ring-cpu', d.cpu.pct, cpuC);
  document.getElementById('ring-cpu-val').textContent  = d.cpu.pct + '%';
  document.getElementById('stat-cpu-main').textContent = d.cpu.pct + '%';
  if (cpuC) document.getElementById('ring-cpu-val').style.color = cpuC;

  const memC = ringColor(d.mem.pct);
  setRing('ring-mem', d.mem.pct, memC);
  document.getElementById('ring-mem-val').textContent  = d.mem.pct + '%';
  document.getElementById('stat-mem-main').textContent = fmtBytes(d.mem.used);
  document.getElementById('stat-mem-sub').textContent  = 'of ' + fmtBytes(d.mem.total);

  const diskC = ringColor(d.disk.pct);
  setRing('ring-disk', d.disk.pct, diskC);
  document.getElementById('ring-disk-val').textContent  = d.disk.pct + '%';
  document.getElementById('stat-disk-main').textContent = fmtBytes(d.disk.used);
  document.getElementById('stat-disk-sub').textContent  = 'of ' + fmtBytes(d.disk.total);

  const body = document.getElementById('ct-body');
  body.innerHTML = d.containers.map(c => {
    const memBarPct  = Math.min(c.memPct, 100);
    const cpuBarPct  = Math.min(c.cpuPct * 5, 100);
    const memBarClass = c.memPct >= 90 ? 'danger' : c.memPct >= 70 ? 'warn' : 'mem';
    const imgTag  = c.image.includes(':') ? c.image.split(':').pop() : c.image;
    const imgBase = c.image.includes('/') ? c.image.split('/').pop().split(':')[0] : c.image.split(':')[0];
    const running = c.status === 'running';
    return `<div class="ct-row" id="ct-row-${c.id}">
      <div class="ct-name-cell">
        <span class="ct-dot ${c.status}"></span>
        <span class="ct-name-text" title="${c.name}">${c.name}</span>
      </div>
      <div><span class="ct-status-badge ${c.status}">${c.status}</span></div>
      <div>
        <div class="ct-cpu-pct">${running ? c.cpuPct.toFixed(1) + '%' : '—'}</div>
        <div class="mini-bar-wrap"><div class="mini-bar-fill cpu" style="width:${cpuBarPct}%"></div></div>
      </div>
      <div>
        <div class="ct-stat-val">${c.memLimit > 0 ? fmtBytes(c.memUsed) + ' / ' + fmtBytes(c.memLimit) : '—'}</div>
        <div class="mini-bar-wrap"><div class="mini-bar-fill ${memBarClass}" style="width:${memBarPct}%"></div></div>
      </div>
      <div class="ct-image-tag" title="${c.image}">${imgBase}:<span style="color:var(--text2)">${imgTag}</span></div>
      <div class="ct-actions">
        ${running
          ? `<button class="btn amber xs" onclick="ctAction('${c.id}','restart')">↺</button>
             <button class="btn ghost xs"  onclick="ctAction('${c.id}','stop')">■</button>`
          : `<button class="btn green xs"  onclick="ctAction('${c.id}','start')">▶</button>`}
        <button class="btn danger xs" onclick="ctRemove('${c.id}','${esc(c.name)}')" title="Remove">✕</button>
      </div>
    </div>`;
  }).join('');

  const maxSize      = Math.max(...(d.images || []).map(i => i.size), 1);
  const totalImgSize = (d.images || []).reduce((s, i) => s + i.size, 0);
  document.getElementById('sys-images-total').textContent = (d.images || []).length + ' images — ' + fmtBytes(totalImgSize);
  document.getElementById('img-body').innerHTML = (d.images || []).map(img => {
    const barPct    = Math.round(img.size / maxSize * 100);
    const shortRepo = img.repo.includes('/') ? img.repo.split('/').slice(-2).join('/') : img.repo;
    const badge     = img.dangling
      ? '<span class="dangling-badge">dangling</span>'
      : img.inUse
        ? '<span class="inuse-badge">in use</span>'
        : '<span style="font-size:0.65rem;color:var(--text3)">unused</span>';
    return `<tr>
      <td class="img-repo" title="${img.repo}">${shortRepo}</td>
      <td class="img-tag">${img.tag}</td>
      <td class="img-size">
        ${fmtBytes(img.size)}
        <div class="img-size-bar"><div class="img-size-fill" style="width:${barPct}%"></div></div>
      </td>
      <td>${badge}</td>
    </tr>`;
  }).join('');

  const now = new Date();
  document.getElementById('sys-refresh-ts').textContent = 'Updated ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Config editor ──
let cfgCurrentFile = '.env';
const cfgTabMap = { '.env': 'cfg-tab-env', 'docker-compose.yml': 'cfg-tab-compose', 'Caddyfile': 'cfg-tab-caddyfile', 'claw-defaults': 'cfg-tab-clawdefaults' };
const cfgHints  = {
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
  const d   = await api('GET', url);
  editor.value = d.error ? ('Error: ' + d.error) : d.content;
}

async function cfgSave() {
  const btn = document.getElementById('cfg-save-btn');
  const st  = document.getElementById('cfg-status');
  btn.disabled = true;
  const content = document.getElementById('cfg-editor').value;
  const url = cfgCurrentFile === 'claw-defaults' ? '/api/system/claw-defaults' : '/api/system/config/' + encodeURIComponent(cfgCurrentFile);
  const d   = await api('POST', url, { content });
  btn.disabled = false;
  if (d.error) { st.style.color = 'var(--red)'; st.textContent = 'Error: ' + d.error; }
  else         { st.style.color = 'var(--green)'; st.textContent = 'Saved.'; setTimeout(() => st.textContent = '', 3000); }
}

document.getElementById('cfg-editor').addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const t = e.target, s = t.selectionStart, end = t.selectionEnd;
  t.value = t.value.slice(0, s) + '  ' + t.value.slice(end);
  t.selectionStart = t.selectionEnd = s + 2;
});

async function ctAction(id, action) {
  const row = document.getElementById('ct-row-' + id);
  if (row) row.style.opacity = '0.5';
  await api('POST', '/api/system/containers/' + id + '/action', { action });
  loadSystem();
}

async function ctRemove(id, name) {
  if (!confirm('Remove container ' + name + '?\n\nThe container will be stopped and deleted.')) return;
  const row = document.getElementById('ct-row-' + id);
  if (row) row.style.opacity = '0.5';
  const d = await api('DELETE', '/api/system/containers/' + id);
  if (d.error) alert('Error: ' + d.error);
  loadSystem();
}

async function runContainer() {
  const image   = document.getElementById('run-image').value.trim();
  const name    = document.getElementById('run-name').value.trim();
  const network = document.getElementById('run-network').value.trim();
  const restart = document.getElementById('run-restart').value;
  const env     = document.getElementById('run-env').value.split('\n').map(s => s.trim()).filter(Boolean);
  const status  = document.getElementById('run-ct-status');
  if (!image) { status.textContent = 'Image is required'; return; }
  status.style.color = 'var(--text3)'; status.textContent = 'Pulling & starting…';
  const d = await api('POST', '/api/system/containers/run', { image, name: name || undefined, network, restart, env });
  if (d.error) { status.style.color = 'var(--red)'; status.textContent = 'Error: ' + d.error; return; }
  status.style.color = 'var(--green)'; status.textContent = 'Running: ' + d.name;
  document.getElementById('run-ct-form').style.display = 'none';
  setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 4000);
  loadSystem();
}

async function pruneImages() {
  const btn = document.getElementById('prune-btn');
  btn.disabled = true; btn.textContent = 'Pruning…';
  const d  = await api('POST', '/api/system/prune');
  btn.disabled = false; btn.textContent = 'Prune unused';
  const el = document.getElementById('prune-result');
  el.style.display = '';
  if (d.error) { el.style.color = 'var(--red)'; el.textContent = 'Error: ' + d.error; }
  else         { el.style.color = 'var(--green)'; el.textContent = 'Removed ' + d.count + ' image(s), freed ' + fmtBytes(d.freed) + '.'; }
  loadSystem();
}

document.getElementById('mgr-editor').addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const t = e.target, s = t.selectionStart, end = t.selectionEnd;
  t.value = t.value.slice(0, s) + '  ' + t.value.slice(end);
  t.selectionStart = t.selectionEnd = s + 2;
});

document.getElementById('mgr-editor').addEventListener('input', () => { if (mgrPath) mgrDirty = true; });

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    if (document.getElementById('mgr').classList.contains('open') && mgrTab === 'files' && mgrPath) {
      e.preventDefault(); saveFile();
    }
    return;
  }
  if (e.key === 'Escape' && document.getElementById('mgr').classList.contains('open') && !e.target.closest('input, textarea, select')) {
    closeMgr();
  }
});

// ── Toast ──
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}

function toastAction(msg, label, onClick) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast info toast-action';
  const span = document.createElement('span'); span.textContent = msg;
  const btn  = document.createElement('button');
  btn.className = 'toast-btn'; btn.textContent = label;
  btn.onclick = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); onClick(); };
  t.appendChild(span); t.appendChild(btn);
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 12000);
}

// ── Boot ──
init();
