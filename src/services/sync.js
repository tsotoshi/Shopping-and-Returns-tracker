// "Sync emails": ask Gmail for retailer emails, skip ones we've already seen,
// parse the rest, and hand them to the import pipeline.
//
// Designed so background syncing (Stage 4) can call syncGmail() on a timer.

import { addDays } from '../lib/dates.js';
import { ingestParsedEmail } from './ingest.js';
import { decodeMessage, decodeMeta, gmailWebLink } from '../gmail/client.js';
import { getAccount } from '../gmail/account.js';
import { RETAILERS } from '../retailers/index.js';

let running = false;
export const isSyncing = () => running;

export function lastSyncRun(db) {
  return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() ?? null;
}

export async function syncGmail(db, { client, firstSyncDays = 180, maxMessages = 500, retailers = RETAILERS, amazonFromSite = false } = {}) {
  if (running) throw new Error('A sync is already running.');
  running = true;
  const startedAt = new Date().toISOString();
  const runId = db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(startedAt).lastInsertRowid;
  const c = { found: 0, imported: 0, already_had: 0, needs_review: 0, ignored: 0, failed: 0 };
  // Already imported (an email with several orders is stored as "<id>#<order>"), or
  // skipped by the CURRENT parser version. Emails skipped by an older parser are re-checked.
  const imported = db.prepare("SELECT 1 FROM emails WHERE provider = 'gmail' AND (message_id = @id OR message_id LIKE @prefix)");
  // Each store group remembers its own skips ("gmail:amazon", "gmail:other").
  const skippedNow = db.prepare('SELECT 1 FROM skipped_messages WHERE provider = @p AND message_id = @id AND parser_version = @v');
  const skip = db.prepare(`INSERT OR REPLACE INTO skipped_messages (provider, message_id, reason, subject, from_addr, received_at, parser_version)
                           VALUES (@p, @id, @reason, @subject, @from, @receivedAt, @v)`);
  const importedThisRun = new Set(); // once a store group imports an email, others leave it alone
  const foundIds = new Set();
  const counted = new Set(); // each email counts once in the summary, even if two store groups look at it
  const once = (id, key) => { if (counted.has(id)) return; counted.add(id); c[key]++; };
  const errors = [];

  try {
    const account = getAccount(db);
    // After the first sync, only look back a few days before the last one
    // (overlap is harmless: already-imported emails are skipped by ID).
    const since = account?.last_sync_at ? addDays(account.last_sync_at.slice(0, 10), -3) : null;

    for (const r of Object.values(retailers)) {
      if (!r.parse) continue;
      const opts = { amazonFromSite };
      const baseQuery = typeof r.gmailQuery === 'function' ? r.gmailQuery(opts) : r.gmailQuery;
      const q = `${baseQuery} ${since ? `after:${since.replace(/-/g, '/')}` : `newer_than:${firstSyncDays}d`}`;
      const ids = (await client.listMessageIds(q, r.maxMessages ?? maxMessages)).reverse(); // oldest first: orders before deliveries
      const skipKinds = r.skipKinds ? r.skipKinds(opts) : [];
      for (const id of ids) foundIds.add(id);
      c.found = foundIds.size;
      // The version includes the mode, so switching Amazon order details on/off re-checks skipped emails.
      const v = `${r.parserVersion ?? 1}${r.modeTag ? r.modeTag(opts) : ''}`;
      const p = `gmail:${r.id}`;
      for (const id of ids) {
        if (importedThisRun.has(id)) continue;
        if (imported.get({ id, prefix: `${id}#%` }) || skippedNow.get({ p, id, v })) { once(id, 'already_had'); continue; }
        try {
          // Cheap look first (sender, subject, preview) for the broad all-mail search.
          if (r.triage && client.getMessageMeta) {
            const meta = decodeMeta(await client.getMessageMeta(id));
            if (!r.triage(meta)) {
              skip.run({ p, id, reason: "doesn't look like a purchase (from its sender, subject and preview)", subject: meta.subject, from: meta.from, receivedAt: meta.receivedAt, v });
              once(id, 'ignored');
              continue;
            }
          }
          const msg = decodeMessage(await client.getMessage(id));
          const parsedAll = [].concat(r.parse(msg) ?? []);
          const results = parsedAll.filter((x) => !skipKinds.includes(x.kind));
          if (parsedAll.length && !results.length) {
            skip.run({ p, id, reason: 'Amazon purchases come from your Amazon order pages', subject: msg.subject, from: msg.from, receivedAt: msg.receivedAt, v });
            once(id, 'ignored');
            continue;
          }
          if (!results.length) {
            const reason = r.isFrom && !r.isFrom(msg.from) ? 'not from a verified retailer address' : 'not an order, shipping, return, or refund email';
            skip.run({ p, id, reason, subject: msg.subject, from: msg.from, receivedAt: msg.receivedAt, v });
            once(id, 'ignored');
            continue;
          }
          const ignoredStore = db.prepare('SELECT 1 FROM ignored_stores WHERE domain = ?').get(results[0].retailer);
          if (ignoredStore) {
            skip.run({ p, id, reason: 'you chose to stop tracking this store', subject: msg.subject, from: msg.from, receivedAt: msg.receivedAt, v });
            once(id, 'ignored');
            continue;
          }
          db.prepare("DELETE FROM skipped_messages WHERE provider LIKE 'gmail%' AND message_id = ?").run(id);
          importedThisRun.add(id);
          let anyNew = false;
          let anyReview = false;
          for (const parsed of results) {
            parsed.webLink = gmailWebLink(id, account?.email);
            const res = ingestParsedEmail(db, parsed);
            if (res.status === 'imported') anyNew = true;
            else if (res.status !== 'duplicate') { anyReview = true; if (res.itemIds.length) anyNew = true; }
          }
          counted.add(id);
          if (anyNew) c.imported++;
          if (anyReview) c.needs_review++;
          if (!anyNew && !anyReview) c.already_had++;
        } catch (e) {
          if (e.reconnect || e.status === 401) throw e; // stop the whole sync
          once(id, 'failed');
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
