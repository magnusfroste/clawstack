'use strict';
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { docker } = require('./docker');

// Short-lived one-time tokens: token → { container, user, expires }
const tokenStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [t, e] of tokenStore) if (e.expires < now) tokenStore.delete(t);
}, 60_000);

function createTerminalToken(container, user) {
  const token = crypto.randomBytes(16).toString('hex');
  tokenStore.set(token, { container, user, expires: Date.now() + 30_000 });
  return token;
}

function createWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (ws, { container, user }) => {
    let execStream;
    let execInstance;

    try {
      const c = docker.getContainer(container);
      execInstance = await c.exec({
        Cmd: ['/bin/bash'],
        AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Tty: true, User: user,
        Env: ['TERM=xterm-256color', ...(user === 'node' ? ['HOME=/home/node'] : [])],
      });

      execStream = await execInstance.start({ hijack: true, stdin: true });

      // Docker TTY → browser (binary frames)
      execStream.on('data', chunk => {
        if (ws.readyState === 1) ws.send(chunk, { binary: true });
      });
      execStream.on('end', () => {
        if (ws.readyState === 1) ws.close(1000, 'Process exited');
      });

      // Browser → Docker TTY
      ws.on('message', (msg, isBinary) => {
        if (!isBinary) {
          // JSON control message (resize)
          try {
            const p = JSON.parse(msg.toString());
            if (p.type === 'resize' && execInstance) {
              execInstance.resize({ h: p.rows, w: p.cols }).catch(() => {});
            }
          } catch {}
        } else if (execStream && !execStream.destroyed) {
          execStream.write(msg);
        }
      });

      ws.on('close', () => { try { execStream?.end(); } catch {} });
      ws.on('error', () => { try { execStream?.destroy(); } catch {} });

    } catch (e) {
      console.error('[terminal] error:', e.message);
      if (ws.readyState === 1) ws.close(1011, e.message);
    }
  });

  return wss;
}

module.exports = { createWss, createTerminalToken, tokenStore };
