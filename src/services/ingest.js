// The import pipeline: takes ONE already-parsed email and records what it
// tells us. Retailer-specific parsers (Stage 2) turn raw Gmail messages into
// this "parsed email" shape, so this file never needs to know about Amazon
// specifically — adding a retailer means adding a parser, nothing here.
//
// Parsed email shape:
// {
//   messageId, threadId, retailer, kind,      // kind: see EMAIL_KIND_STAGE
//   subject, from, receivedAt, webLink,
//   orderNumber, orderDate, paymentMethod,
//   eventDate,                                 // date the thing happened (defaults to receivedAt)
//   items: [{ name, retailerItemId, quantity, unitPriceCents, seller, refundCents }],
//   estimatedDeliveryDate, deliveredDate,
//   dropoffBy, labelUrl, qrUrl, instructions,  // return_started
//   refundCents, refundDestination,            // refund_issued (order-level total)
//   refundTiming,                              // e.g. "3–5 business days" stated in the email
//   warnings: ['...']                          // parser wasn't fully sure -> shown for review
// }

import { EMAIL_KIND_STAGE, advanceStage, stageRank } from '../lib/stages.js';
import { matchItem } from '../lib/matching.js';
import {
  addEvent, getItem, recomputeDeadlines, recomputeRefundWindow, splitItem, ensureRefund, recordRefundIssued,
} from './items.js';

const EVENT_TEXT = {
  order_confirmation: 'Order confirmed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  return_started: 'Return started',
  dropped_off: 'Drop-off receipt',
  return_received: 'Retailer received the return',
  refund_issued: 'Refund issued by retailer (not yet confirmed in your account)',
};

// When the same product exists as several rows (after a partial return
// split), which row should a given email apply to? First match wins.
const ROW_PREFERENCE = {
  return_started: ['need_to_return', 'delivered', 'keeping', 'purchased'],
  dropped_off: ['return_started', 'need_to_return'],
  return_received: ['dropped_off', 'return_started'],
  refund_issued: ['return_received', 'dropped_off', 'return_started', 'refund_issued'],
};

function pickRow(group, kind) {
  const prefs = ROW_PREFERENCE[kind];
  if (!prefs) return group;
  for (const stage of prefs) {
    const row = group.find((r) => r.stage === stage);
    if (row) return [row];
  }
  return [group[0]];
}

function productGroups(items) {
  const m = new Map();
  for (const it of items) {
    const key = it.split_from_item_id ?? it.id;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(it);
  }
  return [...m.values()];
}

