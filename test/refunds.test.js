import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePostingWindow, applyIssued, applyConfirmation, applyProblem, applyResolve, outstandingCents, refundBucket,
} from '../src/lib/refunds.js';

const timing = { minDays: 3, maxDays: 5, unit: 'business', startEvent: 'refund_issued' };

test('business-day posting window starts from the actual issue date and skips holidays', () => {
  const w = computePostingWindow({ timing, events: { refund_issued: '2026-11-25' } });
  assert.equal(w.kind, 'retailer');
  assert.equal(w.start, '2026-12-01'); // Thanksgiving skipped
  assert.equal(w.end, '2026-12-03');
  assert.match(w.basis, /business days/);
  assert.match(w.assumption, /Federal Reserve/);
});

test('calendar-day window has no holiday assumption', () => {
  const w = computePostingWindow({ timing: { ...timing, unit: 'calendar', startEvent: 'return_received' }, events: { return_received: '2026-11-25' } });
  assert.equal(w.end, '2026-11-30');
  assert.equal(w.assumption, null);
});

test('falls back to labeled reminder interval when timing unknown or start event missing', () => {
  const unknown = computePostingWindow({ timing: null, events: { dropped_off: '2026-11-01', return_received: '2026-11-04' }, fallbackDays: 10 });
  assert.equal(unknown.kind, 'default_interval');
  assert.equal(unknown.end, '2026-11-14'); // from the latest event
  assert.match(unknown.assumption, /not a retailer promise/);
  const waiting = computePostingWindow({ timing, events: { dropped_off: '2026-11-01' }, fallbackDays: 7 });
  assert.equal(waiting.kind, 'default_interval');
  assert.match(waiting.basis, /hasn't happened yet/);
  assert.equal(computePostingWindow({ timing, events: {} }).kind, 'none');
});

test('refund issued never closes the refund', () => {
  const r = applyIssued({ expected_cents: 5000, issued_cents: 0, confirmed_cents: 0, status: 'pending' }, { amountCents: 5000, date: '2026-11-01' });
  assert.equal(r.status, 'issued');
  assert.equal(outstandingCents(r), 5000); // still owed until YOU confirm
});

test('partial refunds stay open until outstanding amount is resolved', () => {
  let r = { expected_cents: 8000, issued_cents: 0, confirmed_cents: 0, status: 'pending' };
  r = applyIssued(r, { amountCents: 6000, date: '2026-11-01' });
  r = applyConfirmation(r, { date: '2026-11-06', remindDays: 3 }); // defaults to issued-but-unconfirmed: $60
  assert.equal(r.confirmed_cents, 6000);
  assert.equal(r.status, 'partial');
  assert.equal(outstandingCents(r), 2000);
  assert.equal(r.next_check_at, '2026-11-09');
  r = applyIssued(r, { amountCents: 2000, date: '2026-11-08' });
  assert.equal(r.issued_cents, 8000);
  assert.equal(r.status, 'partial');
  r = applyConfirmation(r, { date: '2026-11-12', remindDays: 3 });
  assert.equal(r.status, 'confirmed');
  assert.equal(outstandingCents(r), 0);
});

test('problem keeps refund open; resolve closes with shortfall', () => {
  let r = { expected_cents: 8000, issued_cents: 6000, confirmed_cents: 0, status: 'issued' };
  r = applyProblem(r, { note: 'only $50 posted', receivedCents: 5000, today: '2026-11-05', remindDays: 3 });
  assert.equal(r.status, 'problem');
  assert.equal(outstandingCents(r), 3000);
  r = applyResolve(r, { note: 'restocking fee', date: '2026-11-07' });
  assert.equal(r.status, 'resolved');
  assert.equal(outstandingCents(r), 0);
});

test('dashboard buckets', () => {
  const base = { status: 'issued', window_end: '2026-11-10', next_check_at: '2026-11-10' };
  assert.equal(refundBucket(base, { today: '2026-11-05' }), 'awaiting_posting');
  assert.equal(refundBucket(base, { today: '2026-11-10' }), 'check');
  assert.equal(refundBucket(base, { today: '2026-11-18', overdueGraceDays: 7 }), 'overdue');
  assert.equal(refundBucket({ ...base, status: 'pending' }, { today: '2026-11-05' }), 'not_issued');
  assert.equal(refundBucket({ ...base, status: 'confirmed' }, { today: '2026-11-30' }), 'closed');
});
