// Database operations on items, refunds, and policy results.
// Every user action and every email effect goes through these functions,
// so the rules live in one place.

import { getSettings } from '../db.js';
import { addDays, todayISO } from '../lib/dates.js';
import { computeReturnDeadline, computeDropoffDeadline } from '../lib/deadlines.js';
import {
  computePostingWindow, applyConfirmation, applySnooze, applyProblem, applyResolve, applyIssued, isOpen,
} from '../lib/refunds.js';
import { isStage, stageRank, stageLabel } from '../lib/stages.js';

export class UserError extends Error {}

export const getItem = (db, id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id);
export const getRefund = (db, itemId) => db.prepare('SELECT * FROM refunds WHERE item_id = ?').get(itemId);

function mustItem(db, id) {
  const item = getItem(db, id);
  if (!item) throw new UserError(`Item ${id} not found`);
  return item;
}

function update(db, table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
}

export function addEvent(db, itemId, { kind, occurredAt, source, emailId = null, detail = null }) {
  // Skip exact repeats (e.g. the same email content arriving twice under
  // different message IDs) so the timeline stays clean.
  const dup = db
    .prepare("SELECT id FROM events WHERE item_id = ? AND kind = ? AND source = ? AND IFNULL(occurred_at, '') = IFNULL(?, '') AND IFNULL(detail, '') = IFNULL(?, '')")
    .get(itemId, kind, source, occurredAt, detail);
  if (dup) return dup.id;
  return db
    .prepare('INSERT INTO events (item_id, kind, occurred_at, source, email_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(itemId, kind, occurredAt, source, emailId, detail).lastInsertRowid;
}

// --- Deadlines & policy --------------------------------------------------

export function recomputeDeadlines(db, itemId) {
  const item = mustItem(db, itemId);
  if (item.deadline_locked_by_user) return; // your corrections win
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id);
  const policy = item.policy_json ? JSON.parse(item.policy_json) : null;
  const rd = computeReturnDeadline({
    policy, orderDate: order.order_date, deliveredDate: item.delivered_date, estimatedDeliveryDate: item.estimated_delivery_date,
  });
  const dd = computeDropoffDeadline({ policy, returnStartedAt: item.return_started_at, emailDropoffBy: item.email_dropoff_by });
  update(db, 'items', itemId, {
    eligibility: rd.eligibility,
    return_deadline: rd.date, return_deadline_status: rd.status, return_deadline_basis: rd.basis,
    dropoff_deadline: dd.date, dropoff_deadline_status: item.return_started_at ? dd.status : null, dropoff_deadline_basis: item.return_started_at ? dd.basis : null,
  });
}

/**
 * Apply a policy review result: { policy, explanation, sourceUrl, checkedAt }.
 * If you've corrected this item's deadlines, a non-user result is saved as a
 * *suggestion* instead of overwriting your correction.
 */
export function applyPolicyResult(db, itemId, result, origin) {
  const item = mustItem(db, itemId);
  if (item.deadline_locked_by_user && origin !== 'user') {
    db.prepare('INSERT INTO policy_reviews (item_id, origin, status, result_json) VALUES (?, ?, ?, ?)')
      .run(itemId, origin, 'suggested', JSON.stringify(result));
    return { applied: false, suggested: true };
  }
  db.prepare('INSERT INTO policy_reviews (item_id, origin, status, result_json) VALUES (?, ?, ?, ?)')
    .run(itemId, origin, 'applied', JSON.stringify(result));
  update(db, 'items', itemId, {
    policy_json: JSON.stringify(result.policy ?? null),
    policy_origin: origin,
    policy_explanation: result.explanation ?? null,
    policy_url: result.sourceUrl ?? null,
    policy_checked_at: result.checkedAt ?? null,
  });
  recomputeDeadlines(db, itemId);
  recomputeRefundWindow(db, itemId);
  return { applied: true };
}

