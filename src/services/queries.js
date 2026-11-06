// Read-only queries for the dashboard, item list, and item detail page.

import { getSettings } from '../db.js';
import { addDays, todayISO } from '../lib/dates.js';
import { outstandingCents, refundBucket, isOpen } from '../lib/refunds.js';
import { stageLabel, STAGES } from '../lib/stages.js';

const ITEM_SELECT = `
  SELECT i.*, o.retailer, o.order_number, o.order_date, o.payment_method, o.merchant_name,
         r.id AS refund_id, r.expected_cents, r.issued_cents, r.confirmed_cents, r.status AS refund_status,
         r.window_end, r.window_kind, r.next_check_at, r.issued_at, r.destination
  FROM items i
  JOIN orders o ON o.id = i.order_id
  LEFT JOIN refunds r ON r.item_id = i.id`;

function decorate(row) {
  return { ...row, stage_label: stageLabel(row.stage) };
}

export function listItems(db, { q, store, stage } = {}) {
  const where = [];
  const params = {};
  if (q) {
    where.push("(i.name LIKE @q OR o.order_number LIKE @q OR o.retailer LIKE @q OR IFNULL(i.seller, '') LIKE @q)");
    params.q = `%${q}%`;
  }
  if (store) { where.push('o.retailer = @store'); params.store = store; }
  if (stage) { where.push('i.stage = @stage'); params.stage = stage; }
  const sql = `${ITEM_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(o.order_date, i.created_at) DESC, i.id DESC`;
  return db.prepare(sql).all(params).map(decorate);
}

export function stores(db) {
  return db.prepare(`SELECT retailer, COALESCE(MAX(merchant_name), CASE retailer WHEN 'amazon' THEN 'Amazon' ELSE retailer END) AS name
                     FROM orders GROUP BY retailer ORDER BY name`).all();
}

export function dashboard(db, today = todayISO()) {
  const s = getSettings(db);
  const items = listItems(db);
  const horizon = addDays(today, s.deadlineWarningDays);

  const deadlines = items
    .filter((i) => ['purchased', 'delivered', 'need_to_return'].includes(i.stage) && i.return_deadline && i.return_deadline <= horizon)
    .sort((a, b) => (a.return_deadline < b.return_deadline ? -1 : 1))
    .map((i) => ({ ...i, overdue: i.return_deadline < today }));

  const deadlinesUnknown = items.filter((i) => ['delivered', 'need_to_return'].includes(i.stage) && !i.return_deadline && i.eligibility !== 'not_eligible');

  const toDropOff = items
    .filter((i) => i.stage === 'return_started')
    .sort((a, b) => ((a.dropoff_deadline ?? '9') < (b.dropoff_deadline ?? '9') ? -1 : 1));

  const inTransit = items.filter((i) => i.stage === 'dropped_off' || i.stage === 'return_received');

  const withRefund = items.filter((i) => i.refund_id && isOpen(i.refund_status));
  const bucket = (i) => refundBucket(
    { status: i.refund_status, window_end: i.window_end, next_check_at: i.next_check_at },
    { today, overdueGraceDays: s.overdueGraceDays },
  );
  const awaitingPosting = withRefund.filter((i) => bucket(i) === 'awaiting_posting');
  const needsCheck = withRefund
    .filter((i) => ['check', 'overdue', 'problem'].includes(bucket(i)))
    .map((i) => ({ ...i, bucket: bucket(i) }));

  const totalOutstandingCents = withRefund.reduce(
    (sum, i) => sum + outstandingCents({ status: i.refund_status, expected_cents: i.expected_cents, issued_cents: i.issued_cents, confirmed_cents: i.confirmed_cents }),
    0,
  );

  const emailsNeedingReview = db.prepare('SELECT id, subject, review_reason, web_link, is_sample FROM emails WHERE needs_review = 1 ORDER BY received_at DESC').all();
  const pendingSuggestions = db.prepare("SELECT COUNT(*) AS n FROM policy_reviews WHERE status = 'suggested'").get().n;

  return {
    today,
    hasSampleData: !!db.prepare('SELECT 1 FROM orders WHERE is_sample = 1 LIMIT 1').get(),
    counts: { items: items.length },
    deadlines, deadlinesUnknown, toDropOff, inTransit, awaitingPosting, needsCheck,
    totalOutstandingCents, emailsNeedingReview, pendingSuggestions,
  };
}

export function itemDetail(db, id) {
  const item = db.prepare(ITEM_SELECT + ' WHERE i.id = ?').get(id);
  if (!item) return null;
  const policy = item.policy_json ? JSON.parse(item.policy_json) : null;
  return {
    item: decorate(item),
    policy,
    refund: db.prepare('SELECT * FROM refunds WHERE item_id = ?').get(id) ?? null,
    events: db.prepare(`SELECT e.*, m.subject AS email_subject, m.web_link AS email_link
                        FROM events e LEFT JOIN emails m ON m.id = e.email_id
                        WHERE e.item_id = ? ORDER BY COALESCE(e.occurred_at, e.created_at), e.id`).all(id),
    emails: db.prepare(`SELECT m.id, m.kind, m.subject, m.from_addr, m.received_at, m.web_link, m.is_sample
                        FROM emails m JOIN email_items ei ON ei.email_id = m.id
                        WHERE ei.item_id = ? ORDER BY m.received_at`).all(id),
    siblings: db.prepare('SELECT id, name, quantity, stage FROM items WHERE order_id = ? AND id != ?').all(item.order_id, id).map(decorate),
    suggestions: db.prepare("SELECT * FROM policy_reviews WHERE item_id = ? AND status = 'suggested' ORDER BY id DESC").all(id)
      .map((r) => ({ ...r, result: JSON.parse(r.result_json) })),
    stages: STAGES,
  };
}
