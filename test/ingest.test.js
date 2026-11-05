// Tests for the email import pipeline and item/refund actions, using a
// throwaway in-memory database for each test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { ingestParsedEmail } from '../src/services/ingest.js';
import {
  applyPolicyResult, correctDeadlines, acceptSuggestion, confirmRefund, snoozeRefund, reportRefundProblem, resolveRefund,
  markDroppedOff, manualStage, getItem, getRefund,
} from '../src/services/items.js';
import { dashboard } from '../src/services/queries.js';

let n = 0;
const mail = (o) => ({ messageId: `m${++n}`, retailer: 'amazon', receivedAt: o.eventDate ?? o.orderDate, ...o });
const items = (db) => db.prepare('SELECT * FROM items ORDER BY id').all();
const policy = {
  policy: { eligible: true, windowDays: 30, startsFrom: 'delivery', dropoffDays: 14, confidence: 'confirmed',
    refundTiming: { minDays: 3, maxDays: 5, unit: 'business', startEvent: 'refund_issued' } },
  explanation: 'test', sourceUrl: 'https://example.com/policy', checkedAt: '2026-10-01',
};

function orderWith(db, lines, orderNumber = '111-1') {
  return ingestParsedEmail(db, mail({ kind: 'order_confirmation', orderNumber, orderDate: '2026-10-01', paymentMethod: 'Visa ••1234', items: lines }));
}

test('importing the same email twice is a no-op', () => {
  const db = openDb(':memory:');
  const e = mail({ kind: 'order_confirmation', orderNumber: '111-1', orderDate: '2026-10-01', items: [{ name: 'Lamp', unitPriceCents: 3000 }] });
  assert.equal(ingestParsedEmail(db, e).status, 'imported');
  assert.equal(ingestParsedEmail(db, e).status, 'duplicate');
  assert.equal(items(db).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM emails').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
});

test('a re-sent order confirmation (new message id) does not duplicate orders or items', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }, { name: 'Desk Mat', unitPriceCents: 1500 }]);
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }, { name: 'Desk Mat', unitPriceCents: 1500 }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  assert.equal(items(db).length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM emails').get().n, 2); // both emails kept as evidence
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE item_id = 1').get().n, 1); // timeline not doubled
});

test('multi-item order: delivery email without item list updates all purchased items and deadlines', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }, { name: 'Desk Mat', unitPriceCents: 1500 }]);
  for (const it of items(db)) applyPolicyResult(db, it.id, policy, 'ai');
  ingestParsedEmail(db, mail({ kind: 'delivered', orderNumber: '111-1', eventDate: '2026-10-04' }));
  for (const it of items(db)) {
    assert.equal(it.stage, 'delivered');
    assert.equal(it.delivered_date, '2026-10-04');
    assert.equal(it.return_deadline, '2026-11-03');
    assert.equal(it.return_deadline_status, 'confirmed');
  }
});

test('emails link to the specific item they mention', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }, { name: 'Desk Mat', unitPriceCents: 1500 }]);
  const r = ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10', items: [{ name: 'Desk Mat' }], qrUrl: 'https://x/qr' }));
  assert.deepEqual(r.itemIds, [2]);
  assert.equal(getItem(db, 2).stage, 'return_started');
  assert.equal(getItem(db, 2).qr_url, 'https://x/qr');
  assert.equal(getItem(db, 1).stage, 'purchased');
});

test('ambiguous or unmatched emails are flagged for review, not guessed', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp' }, { name: 'Desk Mat' }]);
  const r = ingestParsedEmail(db, mail({ kind: 'refund_issued', orderNumber: '111-1', eventDate: '2026-10-20', refundCents: 1000 }));
  assert.equal(r.status, 'needs_review');
  assert.equal(db.prepare('SELECT needs_review FROM emails WHERE id = ?').get(r.emailId).needs_review, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM refunds').get().n, 0);
  const noOrder = ingestParsedEmail(db, mail({ kind: 'delivered', eventDate: '2026-10-04' }));
  assert.equal(noOrder.status, 'needs_review');
});

test('refund email without item names goes to the single item in return', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }, { name: 'Desk Mat', unitPriceCents: 1500 }]);
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10', items: [{ name: 'Lamp' }] }));
  const r = ingestParsedEmail(db, mail({ kind: 'refund_issued', orderNumber: '111-1', eventDate: '2026-10-20', refundCents: 3000 }));
  assert.equal(r.status, 'imported');
  assert.deepEqual(r.itemIds, [1]);
  assert.equal(getRefund(db, 1).issued_cents, 3000);
});

