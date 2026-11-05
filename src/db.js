// SQLite database setup. SQLite stores everything in one file on disk
// (data/tracker.sqlite by default), so there's no database server to run.
// Money is stored as integer cents to avoid floating-point rounding errors.

import Database from 'better-sqlite3';
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

CREATE INDEX IF NOT EXISTS idx_items_order ON items(order_id);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
`;

export const DEFAULT_SETTINGS = {
  refund_reminder_days: '10', // used when retailer refund timing is unknown
  snooze_days: '3', // "Not yet — remind me again"
  overdue_grace_days: '7', // days after the posting window before "overdue"
  deadline_warning_days: '14', // show return deadlines this far ahead
};

export function openDb(file = process.env.DB_PATH || './data/tracker.sqlite') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
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
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    refundReminderDays: Number(s.refund_reminder_days),
    snoozeDays: Number(s.snooze_days),
    overdueGraceDays: Number(s.overdue_grace_days),
    deadlineWarningDays: Number(s.deadline_warning_days),
  };
}
