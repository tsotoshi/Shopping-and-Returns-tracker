// "Sync emails": ask Gmail for retailer emails, skip ones we've already seen,
// parse the rest, and hand them to the import pipeline.
//
// Designed so background syncing (Stage 4) can call syncGmail() on a timer.

import { addDays } from '../lib/dates.js';
import { ingestParsedEmail } from './ingest.js';
import { decodeMessage, gmailWebLink } from '../gmail/client.js';
import { getAccount } from '../gmail/account.js';
import { RETAILERS } from '../retailers/index.js';

let running = false;
export const isSyncing = () => running;

export function lastSyncRun(db) {
  return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() ?? null;
}

export async function syncGmail(db, { client, firstSyncDays = 180, maxMessages = 500, retailers = RETAILERS } = {}) {
  if (running) throw new Error('A sync is already running.');
  running = true;
  const startedAt = new Date().toISOString();
  const runId = db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(startedAt).lastInsertRowid;
  const c = { found: 0, imported: 0, already_had: 0, needs_review: 0, ignored: 0, failed: 0 };
  const seen = db.prepare("SELECT 1 FROM emails WHERE provider = 'gmail' AND message_id = ? UNION SELECT 1 FROM skipped_messages WHERE provider = 'gmail' AND message_id = ?");
  const skip = db.prepare("INSERT OR IGNORE INTO skipped_messages (provider, message_id, reason) VALUES ('gmail', ?, ?)");
  const errors = [];

  try {
    const account = getAccount(db);
    // After the first sync, only look back a few days before the last one
    // (overlap is harmless: already-imported emails are skipped by ID).
    const since = account?.last_sync_at ? addDays(account.last_sync_at.slice(0, 10), -3) : null;

    for (const r of Object.values(retailers)) {
      if (!r.parse) continue;
      const q = `${r.gmailQuery} ${since ? `after:${since.replace(/-/g, '/')}` : `newer_than:${firstSyncDays}d`}`;
      const ids = (await client.listMessageIds(q, maxMessages)).reverse(); // oldest first: orders before deliveries
      c.found += ids.length;
      for (const id of ids) {
        if (seen.get(id, id)) { c.already_had++; continue; }
        try {
          const msg = decodeMessage(await client.getMessage(id));
          const parsed = r.parse(msg);
          if (!parsed) { skip.run(id, 'not an order, shipping, return, or refund email'); c.ignored++; continue; }
          parsed.webLink = gmailWebLink(id, account?.email);
          const res = ingestParsedEmail(db, parsed);
          if (res.status === 'duplicate') c.already_had++;
          else if (res.status === 'imported') c.imported++;
          else { c.imported += res.itemIds.length ? 1 : 0; c.needs_review++; }
        } catch (e) {
          if (e.reconnect || e.status === 401) throw e; // stop the whole sync
          c.failed++;
          errors.push(e.message);
        }
      }
    }
    db.prepare("UPDATE gmail_account SET last_sync_at = datetime('now') WHERE id = 1").run();
    db.prepare(`UPDATE sync_runs SET finished_at = @finished, status = 'ok', found = @found, imported = @imported, already_had = @already_had,
                needs_review = @needs_review, ignored = @ignored, failed = @failed, message = @message WHERE id = @id`)
      .run({ ...c, finished: new Date().toISOString(), message: errors.slice(0, 3).join('; ') || null, id: runId });
    return { ok: true, ...c };
  } catch (e) {
    db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'error', message = ? WHERE id = ?").run(new Date().toISOString(), e.message, runId);
    throw e;
  } finally {
    running = false;
  }
}
