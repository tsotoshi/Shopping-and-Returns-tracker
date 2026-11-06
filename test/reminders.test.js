import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { ingestParsedEmail } from '../src/services/ingest.js';
import { applyPolicyResult, manualStage, snoozeRefund } from '../src/services/items.js';
import { computeReminders, recordReminders, unreadCount, markRead } from '../src/services/reminders.js';
import { deliverPending, isQuietHour, makeChannels, sendTest } from '../src/notify/channels.js';
import { createScheduler } from '../src/services/scheduler.js';
import { saveAccount } from '../src/gmail/account.js';
import { updateSettings, getSettings, SettingsError } from '../src/settings.js';
import { loadSampleData } from '../src/sample/sampleData.js';

const policy = { policy: { eligible: true, windowDays: 30, startsFrom: 'delivery', dropoffDays: 14, confidence: 'confirmed' }, explanation: 't', sourceUrl: null, checkedAt: '2026-10-01' };
let n = 0;
const mail = (o) => ({ messageId: `m${++n}`, retailer: 'amazon', receivedAt: o.eventDate ?? o.orderDate, ...o });

/** One real item delivered Oct 4 -> return deadline Nov 3. */
function setup() {
  const db = openDb(':memory:');
  ingestParsedEmail(db, mail({ kind: 'order_confirmation', orderNumber: '111-1', orderDate: '2026-10-01', items: [{ name: 'Desk Lamp', unitPriceCents: 3000 }] }));
  applyPolicyResult(db, 1, policy, 'ai');
  ingestParsedEmail(db, mail({ kind: 'delivered', orderNumber: '111-1', eventDate: '2026-10-04' }));
  return db;
}

const fakeChannel = (name = 'push', { fail = false } = {}) => {
  const sent = [];
  return { name, sent, async send(m) { if (fail) throw new Error('offline'); sent.push(m); } };
};
const at = (iso) => new Date(iso); // local time

test('return deadline reminder appears in the window, once per deadline, with a separate last-day reminder', () => {
  const db = setup();
  assert.equal(computeReminders(db, '2026-10-30').length, 0); // 4 days out, default heads-up is 3
  const soon = computeReminders(db, '2026-10-31');
  assert.equal(soon.length, 1);
  assert.equal(soon[0].kind, 'return_deadline');
  assert.match(soon[0].body, /Desk Lamp: the return deadline is in 3 days/);
  assert.ok(!soon[0].privateBody.includes('Desk Lamp'));

  assert.equal(recordReminders(db, '2026-10-31').length, 1);
  assert.equal(recordReminders(db, '2026-11-01').length, 0, 'same deadline, not repeated');
  const lastDay = recordReminders(db, '2026-11-03');
  assert.equal(lastDay.length, 1);
  assert.equal(lastDay[0].title, 'Last day to return');
  assert.equal(computeReminders(db, '2026-11-04').length, 0, 'nothing after the deadline passes');
});

test('no deadline reminders for items you keep or that are not returnable', () => {
  const db = setup();
  manualStage(db, 1, 'keeping', null, '2026-10-05');
  assert.equal(computeReminders(db, '2026-11-01').length, 0);
});

test('drop-off and refund reminders; snoozing allows a new reminder later', () => {
  const db = setup();
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-20', dropoffBy: '2026-10-25' }));
  assert.equal(computeReminders(db, '2026-10-22').length, 0);
  assert.equal(computeReminders(db, '2026-10-23')[0].kind, 'dropoff');

  ingestParsedEmail(db, mail({ kind: 'refund_issued', orderNumber: '111-1', eventDate: '2026-10-28', refundCents: 3000 }));
  // no refund timing -> default 10-day reminder -> Nov 7
  assert.equal(computeReminders(db, '2026-11-06').filter((r) => r.kind === 'refund_check').length, 0);
  const first = recordReminders(db, '2026-11-07');
  assert.equal(first[0].kind, 'refund_check');
  assert.match(first[0].body, /\$30\.00/);
  snoozeRefund(db, 1, '2026-11-07'); // remind again in 3 days
  assert.equal(recordReminders(db, '2026-11-08').length, 0);
  assert.equal(recordReminders(db, '2026-11-10')[0].kind, 'refund_check');
  // a week past the expected window -> overdue
  assert.equal(computeReminders(db, '2026-11-15').find((r) => r.kind === 'refund_overdue')?.title, 'Refund overdue');
});