test('partial return splits a multi-quantity line; later emails follow the returned units', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Phone Case', quantity: 3, unitPriceCents: 1500 }]);
  ingestParsedEmail(db, mail({ kind: 'delivered', orderNumber: '111-1', eventDate: '2026-10-04' }));
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10', items: [{ name: 'Phone Case', quantity: 1 }] }));
  let [kept, ret] = items(db);
  assert.equal(kept.quantity, 2);
  assert.equal(kept.stage, 'delivered');
  assert.equal(ret.quantity, 1);
  assert.equal(ret.stage, 'return_started');
  assert.equal(ret.split_from_item_id, kept.id);
  assert.equal(getRefund(db, ret.id).expected_cents, 1500);
  assert.equal(getRefund(db, kept.id), undefined);
  // history copied to the new line so its timeline is complete
  assert.ok(db.prepare("SELECT COUNT(*) n FROM events WHERE item_id = ? AND kind = 'email:order_confirmation'").get(ret.id).n === 1);

  // Drop-off and refund emails (no quantity) go to the returned row, not the kept one
  ingestParsedEmail(db, mail({ kind: 'dropped_off', orderNumber: '111-1', eventDate: '2026-10-11', items: [{ name: 'Phone Case' }] }));
  ingestParsedEmail(db, mail({ kind: 'refund_issued', orderNumber: '111-1', eventDate: '2026-10-15', items: [{ name: 'Phone Case', refundCents: 1500 }] }));
  [kept, ret] = items(db);
  assert.equal(kept.stage, 'delivered');
  assert.equal(ret.stage, 'refund_issued');
  assert.equal(getRefund(db, ret.id).issued_cents, 1500);

  // A second partial return of another unit creates a third line
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-20', items: [{ name: 'Phone Case', quantity: 1 }] }));
  const all = items(db);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((i) => i.quantity), [1, 1, 1]);
  assert.deepEqual(all.map((i) => i.stage), ['delivered', 'refund_issued', 'return_started']);
});

test('partial refunds accumulate; refund issued never reaches stage 9; only user confirmation closes', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Grinder', unitPriceCents: 8000 }]);
  applyPolicyResult(db, 1, policy, 'ai');
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10' }));
  ingestParsedEmail(db, mail({ kind: 'refund_issued', orderNumber: '111-1', eventDate: '2026-10-20', refundCents: 6000 }));
  let r = getRefund(db, 1);
  assert.equal(r.issued_cents, 6000);
  assert.equal(r.status, 'issued');
  assert.equal(r.window_kind, 'retailer');
  assert.equal(r.window_end, '2026-10-27'); // Tue Oct 20 + 5 business days
  assert.equal(getItem(db, 1).stage, 'refund_issued');

  // You confirm the $60 that arrived: still $20 outstanding, stays open
  r = confirmRefund(db, 1, {}, '2026-10-28');
  assert.equal(r.status, 'partial');
  assert.equal(r.confirmed_cents, 6000);
  assert.equal(getItem(db, 1).stage, 'refund_issued');
  assert.equal(dashboard(db, '2026-10-28').totalOutstandingCents, 2000);

  // Second refund email for the rest
  ingestParsedEmail(db, mail({ kind: 'refund_issued', orderNumber: '111-1', eventDate: '2026-10-30', refundCents: 2000 }));
  r = getRefund(db, 1);
  assert.equal(r.issued_cents, 8000);
  assert.equal(r.status, 'partial');
  assert.equal(getItem(db, 1).stage, 'refund_issued');

  r = confirmRefund(db, 1, { amountCents: 2000 }, '2026-11-04');
  assert.equal(r.status, 'confirmed');
  assert.equal(getItem(db, 1).stage, 'refund_confirmed');
  assert.equal(dashboard(db, '2026-11-04').totalOutstandingCents, 0);
});