/** You correct a deadline by hand. Locks it against automatic changes. */
export function correctDeadlines(db, itemId, { returnDeadline, dropoffDeadline, note }, today = todayISO()) {
  const item = mustItem(db, itemId);
  const basis = `Set by you on ${today}${note ? `: ${note}` : ''}.`;
  const fields = { deadline_locked_by_user: 1 };
  if (returnDeadline !== undefined) Object.assign(fields, { return_deadline: returnDeadline || null, return_deadline_status: 'confirmed', return_deadline_basis: basis });
  if (dropoffDeadline !== undefined) Object.assign(fields, { dropoff_deadline: dropoffDeadline || null, dropoff_deadline_status: 'confirmed', dropoff_deadline_basis: basis });
  update(db, 'items', itemId, fields);
  addEvent(db, itemId, {
    kind: 'deadline_corrected', occurredAt: today, source: 'manual',
    detail: [returnDeadline !== undefined && `Return by ${returnDeadline || '—'}`, dropoffDeadline !== undefined && `Drop off by ${dropoffDeadline || '—'}`, note].filter(Boolean).join(' · '),
  });
  return getItem(db, item.id);
}

export function acceptSuggestion(db, reviewId) {
  const r = db.prepare('SELECT * FROM policy_reviews WHERE id = ? AND status = ?').get(reviewId, 'suggested');
  if (!r) throw new UserError('Suggestion not found');
  db.prepare('UPDATE policy_reviews SET status = ? WHERE id = ?').run('rejected', reviewId); // replaced by the applied copy below
  update(db, 'items', r.item_id, { deadline_locked_by_user: 0 });
  applyPolicyResult(db, r.item_id, JSON.parse(r.result_json), r.origin);
  addEvent(db, r.item_id, { kind: 'suggestion_accepted', occurredAt: todayISO(), source: 'manual', detail: 'Accepted suggested policy result' });
}

export function rejectSuggestion(db, reviewId) {
  db.prepare("UPDATE policy_reviews SET status = 'rejected' WHERE id = ? AND status = 'suggested'").run(reviewId);
}

// --- Stages --------------------------------------------------------------

export function setStage(db, itemId, stage, { source, occurredAt, emailId = null, detail = null }) {
  if (!isStage(stage)) throw new UserError(`Unknown stage ${stage}`);
  if (stage === 'refund_confirmed' && source !== 'manual') throw new Error('Only you can confirm a refund');
  update(db, 'items', itemId, { stage });
  addEvent(db, itemId, { kind: `stage:${stage}`, occurredAt, source, emailId, detail: detail ?? stageLabel(stage) });
  if (stageRank(stage) >= stageRank('need_to_return') && stage !== 'refund_confirmed') ensureRefund(db, itemId);
}

/** Manual stage correction from the item page. */
export function manualStage(db, itemId, stage, note, today = todayISO()) {
  mustItem(db, itemId);
  if (stage === 'refund_confirmed') {
    // Route through the refund flow so amounts are recorded properly.
    return confirmRefund(db, itemId, {}, today);
  }
  setStage(db, itemId, stage, { source: 'manual', occurredAt: today, detail: `Changed to "${stageLabel(stage)}" by you${note ? ` — ${note}` : ''}` });
  // Moving back out of the return flow (e.g. "actually I'm keeping it"):
  // drop a refund that never had money attached so totals stay correct.
  const refund = getRefund(db, itemId);
  if (refund && stageRank(stage) < stageRank('need_to_return') && !refund.issued_cents && !refund.confirmed_cents) {
    db.prepare('DELETE FROM refunds WHERE id = ?').run(refund.id);
  }
  return getItem(db, itemId);
}

/** "I dropped it off" — for when no drop-off receipt email arrives. */
export function markDroppedOff(db, itemId, date, today = todayISO()) {
  const item = mustItem(db, itemId);
  const when = date || today;
  update(db, 'items', itemId, { dropped_off_at: when, dropoff_source: 'manual' });
  if (stageRank(item.stage) < stageRank('dropped_off')) {
    setStage(db, itemId, 'dropped_off', { source: 'manual', occurredAt: when, detail: `You marked it dropped off on ${when}` });
  } else {
    addEvent(db, itemId, { kind: 'dropoff_date_edited', occurredAt: when, source: 'manual', detail: `Drop-off date set to ${when}` });
  }
  recomputeRefundWindow(db, itemId);
  return getItem(db, itemId);
}

