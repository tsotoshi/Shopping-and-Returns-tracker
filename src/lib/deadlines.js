// Return-deadline math. Pure functions: given a policy and the facts we know
// about an order, compute deadlines and say how sure we are.
//
// A "policy" object (from AI review, a sample, or the user) looks like:
//   {
//     eligible: true | false | null,          // null = unknown
//     windowDays: 30,                         // null = unknown
//     startsFrom: 'delivery' | 'purchase',
//     dropoffDays: 14,                        // days to ship/drop off after starting a return
//     holidayExtension: { purchasedFrom, purchasedTo, returnBy } | null,
//     confidence: 'confirmed' | 'estimated' | 'needs_review'
//   }
//
// Status meanings shown in the UI:
//   confirmed    - every input came from a source (policy + actual dates)
//   estimated    - we had to assume something (e.g. delivery date unknown)
//   needs_review - we can't responsibly compute a date

import { addDays, maxDate } from './dates.js';

const worse = (a, b) => {
  const order = ['confirmed', 'estimated', 'needs_review'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
};

export function computeReturnDeadline({ policy, orderDate, deliveredDate, estimatedDeliveryDate }) {
  if (!policy) {
    return { date: null, status: 'needs_review', eligibility: 'unknown', basis: 'No return policy reviewed yet.' };
  }
  if (policy.eligible === false) {
    return { date: null, status: policy.confidence ?? 'needs_review', eligibility: 'not_eligible', basis: 'Policy says this item is not returnable.' };
  }
  if (policy.windowDays == null) {
    return { date: null, status: 'needs_review', eligibility: policy.eligible ? 'eligible' : 'unknown', basis: 'Return window length is unknown.' };
  }

  let status = policy.confidence ?? 'needs_review';
  let start;
  let basis;
  if (policy.startsFrom === 'delivery') {
    if (deliveredDate) {
      start = deliveredDate;
      basis = `${policy.windowDays} days from delivery (${deliveredDate}).`;
    } else if (estimatedDeliveryDate) {
      start = estimatedDeliveryDate;
      status = worse(status, 'estimated');
      basis = `${policy.windowDays} days from the ESTIMATED delivery date (${estimatedDeliveryDate}); will update when delivery is confirmed.`;
    } else if (orderDate) {
      // Counting from the order date gives the earliest possible deadline,
      // so we err on the safe side rather than risk missing it.
      start = orderDate;
      status = worse(status, 'estimated');
      basis = `${policy.windowDays} days counted from the order date (${orderDate}) because delivery date is unknown — the real deadline is probably later.`;
    } else {
      return { date: null, status: 'needs_review', eligibility: 'unknown', basis: 'No order or delivery date available.' };
    }
  } else {
    if (!orderDate) return { date: null, status: 'needs_review', eligibility: 'unknown', basis: 'Order date unknown.' };
    start = orderDate;
    basis = `${policy.windowDays} days from purchase (${orderDate}).`;
  }

  let date = addDays(start, policy.windowDays);
  const h = policy.holidayExtension;
  if (h && orderDate && orderDate >= h.purchasedFrom && orderDate <= h.purchasedTo) {
    const extended = maxDate(date, h.returnBy);
    if (extended !== date) {
      date = extended;
      basis += ` Holiday extension applies (bought ${h.purchasedFrom}–${h.purchasedTo}): return by ${h.returnBy}.`;
    }
  }

  return {
    date,
    status,
    eligibility: policy.eligible === true ? 'eligible' : 'unknown',
    basis,
  };
}

/**
 * Deadline for shipping/dropping off a return that has been started.
 * An explicit date from a return-confirmation email beats a calculation.
 */
export function computeDropoffDeadline({ policy, returnStartedAt, emailDropoffBy }) {
  if (emailDropoffBy) {
    return { date: emailDropoffBy, status: 'confirmed', basis: 'Drop-off date stated in the return confirmation email.' };
  }
  if (returnStartedAt && policy?.dropoffDays != null) {
    return {
      date: addDays(returnStartedAt, policy.dropoffDays),
      status: worse(policy.confidence ?? 'needs_review', 'estimated'),
      basis: `${policy.dropoffDays} days after starting the return (${returnStartedAt}), per policy.`,
    };
  }
  return { date: null, status: 'needs_review', basis: returnStartedAt ? 'Drop-off deadline unknown.' : 'Return not started.' };
}
