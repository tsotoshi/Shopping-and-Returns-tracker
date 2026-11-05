// Runs AI policy reviews for items and stores the (verified) results.
// Results go through applyPolicyResult(), so if you've corrected an item's
// deadline, the AI result becomes a suggestion instead of overwriting yours.

import { todayISO } from '../lib/dates.js';
import { buildRequest, runReview, verifyItemResult, unreviewedResult, RETAILER_POLICY_SOURCES } from '../ai/policyReview.js';
import { applyPolicyResult, addEvent } from './items.js';

const BATCH = 8; // items per AI request — one policy lookup serves several items
let running = false;
export const isReviewing = () => running;

const ITEM_SQL = `SELECT i.*, o.retailer, o.order_date FROM items i JOIN orders o ON o.id = i.order_id`;

/** Real (non-sample) items that are still undecided or in a return and have no AI/user policy yet. */
export function itemsNeedingReview(db) {
  return db.prepare(`${ITEM_SQL}
    WHERE i.is_sample = 0
      AND i.stage IN ('purchased', 'delivered', 'need_to_return', 'return_started')
      AND (i.policy_origin IS NULL)
    ORDER BY i.id`).all();
}

export async function reviewPolicies(db, { client, itemIds, today = todayISO() } = {}) {
  if (running) throw new Error('A policy review is already running.');
  running = true;
  const summary = { reviewed: 0, confirmed: 0, estimated: 0, needsReview: 0, suggestions: 0, skipped: 0 };
  try {
    const items = itemIds?.length
      ? db.prepare(`${ITEM_SQL} WHERE i.id IN (${itemIds.map(() => '?').join(',')})`).all(...itemIds)
      : itemsNeedingReview(db);

    const byRetailer = new Map();
    for (const it of items) {
      if (it.is_sample) { summary.skipped++; continue; } // never send made-up sample items to the AI
      if (!RETAILER_POLICY_SOURCES[it.retailer]) { summary.skipped++; continue; }
      if (!byRetailer.has(it.retailer)) byRetailer.set(it.retailer, []);
      byRetailer.get(it.retailer).push(it);
    }

    for (const [retailer, list] of byRetailer) {
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const userUrls = [...new Set(batch.map((b) => b.policy_user_url).filter(Boolean))];
        const { params, domains } = buildRequest({ retailer, items: batch, userUrls, today });
        const { submission, fetched } = await runReview(client, params);
        const byRef = new Map((submission?.items ?? []).map((r) => [String(r.ref), r]));

        for (const item of batch) {
          const raw = byRef.get(String(item.id));
          const result = raw
            ? verifyItemResult(raw, { item, fetched, domains, today })
            : unreviewedResult(submission ? 'The AI returned no result for this item.' : 'The AI did not finish the review. Try again, or add a policy link.', today);
          const r = applyPolicyResult(db, item.id, result, 'ai');
          summary.reviewed++;
          if (r.suggested) summary.suggestions++;
          else summary[{ confirmed: 'confirmed', estimated: 'estimated', needs_review: 'needsReview' }[result.policy.confidence]]++;
          addEvent(db, item.id, {
            kind: 'policy_reviewed', occurredAt: today, source: 'system',
            detail: r.suggested ? 'AI policy review finished — saved as a suggestion because you corrected this item' : `AI policy review: ${result.policy.confidence.replace('_', ' ')}`,
          });
        }
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

/** You supply an official policy link for an item; it's used on the next review. */
export function setPolicyLink(db, itemId, url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That doesn\'t look like a web address.'); }
  if (u.protocol !== 'https:') throw new Error('Please use an https:// link.');
  db.prepare('UPDATE items SET policy_user_url = ? WHERE id = ?').run(u.toString(), itemId);
  addEvent(db, itemId, { kind: 'policy_link_added', occurredAt: todayISO(), source: 'manual', detail: `You added a policy link: ${u.hostname}` });
}