export function ingestParsedEmail(db, parsed, { isSample = false } = {}) {
  return db.transaction(() => {
    const provider = parsed.provider ?? 'gmail';
    // 1. Duplicate check: the same Gmail message is only ever imported once.
    const seen = db.prepare('SELECT id FROM emails WHERE provider = ? AND message_id = ?').get(provider, parsed.messageId);
    if (seen) return { status: 'duplicate', emailId: seen.id, itemIds: [] };

    const eventDate = (parsed.eventDate ?? parsed.receivedAt ?? '').slice(0, 10) || null;
    const sample = isSample ? 1 : 0;

    // 2. Find or create the order (unique per retailer + order number).
    let order = null;
    if (parsed.orderNumber) {
      db.prepare(`INSERT INTO orders (retailer, order_number, order_date, payment_method, merchant_name, order_total_cents, is_sample) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (retailer, order_number) DO UPDATE SET
                    order_date = COALESCE(orders.order_date, excluded.order_date),
                    payment_method = COALESCE(orders.payment_method, excluded.payment_method),
                    merchant_name = COALESCE(orders.merchant_name, excluded.merchant_name),
                    order_total_cents = COALESCE(orders.order_total_cents, excluded.order_total_cents)`)
        .run(parsed.retailer, parsed.orderNumber, parsed.orderDate ?? null, parsed.paymentMethod ?? null, parsed.merchantName ?? null,
          parsed.kind === 'order_confirmation' ? parsed.orderTotalCents ?? null : null, sample);
      order = db.prepare('SELECT * FROM orders WHERE retailer = ? AND order_number = ?').get(parsed.retailer, parsed.orderNumber);
    }

    // 3. Store the email itself (for the "supporting emails" links).
    const emailId = db.prepare(`INSERT INTO emails (provider, message_id, thread_id, retailer, kind, subject, from_addr, received_at, web_link, order_id, parsed_json, is_sample)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(provider, parsed.messageId, parsed.threadId ?? null, parsed.retailer, parsed.kind, parsed.subject ?? null, parsed.from ?? null,
        parsed.receivedAt ?? null, parsed.webLink ?? null, order?.id ?? null, JSON.stringify(parsed), sample).lastInsertRowid;

    const flag = (reason) => {
      db.prepare('UPDATE emails SET needs_review = 1, review_reason = ? WHERE id = ?').run(reason, emailId);
      return { status: 'needs_review', emailId, itemIds: [], reason };
    };
    if (!order) return flag('No order number found in this email.');

    // 4. Work out which item rows this email is about.
    const orderItems = () => db.prepare('SELECT * FROM items WHERE order_id = ? ORDER BY id').all(order.id);
    const targets = []; // [{ row, emailItem }]
    const problems = [];

    if (parsed.items?.length) {
      for (const ei of parsed.items) {
        const all = orderItems();
        // Match on the name the emails use, even if you renamed the item.
        const m = matchItem(all.map((it) => ({ ...it, name: it.email_name || it.name })), ei);
        if (m.ambiguous) { problems.push(`"${ei.name}" matches more than one item`); continue; }
        if (m.match) {
          for (const row of pickRow(m.group, parsed.kind)) targets.push({ row, emailItem: ei });
          continue;
        }
        const groups = productGroups(all);
        // The order already has real names from your Amazon order page, and this
        // email only gives a category: attach the email instead of duplicating items.
        const siteRows = ei.categoryName ? all.filter((r) => r.name_source === 'amazon_site') : [];
        if (siteRows.length && ['order_confirmation', 'shipped', 'delivered'].includes(parsed.kind)) {
          const rowsToUpdate = parsed.kind === 'order_confirmation' ? siteRows : siteRows.filter((r) => stageRank(r.stage) < stageRank(EMAIL_KIND_STAGE[parsed.kind] ?? 'purchased'));
          for (const row of rowsToUpdate) targets.push({ row, emailItem: {} });
          continue;
        }
        if (parsed.kind === 'order_confirmation' || parsed.kind === 'shipped' || parsed.kind === 'delivered' || !all.length) {
          const id = db.prepare(`INSERT INTO items (order_id, name, email_name, retailer_item_id, seller, quantity, unit_price_cents, notes, name_source, is_sample)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(order.id, ei.name, ei.name, ei.retailerItemId ?? null, ei.seller ?? null, ei.quantity ?? 1, ei.unitPriceCents ?? null, ei.note ?? null,
              ei.categoryName ? 'email_category' : ei.source === 'ai' ? 'email_ai' : 'email', sample).lastInsertRowid;
          if (parsed.kind !== 'order_confirmation') addEvent(db, id, { kind: 'stage:purchased', occurredAt: order.order_date, source: 'system', detail: 'Item first seen in a later email (no order confirmation imported)' });
          targets.push({ row: getItem(db, id), emailItem: ei, created: true });
        } else if (groups.length === 1) {
          for (const row of pickRow(groups[0], parsed.kind)) targets.push({ row, emailItem: ei });
        } else {
          problems.push(`"${ei.name}" doesn't match any item in order ${order.order_number}`);
        }
      }
    } else {
      // Email doesn't list items (common for delivery and refund notices).
      const all = orderItems();
      const groups = productGroups(all);
      if (parsed.kind === 'shipped' || parsed.kind === 'delivered') {
        for (const row of all.filter((r) => r.stage === 'purchased')) targets.push({ row, emailItem: {} });
      } else if (groups.length === 1) {
        for (const row of pickRow(groups[0], parsed.kind)) targets.push({ row, emailItem: {} });
      } else {
        const inReturn = all.filter((r) => (ROW_PREFERENCE[parsed.kind] ?? []).includes(r.stage));
        if (inReturn.length === 1) targets.push({ row: inReturn[0], emailItem: {} });
        else problems.push(`Email doesn't say which item in order ${order.order_number} it's about`);
      }
    }

    if (parsed.warnings?.length) problems.push(...parsed.warnings);
    if (parsed.kind === 'refund_issued' && targets.length > 1 && targets.some((t) => t.emailItem.refundCents == null)) {
      problems.push('Refund amount could not be split between items — please check each item\'s issued amount');
    }

    // Several email lines can point at the same row; handle each row once.
    const uniqueTargets = [];
    const seenRows = new Set();
    for (const t of targets) if (!seenRows.has(t.row.id)) { seenRows.add(t.row.id); uniqueTargets.push(t); }
    targets.length = 0;
    targets.push(...uniqueTargets);

    // 5. Apply the email's effects to each targeted item.
    const itemIds = [];
    for (const t of targets) {
      const id = applyEffects(db, t, parsed, { emailId, eventDate, order, singleTarget: targets.length === 1 });
      itemIds.push(id);
      db.prepare('INSERT OR IGNORE INTO email_items (email_id, item_id) VALUES (?, ?)').run(emailId, id);
    }

    if (problems.length) {
      db.prepare('UPDATE emails SET needs_review = 1, review_reason = ? WHERE id = ?').run(problems.join('; '), emailId);
      return { status: itemIds.length ? 'partial' : 'needs_review', emailId, itemIds, reason: problems.join('; ') };
    }
    return { status: 'imported', emailId, itemIds };
  })();
}

