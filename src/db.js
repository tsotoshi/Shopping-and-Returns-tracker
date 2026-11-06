// SQLite database setup. SQLite stores everything in one file on disk
// (data/tracker.sqlite by default), so there's no database server to run.
// Money is stored as integer cents to avoid floating-point rounding errors.
//
// We use the SQLite that's BUILT INTO Node.js (node:sqlite), so there's no
// add-on to download or compile — installing works on any computer.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  retailer TEXT NOT NULL,
  order_number TEXT NOT NULL,
  order_date TEXT,
  payment_method TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (retailer, order_number)          -- one row per real order: no duplicates
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  retailer_item_id TEXT,                   -- e.g. Amazon ASIN, when the email has it
  seller TEXT,                             -- third-party seller name; NULL = sold by retailer
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER,
  estimated_delivery_date TEXT,
  delivered_date TEXT,
  stage TEXT NOT NULL DEFAULT 'purchased',
  split_from_item_id INTEGER REFERENCES items(id),

  -- Return policy result currently in effect (from sample, AI, or you)
  policy_json TEXT,
  policy_origin TEXT,                      -- 'sample' | 'ai' | 'user'
  policy_explanation TEXT,
  policy_url TEXT,
  policy_checked_at TEXT,
  eligibility TEXT DEFAULT 'unknown',      -- eligible | not_eligible | unknown
  return_deadline TEXT,
  return_deadline_status TEXT DEFAULT 'needs_review',
  return_deadline_basis TEXT,
  dropoff_deadline TEXT,
  dropoff_deadline_status TEXT,
  dropoff_deadline_basis TEXT,
  deadline_locked_by_user INTEGER NOT NULL DEFAULT 0,

  -- Return logistics
  return_started_at TEXT,
  email_dropoff_by TEXT,
  dropped_off_at TEXT,
  dropoff_source TEXT,                     -- 'email' | 'manual'
  return_received_at TEXT,
  return_instructions TEXT,
  label_url TEXT,
  qr_url TEXT,

  notes TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'gmail',
  message_id TEXT NOT NULL,
  thread_id TEXT,
  retailer TEXT,
  kind TEXT NOT NULL,
  subject TEXT,
  from_addr TEXT,
  received_at TEXT,
  web_link TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  parsed_json TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, message_id)            -- importing the same email twice is a no-op
);

CREATE TABLE IF NOT EXISTS email_items (
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (email_id, item_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  occurred_at TEXT,
  source TEXT NOT NULL,                    -- 'email' | 'manual' | 'system'
  email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  expected_cents INTEGER,
  destination TEXT,
  issued_cents INTEGER NOT NULL DEFAULT 0,
  issued_at TEXT,
  confirmed_cents INTEGER NOT NULL DEFAULT 0,
  confirmed_at TEXT,
  window_kind TEXT,                        -- 'retailer' | 'default_interval' | 'none'
  window_start TEXT,
  window_end TEXT,
  window_basis TEXT,
  window_assumption TEXT,
  next_check_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|issued|partial|problem|confirmed|resolved
  problem_note TEXT,
  resolution_note TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS policy_reviews (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,                    -- 'sample' | 'ai' | 'user'
  status TEXT NOT NULL,                    -- 'applied' | 'suggested' | 'rejected'
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Stage 2: Gmail connection (one account). Tokens live only here, on your computer.
CREATE TABLE IF NOT EXISTS gmail_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_expires_at INTEGER,               -- ms since epoch
  scope TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  needs_reconnect INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT
);

-- Emails we looked at and deliberately ignored (ads, cancellations, ...),
-- so the next sync doesn't download them again.
CREATE TABLE IF NOT EXISTS skipped_messages (
  provider TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reason TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, message_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,                    -- running | ok | error
  found INTEGER DEFAULT 0, imported INTEGER DEFAULT 0, already_had INTEGER DEFAULT 0,
  needs_review INTEGER DEFAULT 0, ignored INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
  message TEXT
);

-- Stage 4: reminders. "key" makes each reminder happen once
-- (e.g. "return:12:2026-11-20:soon" for one item's one deadline).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  private_body TEXT,                       -- version without item names, for push
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  delivered_at TEXT,                       -- sent to push/email (or decided not to)
  delivery_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_order ON items(order_id);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
`;

// Settings live in src/settings.js; re-exported here so existing imports keep working.
export { getSettings } from './settings.js';
import { seedSettings } from './settings.js';

// A thin adapter so the rest of the app can use simple calls:
//   db.prepare(sql).run(...) / .get(...) / .all(...)   and   db.transaction(fn)
// It (1) passes only the named values a statement actually uses, (2) returns
// rows as ordinary objects, and (3) treats undefined as NULL.
const NAMED = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;

function wrapStatement(stmt, sql) {
  const names = [...new Set([...sql.matchAll(NAMED)].map((m) => m[1]))];
  const fix = (args) => {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && names.length) {
      const src = args[0];
      return [Object.fromEntries(names.map((n) => [n, src[n] === undefined ? null : src[n]]))];
    }
    return args.map((a) => (a === undefined ? null : a));
  };
  const plain = (row) => (row ? { ...row } : row);
  return {
    run: (...args) => stmt.run(...fix(args)),
    get: (...args) => plain(stmt.get(...fix(args))),
    all: (...args) => stmt.all(...fix(args)).map(plain),
  };
}

class Db {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.depth = 0;
  }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) { return wrapStatement(this.raw.prepare(sql), sql); }
  close() { this.raw.close(); }
  /** db.transaction(fn) returns a function that runs fn all-or-nothing. Nested calls join the outer one. */
  transaction(fn) {
    return (...args) => {
      if (this.depth > 0) return fn(...args);
      this.raw.exec('BEGIN');
      this.depth++;
      try {
        const result = fn(...args);
        this.raw.exec('COMMIT');
        return result;
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      } finally {
        this.depth--;
      }
    };
  }
}

export function openDb(file = process.env.DB_PATH || './data/tracker.sqlite') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Db(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seedSettings(db);
  return db;
}

// Columns added after Stage 1. Adding them here upgrades an existing
// database file in place without losing data.
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function migrate(db) {
  ensureColumn(db, 'refunds', 'timing_json', 'TEXT'); // refund timing stated in a refund email
  ensureColumn(db, 'items', 'policy_user_url', 'TEXT'); // a policy link you supplied (Stage 3)
  ensureColumn(db, 'items', 'email_name', 'TEXT'); // the name as the retailer's emails say it (kept for matching if you rename)
  ensureColumn(db, 'orders', 'merchant_name', 'TEXT'); // display name for stores other than Amazon
  ensureColumn(db, 'items', 'name_source', 'TEXT'); // 'email' | 'amazon_site' | 'you'
  db.exec(`CREATE TABLE IF NOT EXISTS ignored_stores (domain TEXT PRIMARY KEY, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  ensureColumn(db, 'skipped_messages', 'subject', 'TEXT');
  ensureColumn(db, 'skipped_messages', 'from_addr', 'TEXT');
  ensureColumn(db, 'skipped_messages', 'received_at', 'TEXT');
  ensureColumn(db, 'skipped_messages', 'parser_version', 'INTEGER'); // re-check when the parser improves
}

