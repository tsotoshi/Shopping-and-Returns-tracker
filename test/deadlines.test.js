import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturnDeadline, computeDropoffDeadline } from '../src/lib/deadlines.js';

const policy = { eligible: true, windowDays: 30, startsFrom: 'delivery', dropoffDays: 14, confidence: 'confirmed' };

test('delivery-based window with known delivery date is confirmed', () => {
  const r = computeReturnDeadline({ policy, orderDate: '2026-10-01', deliveredDate: '2026-10-04' });
  assert.equal(r.date, '2026-11-03');
  assert.equal(r.status, 'confirmed');
  assert.equal(r.eligibility, 'eligible');
});

test('unknown delivery date falls back to estimate, then order date (earliest)', () => {
  const est = computeReturnDeadline({ policy, orderDate: '2026-10-01', estimatedDeliveryDate: '2026-10-05' });
  assert.equal(est.date, '2026-11-04');
  assert.equal(est.status, 'estimated');
  const fromOrder = computeReturnDeadline({ policy, orderDate: '2026-10-01' });
  assert.equal(fromOrder.date, '2026-10-31');
  assert.equal(fromOrder.status, 'estimated');
  assert.match(fromOrder.basis, /probably later/);
});

test('purchase-based window', () => {
  const r = computeReturnDeadline({ policy: { ...policy, startsFrom: 'purchase' }, orderDate: '2026-10-01', deliveredDate: '2026-10-09' });
  assert.equal(r.date, '2026-10-31');
});

test('holiday extension applies only within its purchase range and only if later', () => {
  const holiday = { ...policy, holidayExtension: { purchasedFrom: '2026-11-01', purchasedTo: '2026-12-31', returnBy: '2027-01-31' } };
  const inRange = computeReturnDeadline({ policy: holiday, orderDate: '2026-11-10', deliveredDate: '2026-11-12' });
  assert.equal(inRange.date, '2027-01-31');
  assert.match(inRange.basis, /Holiday extension/);
  const outOfRange = computeReturnDeadline({ policy: holiday, orderDate: '2026-10-20', deliveredDate: '2026-10-22' });
  assert.equal(outOfRange.date, '2026-11-21');
  // Bought Dec 31 and delivered Jan 5: normal 30 days (Feb 4) is later than the extension
  const late = computeReturnDeadline({ policy: holiday, orderDate: '2026-12-31', deliveredDate: '2027-01-05' });
  assert.equal(late.date, '2027-02-04');
});

test('never invents a deadline', () => {
  assert.equal(computeReturnDeadline({ policy: null, orderDate: '2026-10-01' }).status, 'needs_review');
  const unknownWindow = computeReturnDeadline({ policy: { eligible: true, windowDays: null, confidence: 'estimated' }, orderDate: '2026-10-01' });
  assert.equal(unknownWindow.date, null);
  assert.equal(unknownWindow.status, 'needs_review');
  const notEligible = computeReturnDeadline({ policy: { eligible: false, confidence: 'confirmed' }, orderDate: '2026-10-01' });
  assert.equal(notEligible.date, null);
  assert.equal(notEligible.eligibility, 'not_eligible');
});

test('estimated policy confidence carries through', () => {
  const r = computeReturnDeadline({ policy: { ...policy, confidence: 'estimated' }, orderDate: '2026-10-01', deliveredDate: '2026-10-04' });
  assert.equal(r.status, 'estimated');
});

test('drop-off deadline: email date beats policy calculation', () => {
  assert.deepEqual(
    computeDropoffDeadline({ policy, returnStartedAt: '2026-11-01', emailDropoffBy: '2026-11-20' }).date, '2026-11-20');
  const calc = computeDropoffDeadline({ policy, returnStartedAt: '2026-11-01' });
  assert.equal(calc.date, '2026-11-15');
  assert.equal(calc.status, 'estimated');
  assert.equal(computeDropoffDeadline({ policy: { ...policy, dropoffDays: null }, returnStartedAt: '2026-11-01' }).status, 'needs_review');
});
