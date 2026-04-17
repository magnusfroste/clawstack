'use strict';
const Database = require('better-sqlite3');

const db = new Database('/data/clawstack.db');

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

try { db.exec(`ALTER TABLE instances ADD COLUMN role TEXT DEFAULT 'generalist'`); } catch {}
try { db.exec(`ALTER TABLE instances ADD COLUMN image TEXT`); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS paperclip_pending (
  claw_name    TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL,
  claim_secret TEXT NOT NULL,
  gw_token     TEXT NOT NULL,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bridge_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    thread    TEXT    NOT NULL DEFAULT 'main',
    sender    TEXT    NOT NULL,
    message   TEXT    NOT NULL,
    meta      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_thread ON bridge_messages(thread, id)`); } catch {}

module.exports = db;