test('not yet / problem / resolve flow', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Blender', unitPriceCents: 4500 }]);
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10' }));
  ingestParsedEmail(db, mail({ kind: 'refund_issued', orderNumber: '111-1', eventDate: '2026-10-20', refundCents: 4500 }));
  // No refund timing in policy -> default reminder interval (10 days) from refund issued
  assert.equal(getRefund(db, 1).window_kind, 'default_interval');
  assert.equal(getRefund(db, 1).next_check_at, '2026-10-30');
  assert.equal(dashboard(db, '2026-10-30').needsCheck.length, 1);

  assert.equal(snoozeRefund(db, 1, '2026-10-30').next_check_at, '2026-11-02');
  assert.equal(dashboard(db, '2026-10-31').needsCheck.length, 0);

  const p = reportRefundProblem(db, 1, { note: 'only $40', receivedCents: 4000 }, '2026-11-02');
  assert.equal(p.status, 'problem');
  assert.equal(dashboard(db, '2026-11-02').totalOutstandingCents, 500);
  assert.equal(getItem(db, 1).stage, 'refund_issued');

  resolveRefund(db, 1, { note: 'restocking fee' }, '2026-11-03');
  assert.equal(getRefund(db, 1).status, 'resolved');
  assert.equal(getItem(db, 1).stage, 'refund_confirmed');
});

test('stages only move forward on email evidence', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }]);
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10' }));
  ingestParsedEmail(db, mail({ kind: 'delivered', orderNumber: '111-1', eventDate: '2026-10-04', items: [{ name: 'Lamp' }] })); // arrives late
  assert.equal(getItem(db, 1).stage, 'return_started');
  assert.equal(getItem(db, 1).delivered_date, '2026-10-04'); // fact still recorded
});

test('a "keeping" item advances if a return email arrives (evidence wins)', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }]);
  manualStage(db, 1, 'keeping', null, '2026-10-05');
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10' }));
  assert.equal(getItem(db, 1).stage, 'return_started');
});

test('changing your mind back to keeping removes the empty refund', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }]);
  manualStage(db, 1, 'need_to_return', null, '2026-10-05');
  assert.equal(dashboard(db, '2026-10-05').totalOutstandingCents, 3000);
  manualStage(db, 1, 'keeping', null, '2026-10-06');
  assert.equal(dashboard(db, '2026-10-06').totalOutstandingCents, 0);
});

test('"I dropped it off" with an editable date, and the source is shown as manual', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }]);
  ingestParsedEmail(db, mail({ kind: 'return_started', orderNumber: '111-1', eventDate: '2026-10-10' }));
  markDroppedOff(db, 1, '2026-10-12', '2026-10-13');
  const it = getItem(db, 1);
  assert.equal(it.stage, 'dropped_off');
  assert.equal(it.dropped_off_at, '2026-10-12');
  assert.equal(it.dropoff_source, 'manual');
  const ev = db.prepare("SELECT source FROM events WHERE kind = 'stage:dropped_off'").get();
  assert.equal(ev.source, 'manual');
  // refund reminder counts from the drop-off date
  assert.equal(getRefund(db, 1).window_end, '2026-10-22');
  markDroppedOff(db, 1, '2026-10-11', '2026-10-13'); // edit the date
  assert.equal(getItem(db, 1).dropped_off_at, '2026-10-11');
  assert.equal(getRefund(db, 1).window_end, '2026-10-21');
});

test('your deadline corrections are kept; new AI results become suggestions until accepted', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Lamp', unitPriceCents: 3000 }]);
  ingestParsedEmail(db, mail({ kind: 'delivered', orderNumber: '111-1', eventDate: '2026-10-04' }));
  applyPolicyResult(db, 1, policy, 'ai');
  assert.equal(getItem(db, 1).return_deadline, '2026-11-03');

  correctDeadlines(db, 1, { returnDeadline: '2026-11-15', note: 'support agreed' }, '2026-10-05');
  const res = applyPolicyResult(db, 1, { ...policy, policy: { ...policy.policy, windowDays: 14 } }, 'ai');
  assert.equal(res.suggested, true);
  assert.equal(getItem(db, 1).return_deadline, '2026-11-15'); // still yours
  // New emails don't overwrite it either
  ingestParsedEmail(db, mail({ kind: 'delivered', orderNumber: '111-1', eventDate: '2026-10-06', items: [{ name: 'Lamp' }] }));
  assert.equal(getItem(db, 1).return_deadline, '2026-11-15');

  const s = db.prepare("SELECT id FROM policy_reviews WHERE status = 'suggested'").get();
  acceptSuggestion(db, s.id);
  assert.equal(getItem(db, 1).deadline_locked_by_user, 0);
  assert.equal(getItem(db, 1).return_deadline, '2026-10-20'); // 14 days from Oct 6 delivery
});

test('confirming with no known amount asks for one', () => {
  const db = openDb(':memory:');
  orderWith(db, [{ name: 'Mystery item' }]); // no price
  manualStage(db, 1, 'need_to_return', null, '2026-10-05');
  assert.throws(() => confirmRefund(db, 1, {}, '2026-10-06'), /Enter the amount/);
});
