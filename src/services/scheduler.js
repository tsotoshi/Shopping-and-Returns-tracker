// Background work, run on a timer while the app is running:
//   1. Sync Gmail every N hours (Settings → Background sync; 0 = off)
//   2. Optionally run AI policy reviews for new items (off by default: costs money)
//   3. Create reminders that are due
//   4. Send them by push/email (respecting quiet hours)
//
// It only runs while the server is running — on a computer that's asleep,
// nothing happens until it wakes up, then it catches up.

import { getSettings } from '../db.js';
import { todayISO } from '../lib/dates.js';
import { getAccount } from '../gmail/account.js';
import { syncGmail, isSyncing } from './sync.js';
import { reviewPolicies, itemsNeedingReview, isReviewing } from './policyReviews.js';
import { recordReminders } from './reminders.js';
import { deliverPending } from '../notify/channels.js';
import { lastAmazonSiteRun } from '../integrations/amazonSite.js';

const sqliteUtc = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));

export function createScheduler(db, {
  gmailReady = () => false, // Gmail credentials configured?
  amazonSite = () => null, // returns a function that runs the Amazon order-page check, or null if off
  amazonFromSite = () => false, // Amazon purchases come from order pages (emails only for returns/refunds)
  makeGmailClient,
  aiReady = () => false,
  makeAiClient,
  today = () => todayISO(),
  now = () => new Date(),
  deliver = (opts) => deliverPending(db, opts),
} = {}) {
  let timer = null;
  let running = false;
  const state = { lastRunAt: null, last: null, nextRunAt: null };

  async function tick() {
    if (running) return { skipped: 'already running' };
    running = true;
    const out = { sync: null, review: null, remindersCreated: 0, delivery: null, errors: [] };
    try {
      const s = getSettings(db);
      const acct = getAccount(db);

      // 1. Background Gmail sync
      if (s.autoSyncHours > 0 && gmailReady() && acct && !acct.needs_reconnect && !isSyncing()) {
        const due = !acct.last_sync_at || now() - sqliteUtc(acct.last_sync_at) >= s.autoSyncHours * 3600_000;
        if (due) {
          try {
            out.sync = await syncGmail(db, { client: makeGmailClient(), amazonFromSite: amazonFromSite() });
          } catch (e) {
            if (e.reconnect || e.status === 401) db.prepare('UPDATE gmail_account SET needs_reconnect = 1 WHERE id = 1').run();
            out.errors.push(`Sync: ${e.message}`);
          }
        }
      }

      // 1b. Optional Amazon order-page check, on the same schedule as Gmail
      const runAmazon = amazonSite();
      if (runAmazon && s.autoSyncHours > 0) {
        const last = lastAmazonSiteRun(db);
        const due = !last?.at || now() - new Date(last.at) >= s.autoSyncHours * 3600_000;
        if (due) {
          out.amazonSite = await runAmazon();
          if (!out.amazonSite.ok) out.errors.push(`Amazon order pages: ${out.amazonSite.error}`);
        }
      }

      // 2. Optional automatic AI policy review of new items
      if (s.autoReview && aiReady() && !isReviewing() && itemsNeedingReview(db).length) {
        try {
          out.review = await reviewPolicies(db, { client: makeAiClient(), today: today() });
        } catch (e) {
          out.errors.push(`Policy review: ${e.message}`);
        }
      }

      // 3 + 4. Reminders and delivery
      out.remindersCreated = recordReminders(db, today()).length;
      out.delivery = await deliver({ now: now() });
      out.errors.push(...(out.delivery?.errors ?? []));
    } catch (e) {
      out.errors.push(e.message);
    } finally {
      running = false;
      state.lastRunAt = now().toISOString();
      state.last = out;
    }
    return out;
  }

  return {
    tick,
    status: () => ({ ...state, running }),
    start(intervalMs = 15 * 60_000) {
      if (timer) return;
      const run = () => tick().catch((e) => console.error('Background check failed:', e));
      setTimeout(run, 10_000).unref(); // shortly after start-up
      timer = setInterval(() => { state.nextRunAt = new Date(Date.now() + intervalMs).toISOString(); run(); }, intervalMs);
      timer.unref(); // don't keep the process alive just for this
      state.nextRunAt = new Date(Date.now() + 10_000).toISOString();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
