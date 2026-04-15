'use strict';
const fs   = require('fs');
const path = require('path');
const { INSTANCES_DIR } = require('./config');

const FULL_SCOPES = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
];

// Upgrade any gateway-client device entry that is missing operator.pairing.
// Returns true if the file was modified.
function patchPairedJson(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return false; }

  let devices;
  try { devices = JSON.parse(raw); } catch { return false; }

  let changed = false;
  for (const d of Object.values(devices)) {
    if (d.clientMode !== 'backend') continue;
    if ((d.scopes || []).includes('operator.pairing')) continue;

    d.scopes         = FULL_SCOPES;
    d.approvedScopes = FULL_SCOPES;
    if (d.tokens?.operator) d.tokens.operator.scopes = FULL_SCOPES;
    changed = true;
    console.log(`[device-watcher] granted operator.pairing to ${d.clientId} device ${d.deviceId?.slice(0, 12)} in ${filePath}`);
  }

  if (changed) {
    try { fs.writeFileSync(filePath, JSON.stringify(devices, null, 2)); } catch (e) {
      console.error('[device-watcher] write failed:', e.message);
      return false;
    }
  }
  return changed;
}

// Watch a single paired.json file. Re-creates the watcher on rename (atomic writes).
function watchFile(filePath) {
  let debounce = null;
  const trigger = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => patchPairedJson(filePath), 200);
  };

  // Patch immediately on startup in case file already has under-scoped devices.
  patchPairedJson(filePath);

  try {
    fs.watch(filePath, { persistent: false }, (event) => {
      // 'rename' fires on atomic writes (write-new + rename-over); re-attach.
      if (event === 'rename') {
        try { fs.watch(filePath, { persistent: false }, () => trigger()); } catch {}
      }
      trigger();
    });
  } catch {
    // File may not exist yet; the directory watcher will catch it when created.
  }
}

// Watch an instance's devices directory for paired.json appearing or changing.
function watchInstanceDir(instanceName) {
  const devicesDir = path.join(INSTANCES_DIR, instanceName, 'config', 'devices');
  const pairedPath = path.join(devicesDir, 'paired.json');

  // Patch existing file right away.
  watchFile(pairedPath);

  // Also watch the devices directory for the file being created later.
  try {
    fs.watch(devicesDir, { persistent: false }, (event, filename) => {
      if (filename === 'paired.json') watchFile(pairedPath);
    });
  } catch {}
}

// Watch the top-level instances directory for new instance subdirectories.
function start() {
  // Bootstrap existing instances.
  try {
    fs.readdirSync(INSTANCES_DIR).forEach(name => {
      const stat = fs.statSync(path.join(INSTANCES_DIR, name));
      if (stat.isDirectory()) watchInstanceDir(name);
    });
  } catch {}

  // Pick up newly-created instances.
  try {
    fs.watch(INSTANCES_DIR, { persistent: false }, (event, name) => {
      if (!name) return;
      const p = path.join(INSTANCES_DIR, name);
      try { if (fs.statSync(p).isDirectory()) watchInstanceDir(name); } catch {}
    });
  } catch (e) {
    console.error('[device-watcher] could not watch instances dir:', e.message);
  }

  console.log('[device-watcher] watching for under-scoped gateway-client devices');
}

module.exports = { start, patchPairedJson };