test('Gmail reconnect reminder', () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  assert.equal(computeReminders(db, '2026-11-05').length, 0);
  db.prepare('UPDATE gmail_account SET needs_reconnect = 1').run();
  assert.equal(computeReminders(db, '2026-11-05')[0].kind, 'gmail_reconnect');
});

test('quiet hours', () => {
  assert.ok(isQuietHour(22, 21, 8));
  assert.ok(isQuietHour(3, 21, 8));
  assert.ok(!isQuietHour(8, 21, 8));
  assert.ok(!isQuietHour(12, 21, 8));
  assert.ok(isQuietHour(13, 12, 14));
  assert.ok(!isQuietHour(3, 9, 9), 'same start and end = off');
});

test('delivery: once only, waits for quiet hours, hides item names by default', async () => {
  const db = setup();
  recordReminders(db, '2026-10-31');
  const ch = fakeChannel();

  const night = await deliverPending(db, { now: at('2026-10-31T23:00:00'), channels: [ch] });
  assert.equal(night.waiting, 1);
  assert.equal(ch.sent.length, 0);

  const morning = await deliverPending(db, { now: at('2026-11-01T09:00:00'), channels: [ch] });
  assert.equal(morning.sent, 1);
  assert.ok(!ch.sent[0].body.includes('Desk Lamp'), 'private by default');
  assert.ok(ch.sent[0].fullBody.includes('Desk Lamp'), 'email version keeps names');

  await deliverPending(db, { now: at('2026-11-01T10:00:00'), channels: [ch] });
  assert.equal(ch.sent.length, 1, 'not sent twice');
});

test('delivery: names when you opt in; failures retry; no channels = in-app only', async () => {
  const db = setup();
  updateSettings(db, { pushIncludeNames: true });
  recordReminders(db, '2026-10-31');
  const broken = fakeChannel('push', { fail: true });
  const r1 = await deliverPending(db, { now: at('2026-11-01T09:00:00'), channels: [broken] });
  assert.equal(r1.sent, 0);
  assert.match(r1.errors[0], /offline/);
  const ok = fakeChannel();
  await deliverPending(db, { now: at('2026-11-01T10:00:00'), channels: [ok] });
  assert.match(ok.sent[0].body, /Desk Lamp/);

  const db2 = setup();
  recordReminders(db2, '2026-10-31');
  const r2 = await deliverPending(db2, { now: at('2026-11-01T09:00:00'), channels: [] });
  assert.equal(r2.skipped, 1);
  assert.match(db2.prepare('SELECT delivery_note FROM notifications').get().delivery_note, /in-app only/);
});

test('sample reminders stay in the app; many at once become one summary', async () => {
  const db = openDb(':memory:');
  loadSampleData(db, '2026-11-05');
  const created = recordReminders(db, '2026-11-05');
  assert.ok(created.length >= 2);
  const ch = fakeChannel();
  await deliverPending(db, { now: at('2026-11-05T12:00:00'), channels: [ch] });
  assert.equal(ch.sent.length, 0, 'sample data never pushed');

  const real = setup();
  for (let i = 2; i <= 6; i++) {
    ingestParsedEmail(real, mail({ kind: 'order_confirmation', orderNumber: `111-${i}`, orderDate: '2026-10-01', items: [{ name: `Thing ${i}`, unitPriceCents: 1000 }] }));
    applyPolicyResult(real, i, policy, 'ai');
    ingestParsedEmail(real, mail({ kind: 'delivered', orderNumber: `111-${i}`, eventDate: '2026-10-04' }));
  }
  recordReminders(real, '2026-10-31');
  const ch2 = fakeChannel();
  const r = await deliverPending(real, { now: at('2026-11-01T09:00:00'), channels: [ch2] });
  assert.equal(r.sent, 6);
  assert.equal(ch2.sent.length, 1);
  assert.equal(ch2.sent[0].title, '6 reminders');
});

test('ntfy channel posts JSON to your topic with a link back; email uses SMTP transport', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  const mails = [];
  const settings = { ntfyTopic: 'returns-abc123', ntfyServer: 'https://ntfy.sh', emailEnabled: true };
  const email = { configured: true, host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', to: 'me@example.com', from: 'u' };
  const chans = makeChannels({ settings, fetchImpl, email, makeTransport: () => ({ sendMail: async (m) => mails.push(m) }), appUrl: 'http://192.168.1.5:3000' });
  assert.deepEqual(chans.map((c) => c.name), ['push', 'email']);
  await Promise.all(chans.map((c) => c.send({ title: 'T', body: 'short', fullBody: 'long version', notification: { item_id: 4 } })));
  assert.equal(calls[0].url, 'https://ntfy.sh/');
  assert.equal(calls[0].body.topic, 'returns-abc123');
  assert.equal(calls[0].body.click, 'http://192.168.1.5:3000/#/item/4');
  assert.equal(mails[0].to, 'me@example.com');
  assert.match(mails[0].text, /long version/);
  assert.deepEqual(makeChannels({ settings: { ntfyTopic: '', emailEnabled: true }, email: { configured: false } }), []);
});

