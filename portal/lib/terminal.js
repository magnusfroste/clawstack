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

function createTerminalToken(container, user, cols, rows) {
  const token = crypto.randomBytes(16).toString('hex');
  tokenStore.set(token, { container, user, cols: cols || 220, rows: rows || 50, expires: Date.now() + 30_000 });
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

      // Set initial terminal size immediately so TUI apps (opencode etc.) start
      // with correct dimensions instead of the default 80×24.
      execInstance.resize({ h: entry.rows, w: entry.cols }).catch(() => {});

      // Docker TTY → browser (binary frames)
      // Coalesce chunks that arrive in the same I/O tick so that escape
      // sequences (e.g. \x1bN, \x1bV) are never split across WS frames.
      let pending = null;
      execStream.on('data', chunk => {
        if (pending === null) {
          pending = chunk;
          setImmediate(() => {
            if (ws.readyState === 1) ws.send(pending, { binary: true });
            pending = null;
          });
        } else {
          pending = Buffer.concat([pending, chunk]);
        }
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
