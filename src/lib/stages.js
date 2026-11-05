// The nine stages an item moves through. "rank" lets us compare stages so
// that email evidence only ever moves an item FORWARD automatically.

export const STAGES = [
  { key: 'purchased', label: 'Purchased', rank: 1 },
  { key: 'delivered', label: 'Delivered / deciding', rank: 2 },
  { key: 'keeping', label: 'Keeping', rank: 3 },
  { key: 'need_to_return', label: 'Need to return', rank: 4 },
  { key: 'return_started', label: 'Return started', rank: 5 },
  { key: 'dropped_off', label: 'Dropped off', rank: 6 },
  { key: 'return_received', label: 'Return received by retailer', rank: 7 },
  { key: 'refund_issued', label: 'Refund issued / awaiting posting', rank: 8 },
  { key: 'refund_confirmed', label: 'Refund personally confirmed', rank: 9 },
];

const BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

export const isStage = (key) => key in BY_KEY;
export const stageRank = (key) => BY_KEY[key]?.rank ?? 0;
export const stageLabel = (key) => BY_KEY[key]?.label ?? key;

/** Which stage each kind of email is evidence for (null = no stage change). */
export const EMAIL_KIND_STAGE = {
  order_confirmation: 'purchased',
  shipped: null,
  delivered: 'delivered',
  return_started: 'return_started',
  dropped_off: 'dropped_off',
  return_received: 'return_received',
  refund_issued: 'refund_issued',
};

export const RETURN_FLOW = ['need_to_return', 'return_started', 'dropped_off', 'return_received', 'refund_issued'];

/**
 * Decide the new stage given email evidence.
 * - Never moves backwards (a late "delivered" email can't undo "return started").
 * - Never reaches "refund_confirmed": only the user can confirm money arrived.
 */
export function advanceStage(current, evidence) {
  if (!evidence || evidence === 'refund_confirmed') return current;
  return stageRank(evidence) > stageRank(current) ? evidence : current;
}
