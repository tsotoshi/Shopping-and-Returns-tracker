// Decides what deserves a reminder right now. Each reminder has a stable
// "key", so it's created once — e.g. one heads-up per item per deadline,
// one "check your account" per reminder date (snoozing sets a new date,
// which allows a new reminder).

import { getSettings } from '../db.js';
import { addDays, daysBetween, todayISO } from '../lib/dates.js';
import { refundBucket, outstandingCents } from '../lib/refunds.js';
import { getAccount } from '../gmail/account.js';
import { lastAmazonSiteRun } from '../integrations/amazonSite.js';

const money = (c) => `$${((c ?? 0) / 100).toFixed(2)}`;
const when = (date, today) => {
  const n = daysBetween(today, date);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
};

/** Reads the database and returns reminder candidates. Doesn't write. */
export function computeReminders(db, today = todayISO()) {
  const s = getSettings(db);
  const out = [];
  const rows = db.prepare(`SELECT i.*, o.retailer, r.id AS refund_id, r.status AS refund_status, r.expected_cents, r.issued_cents,
                                  r.confirmed_cents, r.window_end, r.next_check_at
                           FROM items i JOIN orders o ON o.id = i.order_id LEFT JOIN refunds r ON r.item_id = i.id`).all();

  for (const i of rows) {
    const base = { itemId: i.id, isSample: !!i.is_sample };

    // Return deadline coming up (while you're deciding or haven't started the return)
    if (['purchased', 'delivered', 'need_to_return'].includes(i.stage) && i.return_deadline && i.eligibility !== 'not_eligible') {
      const d = i.return_deadline;
      const est = i.return_deadline_status !== 'confirmed' ? ' (estimated)' : '';
      if (d >= today && d <= addDays(today, s.remindBeforeDays)) {
        const lastDay = d === today;
        out.push({
          ...base, kind: 'return_deadline', key: `return:${i.id}:${d}:${lastDay ? 'today' : 'soon'}`,
          title: lastDay ? 'Last day to return' : 'Return deadline coming up',
          body: `${i.name}: the return deadline is ${when(d, today)}${est}.${i.stage === 'need_to_return' ? ' Start the return soon.' : ' Keep it or return it?'}`,
          privateBody: `An item's return deadline is ${when(d, today)}${est}.`,
        });
      }
    }

    // Drop-off deadline for a started return
    if (i.stage === 'return_started' && i.dropoff_deadline && i.dropoff_deadline >= today && i.dropoff_deadline <= addDays(today, 2)) {
      out.push({
        ...base, kind: 'dropoff', key: `dropoff:${i.id}:${i.dropoff_deadline}`,
        title: 'Drop off your return',
        body: `${i.name}: drop it off ${when(i.dropoff_deadline, today)}. Tap "I dropped it off" afterwards.`,
        privateBody: `A return needs to be dropped off ${when(i.dropoff_deadline, today)}.`,
      });
    }

    // Refunds: time to check your account, or overdue
    if (i.refund_id) {
      const bucket = refundBucket(
        { status: i.refund_status, window_end: i.window_end, next_check_at: i.next_check_at },
        { today, overdueGraceDays: s.overdueGraceDays },
      );
      const owed = outstandingCents({ status: i.refund_status, expected_cents: i.expected_cents, issued_cents: i.issued_cents, confirmed_cents: i.confirmed_cents });
      if (bucket === 'check') {
        out.push({
          ...base, kind: 'refund_check', key: `refund-check:${i.id}:${i.next_check_at}`,
          title: 'Check your account for a refund',
          body: `${i.name}: ${money(owed)} should have reached your account by now. Did it arrive?`,
          privateBody: `A refund of ${money(owed)} should have arrived. Please check your account.`,
        });
      } else if (bucket === 'overdue') {
        out.push({
          ...base, kind: 'refund_overdue', key: `refund-overdue:${i.id}:${i.window_end}`,
          title: 'Refund overdue',
          body: `${i.name}: ${money(owed)} is more than ${s.overdueGraceDays} days past when it was expected. Consider contacting the retailer.`,
          privateBody: `A ${money(owed)} refund is overdue.`,
        });
      }
    }
  }

  // Gmail access expired (Google's weekly limit in Testing mode)
  const acct = getAccount(db);
  if (acct?.needs_reconnect) {
    out.push({
      itemId: null, isSample: false, kind: 'gmail_reconnect', key: `gmail-reconnect:${acct.connected_at}`,
      title: 'Reconnect Gmail',
      body: "Gmail access expired, so new emails aren't being imported. Open Settings and tap Reconnect.",
      privateBody: 'Gmail access expired. Open the app and reconnect.',
    });
  }
  // Amazon order pages need you to sign in again
  const amazon = lastAmazonSiteRun(db);
  if (s.amazonSiteEnabled && amazon && !amazon.ok && amazon.error === 'signin_required') {
    out.push({
      itemId: null, isSample: false, kind: 'amazon_signin', key: `amazon-signin:${String(amazon.at).slice(0, 10)}`,
      title: 'Sign in to Amazon again',
      body: 'Amazon order details (product names and return dates) are paused until you sign in again. See Settings for the one command to run.',
      privateBody: 'Amazon sign-in expired. Open the app for the fix.',
    });
  }
  return out;
}

/** Save new reminders (ones already created are ignored). Returns the newly created rows. */
export function recordReminders(db, today = todayISO()) {
  const ins = db.prepare(`INSERT OR IGNORE INTO notifications (key, kind, item_id, title, body, private_body, is_sample)
                          VALUES (@key, @kind, @itemId, @title, @body, @privateBody, @isSample)`);
  const created = [];
  for (const r of computeReminders(db, today)) {
    const info = ins.run({ ...r, isSample: r.isSample ? 1 : 0 });
    if (info.changes) created.push(db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid));
  }
  return created;
}

export function listNotifications(db, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit);
}

export const unreadCount = (db) => db.prepare('SELECT COUNT(*) n FROM notifications WHERE read_at IS NULL').get().n;

export function markRead(db, id) {
  if (id === 'all') db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL").run();
  else db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL").run(id);
}
