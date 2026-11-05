// Refund follow-up math. Pure functions — the database layer calls these.
//
// Key rule: a "refund issued" email is NOT proof the money reached you.
// Only the user's own "Refund received" confirmation closes a refund.

import { addDays, addBusinessDays, maxDate, HOLIDAY_ASSUMPTION } from './dates.js';

const EVENT_LABEL = {
  refund_issued: 'refund was issued',
  return_received: 'retailer received the return',
  dropped_off: 'you dropped off the return',
};

/**
 * Work out when the refund should show up in your payment account.
 *
 * timing (from the policy; may be null):
 *   { minDays, maxDays, unit: 'calendar' | 'business', startEvent: 'refund_issued' | 'return_received' | 'dropped_off' }
 * events: { refund_issued, return_received, dropped_off } — dates we know
 * fallbackDays: user's configurable reminder interval, used when timing is unknown
 */
export function computePostingWindow({ timing, events = {}, fallbackDays = 10 }) {
  if (timing && timing.maxDays != null && events[timing.startEvent]) {
    const start = events[timing.startEvent];
    const add = timing.unit === 'business' ? addBusinessDays : addDays;
    const unitWord = timing.unit === 'business' ? 'business days' : 'calendar days';
    const min = timing.minDays ?? timing.maxDays;
    const who = timing.source === 'email' ? 'Stated in the refund email' : 'Retailer timing';
    const assumptions = [];
    if (timing.unitAssumed) assumptions.push("The source didn't say business or calendar days, so we assumed business days (the later, safer date).");
    if (timing.unit === 'business') assumptions.push(HOLIDAY_ASSUMPTION);
    return {
      kind: 'retailer',
      start: add(start, min),
      end: add(start, timing.maxDays),
      basis: `${who}: ${min === timing.maxDays ? min : `${min}–${timing.maxDays}`} ${unitWord} after the ${EVENT_LABEL[timing.startEvent]} (${start}).`,
      assumption: assumptions.join(' ') || null,
    };
  }

  // No usable retailer timing (unknown, or its start event hasn't happened).
  // Fall back to the user's reminder interval from the latest thing we know.
  const latest = ['refund_issued', 'return_received', 'dropped_off']
    .map((k) => ({ k, d: events[k] }))
    .filter((x) => x.d)
    .sort((a, b) => (a.d < b.d ? 1 : -1))[0];
  if (!latest) return { kind: 'none', start: null, end: null, basis: 'Waiting for the return to be dropped off.', assumption: null };

  const why = timing ? `Retailer timing starts when the ${EVENT_LABEL[timing.startEvent]}, which hasn't happened yet.` : 'Retailer refund timing is unknown.';
  return {
    kind: 'default_interval',
    start: latest.d,
    end: addDays(latest.d, fallbackDays),
    basis: `${why} Using your default reminder: ${fallbackDays} calendar days after the ${EVENT_LABEL[latest.k]} (${latest.d}).`,
    assumption: 'This is a reminder interval you set, not a retailer promise.',
  };
}

export const OPEN_STATUSES = ['pending', 'issued', 'partial', 'problem'];
export const isOpen = (status) => OPEN_STATUSES.includes(status);

export function outstandingCents(refund) {
  if (!isOpen(refund.status)) return 0;
  const expected = refund.expected_cents ?? refund.issued_cents ?? 0;
  return Math.max(0, expected - (refund.confirmed_cents ?? 0));
}

/** Apply a "refund issued" email. Adds to issued amount; never closes the refund. */
export function applyIssued(refund, { amountCents, date }) {
  const issued = (refund.issued_cents ?? 0) + (amountCents ?? 0);
  return {
    ...refund,
    issued_cents: issued,
    issued_at: maxDate(refund.issued_at, date),
    status: refund.status === 'problem' ? 'problem' : refund.confirmed_cents > 0 ? 'partial' : 'issued',
  };
}

/**
 * User says "Refund received". amountCents defaults to what's been issued but
 * not yet confirmed (or the outstanding expected amount if nothing was issued).
 * If the total confirmed covers the expected amount, the refund closes.
 * Otherwise it stays open as "partial" with a new reminder.
 */
export function applyConfirmation(refund, { amountCents, date, remindDays }) {
  const expected = refund.expected_cents ?? refund.issued_cents ?? 0;
  const already = refund.confirmed_cents ?? 0;
  const defaultAmount = Math.max(0, (refund.issued_cents ?? 0) - already) || Math.max(0, expected - already);
  const amount = amountCents ?? defaultAmount;
  const confirmed = already + amount;
  const done = confirmed >= expected;
  return {
    ...refund,
    confirmed_cents: confirmed,
    confirmed_at: date,
    status: done ? 'confirmed' : 'partial',
    next_check_at: done ? null : addDays(date, remindDays),
  };
}

export function applySnooze(refund, { today, remindDays }) {
  return { ...refund, next_check_at: addDays(today, remindDays) };
}

export function applyProblem(refund, { note, receivedCents, today, remindDays }) {
  return {
    ...refund,
    confirmed_cents: (refund.confirmed_cents ?? 0) + (receivedCents ?? 0),
    status: 'problem',
    problem_note: note,
    next_check_at: addDays(today, remindDays),
  };
}

/** User explicitly accepts a shortfall (e.g. a legitimate restocking fee). */
export function applyResolve(refund, { note, date }) {
  return { ...refund, status: 'resolved', resolution_note: note, confirmed_at: refund.confirmed_at ?? date, next_check_at: null };
}

/** Where a refund sits for the dashboard. */
export function refundBucket(refund, { today, overdueGraceDays = 7 }) {
  if (!isOpen(refund.status)) return 'closed';
  if (refund.status === 'problem') return 'problem';
  if (refund.window_end && today > addDays(refund.window_end, overdueGraceDays)) return 'overdue';
  if (refund.next_check_at && today >= refund.next_check_at) return 'check';
  if (refund.status === 'issued' || refund.status === 'partial') return 'awaiting_posting';
  return 'not_issued';
}