function applyEffects(db, { row, emailItem: ei, created }, parsed, { emailId, eventDate, order, singleTarget }) {
  let id = row.id;
  const kind = parsed.kind;

  // Partial return of a multi-quantity line: split it so each row has one stage.
  if (kind === 'return_started' && ei.quantity && ei.quantity < row.quantity) {
    id = splitItem(db, id, ei.quantity);
  }
  let item = getItem(db, id);

  // Fill in details we didn't have (never overwrite what we already know).
  const fill = {};
  if (item.unit_price_cents == null && ei.unitPriceCents != null) fill.unit_price_cents = ei.unitPriceCents;
  if (item.seller == null && ei.seller) fill.seller = ei.seller;
  if (item.retailer_item_id == null && ei.retailerItemId) fill.retailer_item_id = ei.retailerItemId;
  if ((kind === 'shipped' || kind === 'order_confirmation') && parsed.estimatedDeliveryDate && !item.delivered_date) fill.estimated_delivery_date = parsed.estimatedDeliveryDate;
  if (kind === 'delivered') fill.delivered_date = parsed.deliveredDate ?? eventDate;
  if (kind === 'return_started') {
    fill.return_started_at = eventDate;
    if (parsed.dropoffBy) fill.email_dropoff_by = parsed.dropoffBy;
    if (parsed.labelUrl) fill.label_url = parsed.labelUrl;
    if (parsed.qrUrl) fill.qr_url = parsed.qrUrl;
    if (parsed.instructions) fill.return_instructions = parsed.instructions;
  }
  if (kind === 'dropped_off') Object.assign(fill, { dropped_off_at: eventDate, dropoff_source: 'email' });
  if (kind === 'return_received') fill.return_received_at = eventDate;
  if (Object.keys(fill).length) {
    db.prepare(`UPDATE items SET ${Object.keys(fill).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fill, id });
    item = getItem(db, id);
  }

  // Timeline entry from this email.
  addEvent(db, id, { kind: `email:${kind}`, occurredAt: kind === 'order_confirmation' ? order.order_date ?? eventDate : eventDate, source: 'email', emailId, detail: EVENT_TEXT[kind] });

  // Stage: only ever moves forward on email evidence.
  const evidence = EMAIL_KIND_STAGE[kind];
  const next = advanceStage(item.stage, evidence);
  if (next !== item.stage) {
    db.prepare('UPDATE items SET stage = ? WHERE id = ?').run(next, id);
    if (stageRank(next) >= stageRank('need_to_return')) ensureRefund(db, id);
  }

  if (kind === 'return_started' && ei.refundCents != null) {
    const r = ensureRefund(db, id);
    if (!r.issued_cents) db.prepare('UPDATE refunds SET expected_cents = ? WHERE id = ?').run(ei.refundCents, r.id);
  }

  if (kind === 'refund_issued') {
    // Per-item amount if the email lists one; otherwise the order-level total
    // only when this email clearly concerns a single item.
    const amount = ei.refundCents ?? (singleTarget ? parsed.refundCents : null);
    if (parsed.refundTiming) {
      db.prepare('UPDATE refunds SET timing_json = ? WHERE item_id = ?').run(JSON.stringify({ ...parsed.refundTiming, source: 'email' }), id);
    }
    recordRefundIssued(db, id, { amountCents: amount ?? 0, date: eventDate, destination: parsed.refundDestination, emailId });
  }

  if (['delivered', 'shipped', 'return_started', 'order_confirmation'].includes(kind) || created) recomputeDeadlines(db, id);
  recomputeRefundWindow(db, id);
  return id;
}