/** Split `qty` units off into a new row (used for partial returns). Returns new item id. */
export function splitItem(db, itemId, qty) {
  const item = mustItem(db, itemId);
  if (qty <= 0 || qty >= item.quantity) return itemId;
  const { id, created_at, ...copy } = item;
  const cols = Object.keys(copy);
  const newId = db
    .prepare(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`)
    .run({ ...copy, quantity: qty, split_from_item_id: itemId }).lastInsertRowid;
  update(db, 'items', itemId, { quantity: item.quantity - qty });
  const refund = getRefund(db, itemId);
  if (refund && refund.status === 'pending' && item.unit_price_cents != null) {
    update(db, 'refunds', refund.id, { expected_cents: item.unit_price_cents * (item.quantity - qty) });
  }
  db.prepare('INSERT INTO email_items (email_id, item_id) SELECT email_id, ? FROM email_items WHERE item_id = ?').run(newId, itemId);
  db.prepare('INSERT INTO events (item_id, kind, occurred_at, source, email_id, detail) SELECT ?, kind, occurred_at, source, email_id, detail FROM events WHERE item_id = ? ORDER BY id').run(newId, itemId);
  addEvent(db, newId, { kind: 'split', occurredAt: todayISO(), source: 'system', detail: `${qty} of ${item.quantity} units separated for return; ${item.quantity - qty} remain on the original line` });
  return newId;
}

// --- Refunds -------------------------------------------------------------

export function ensureRefund(db, itemId) {
  const existing = getRefund(db, itemId);
  if (existing) return existing;
  const item = mustItem(db, itemId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id);
  db.prepare('INSERT INTO refunds (item_id, expected_cents, destination, is_sample) VALUES (?, ?, ?, ?)').run(
    itemId, item.unit_price_cents != null ? item.unit_price_cents * item.quantity : null, order.payment_method, item.is_sample,
  );
  recomputeRefundWindow(db, itemId);
  return getRefund(db, itemId);
}

export function recomputeRefundWindow(db, itemId) {
  const refund = getRefund(db, itemId);
  if (!refund || !isOpen(refund.status)) return;
  const item = getItem(db, itemId);
  const policy = item.policy_json ? JSON.parse(item.policy_json) : null;
  const settings = getSettings(db);
  const w = computePostingWindow({
    timing: refund.timing_json ? JSON.parse(refund.timing_json) : policy?.refundTiming ?? null,
    events: { refund_issued: refund.issued_at, return_received: item.return_received_at, dropped_off: item.dropped_off_at },
    fallbackDays: settings.refundReminderDays,
  });
  // Keep a snoozed reminder unless the window moved later than it.
  const snoozed = refund.next_check_at && refund.next_check_at !== refund.window_end;
  const next = snoozed && (!w.end || refund.next_check_at > w.end) ? refund.next_check_at : w.end;
  update(db, 'refunds', refund.id, {
    window_kind: w.kind, window_start: w.start, window_end: w.end, window_basis: w.basis, window_assumption: w.assumption, next_check_at: next,
  });
}

export function recordRefundIssued(db, itemId, { amountCents, date, destination, emailId }) {
  const refund = ensureRefund(db, itemId);
  const next = applyIssued(refund, { amountCents, date });
  update(db, 'refunds', refund.id, {
    issued_cents: next.issued_cents, issued_at: next.issued_at, status: next.status,
    destination: destination ?? refund.destination,
  });
  recomputeRefundWindow(db, itemId);
  return getRefund(db, itemId);
}

function closeIfDone(db, itemId, refund, today, detail) {
  if (refund.status === 'confirmed' || refund.status === 'resolved') {
    setStage(db, itemId, 'refund_confirmed', { source: 'manual', occurredAt: today, detail });
  }
}

const cents = (c) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);

export function confirmRefund(db, itemId, { amountCents, date }, today = todayISO()) {
  const refund = getRefund(db, itemId);
  if (!refund) throw new UserError('No refund is being tracked for this item');
  if (!isOpen(refund.status)) throw new UserError('This refund is already closed');
  if (amountCents == null && refund.expected_cents == null && !refund.issued_cents) {
    throw new UserError('Enter the amount you received — no expected or issued amount is known yet');
  }
  const s = getSettings(db);
  const next = applyConfirmation(refund, { amountCents, date: date || today, remindDays: s.snoozeDays });
  update(db, 'refunds', refund.id, { confirmed_cents: next.confirmed_cents, confirmed_at: next.confirmed_at, status: next.status, next_check_at: next.next_check_at });
  const amt = next.confirmed_cents - refund.confirmed_cents;
  const outstanding = (next.expected_cents ?? 0) - next.confirmed_cents;
  const detail = next.status === 'confirmed'
    ? `You confirmed ${cents(amt)} reached your account. Refund complete.`
    : `You confirmed ${cents(amt)} reached your account. ${cents(outstanding)} still outstanding.`;
  addEvent(db, itemId, { kind: 'refund_received', occurredAt: date || today, source: 'manual', detail });
  closeIfDone(db, itemId, next, date || today, detail);
  return getRefund(db, itemId);
}

export function snoozeRefund(db, itemId, today = todayISO()) {
  const refund = getRefund(db, itemId);
  if (!refund || !isOpen(refund.status)) throw new UserError('No open refund');
  const s = getSettings(db);
  const next = applySnooze(refund, { today, remindDays: s.snoozeDays });
  update(db, 'refunds', refund.id, { next_check_at: next.next_check_at });
  addEvent(db, itemId, { kind: 'refund_not_yet', occurredAt: today, source: 'manual', detail: `Not in your account yet — reminding again on ${next.next_check_at}` });
  return getRefund(db, itemId);
}

export function reportRefundProblem(db, itemId, { note, receivedCents }, today = todayISO()) {
  const refund = getRefund(db, itemId);
  if (!refund || !isOpen(refund.status)) throw new UserError('No open refund');
  const s = getSettings(db);
  const next = applyProblem(refund, { note, receivedCents, today, remindDays: s.snoozeDays });
  update(db, 'refunds', refund.id, { confirmed_cents: next.confirmed_cents, status: next.status, problem_note: next.problem_note, next_check_at: next.next_check_at });
  addEvent(db, itemId, { kind: 'refund_problem', occurredAt: today, source: 'manual', detail: `Problem reported: ${note || 'no details'}${receivedCents ? ` (received ${cents(receivedCents)})` : ''}` });
  return getRefund(db, itemId);
}

export function resolveRefund(db, itemId, { note }, today = todayISO()) {
  const refund = getRefund(db, itemId);
  if (!refund || !isOpen(refund.status)) throw new UserError('No open refund');
  const next = applyResolve(refund, { note, date: today });
  update(db, 'refunds', refund.id, { status: next.status, resolution_note: next.resolution_note, confirmed_at: next.confirmed_at, next_check_at: null });
  const detail = `You closed this refund with ${cents(refund.confirmed_cents)} of ${cents(refund.expected_cents)} received${note ? ` — ${note}` : ''}`;
  addEvent(db, itemId, { kind: 'refund_resolved', occurredAt: today, source: 'manual', detail });
  closeIfDone(db, itemId, next, today, detail);
  return getRefund(db, itemId);
}

export function setExpectedRefund(db, itemId, expectedCents, today = todayISO()) {
  const refund = ensureRefund(db, itemId);
  update(db, 'refunds', refund.id, { expected_cents: expectedCents });
  addEvent(db, itemId, { kind: 'expected_refund_edited', occurredAt: today, source: 'manual', detail: `Expected refund set to ${cents(expectedCents)}` });
  return getRefund(db, itemId);
}

export function snoozeDate(db, today) {
  return addDays(today, getSettings(db).snoozeDays);
}
