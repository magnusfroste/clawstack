'use strict';
const Docker = require('dockerode');
const { createProxyMiddleware } = require('http-proxy-middleware');
const httpProxy = require('http-proxy');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// HTTP proxy cache: keyed by 'containerName:port'
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

// WebSocket proxy (http-proxy directly — hpm v3 lacks handleUpgrade)
const wsProxyServer = httpProxy.createProxyServer({});
wsProxyServer.on('error', (err, req, socket) => {
  console.error('[ws-proxy] error:', err.message);
  if (socket?.writable) socket.destroy();
});
function proxyWs(req, socket, head, containerName, port = 18789) {
  wsProxyServer.ws(req, socket, head, { target: `ws://${containerName}:${port}` });
}

// Demux Docker multiplexed stream (used when Tty: false)
function demux(buf) {
  let offset = 0;
  const lines = [];
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    lines.push(buf.slice(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return lines.join('') || buf.toString('utf8');
}

async function containerExec(containerName, cmd, user = 'root', timeoutMs = 30000) {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
    User: user,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', d => chunks.push(d));
    stream.on('end', resolve);
    stream.on('error', reject);
    setTimeout(resolve, timeoutMs);
  });
  const buf = Buffer.concat(chunks);
  const output = demux(buf).trim();
  const info = await exec.inspect();
  return { output, exitCode: info.ExitCode };
}

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

module.exports = { docker, getProxy, proxyWs, containerExec, httpJSON, demux };