test('test notification reports per-channel results', async () => {
  const db = openDb(':memory:');
  await assert.rejects(sendTest(db, { channels: [] }), /No push or email/);
  const r = await sendTest(db, { channels: [fakeChannel('push'), fakeChannel('email', { fail: true })] });
  assert.deepEqual(r.map((x) => [x.channel, x.ok]), [['push', true], ['email', false]]);
});

test('scheduler: syncs only when due, never auto-reviews unless you turn it on, then reminds', async () => {
  const db = setup();
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  let listed = 0;
  // Count syncs by the Amazon search (each sync also searches "other stores").
  const gmail = { listMessageIds: async (q) => { if (q.startsWith('from:amazon.com')) listed++; return []; }, getMessage: async () => null };
  let aiCalls = 0;
  const ai = { beta: { messages: { create: async () => { aiCalls++; return { stop_reason: 'end_turn', content: [] }; } } } };
  let clock = new Date('2026-10-31T12:00:00Z');
  const sched = createScheduler(db, {
    gmailReady: () => true, makeGmailClient: () => gmail, aiReady: () => true, makeAiClient: () => ai,
    today: () => '2026-10-31', now: () => clock, deliver: async () => ({ sent: 0, errors: [] }),
  });
  ingestParsedEmail(db, mail({ kind: 'order_confirmation', orderNumber: '111-9', orderDate: '2026-10-30', items: [{ name: 'Unreviewed', unitPriceCents: 500 }] }));

  const t1 = await sched.tick();
  assert.equal(listed, 1, 'first sync runs');
  assert.equal(aiCalls, 0, 'auto review is off by default');
  assert.equal(t1.remindersCreated, 1);

  db.prepare("UPDATE gmail_account SET last_sync_at = '2026-10-31 11:00:00'").run();
  await sched.tick();
  assert.equal(listed, 1, 'not due yet (every 6 hours)');
  clock = new Date('2026-10-31T18:00:00Z');
  await sched.tick();
  assert.equal(listed, 2, 'due again after 6 hours');

  updateSettings(db, { autoReview: true });
  await sched.tick();
  assert.equal(aiCalls, 1, 'auto review when you turn it on');

  updateSettings(db, { autoSyncHours: 0 });
  clock = new Date('2026-11-02T18:00:00Z');
  await sched.tick();
  assert.equal(listed, 2, 'background sync off');
});

test('scheduler: expired Gmail access is flagged and turns into a reminder', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const gmail = { listMessageIds: async () => { const e = new Error('expired'); e.reconnect = true; throw e; } };
  const sched = createScheduler(db, { gmailReady: () => true, makeGmailClient: () => gmail, today: () => '2026-11-05', deliver: async () => ({ errors: [] }) });
  const r = await sched.tick();
  assert.match(r.errors[0], /expired/);
  assert.equal(db.prepare('SELECT needs_reconnect FROM gmail_account').get().needs_reconnect, 1);
  assert.equal(unreadCount(db), 1);
  markRead(db, 'all');
  assert.equal(unreadCount(db), 0);
});

test('settings validation', () => {
  const db = openDb(':memory:');
  assert.equal(getSettings(db).autoSyncHours, 6);
  assert.equal(getSettings(db).autoReview, false);
  assert.equal(getSettings(db).pushIncludeNames, false);
  updateSettings(db, { ntfyTopic: 'returns-0a1b', autoReview: 'on', quietStart: '22' });
  assert.equal(getSettings(db).ntfyTopic, 'returns-0a1b');
  assert.equal(getSettings(db).autoReview, true);
  assert.equal(getSettings(db).quietStart, 22);
  assert.throws(() => updateSettings(db, { ntfyTopic: 'has spaces/and slashes' }), SettingsError);
  assert.throws(() => updateSettings(db, { ntfyServer: 'http://insecure.example' }), /https/);
  assert.throws(() => updateSettings(db, { quietEnd: 24 }), /0 to 23/);
  assert.throws(() => updateSettings(db, { snoozeDays: 0 }), /1 to 365/);
});
