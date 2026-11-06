// Optional: fill in real Amazon product names, prices, sellers and Amazon's own
// "return eligible through" dates by reading your Amazon order pages with the
// amazon-orders library (via tools/amazon_orders_bridge.py).
//
// Emails stay the main source (they track returns and refunds). This adds
// detail to the same orders, matched by order number, and creates orders that
// no email covered.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayISO } from '../lib/dates.js';
import { matchItem, similarity } from '../lib/matching.js';
import { stageRank } from '../lib/stages.js';
import { parseMonthDay } from '../retailers/amazon.js';
import { addEvent, applyPolicyResult, getItem, recomputeDeadlines } from '../services/items.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATEGORY_NOTE_RE = /Amazon's email only gave the category[^.]*\. Use Rename[^.]*\.\s*/;
const TOTAL_NOTE_RE = /Price is the order's grand total[\s\S]*?item prices\.\s*/;

export function amazonSiteConfig(env = process.env) {
  const venvPython = path.join(ROOT, '.venv', 'bin', 'python');
  const python = env.AMAZON_ORDERS_PYTHON || (fs.existsSync(venvPython) ? venvPython : null);
  return { python, script: path.join(ROOT, 'tools', 'amazon_orders_bridge.py'), available: !!python };
}

/** Run the Python helper. Always resolves to { ok, orders? , error?, detail? }. */
export function runBridge({ python, script, timeFilter = 'last30', skipDetails = [], timeoutMs = 300_000, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      const args = [script, '--time-filter', timeFilter];
      if (skipDetails.length) args.push('--skip-details', skipDetails.join(','));
      child = spawnImpl(python, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    } catch (e) {
      resolve({ ok: false, error: 'bridge_failed', detail: e.message });
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: 'bridge_failed', detail: e.message }));
    child.on('close', (code, signal) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ ok: false, error: 'bridge_failed', detail: signal ? `stopped (${signal})` : `exit ${code}: ${err.trim().split('\n').slice(-3).join(' ')}` });
      }
    });
  });
}

const cents = (n) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100));
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** "Delivered November 3" -> 2026-11-03 (year from the order date) */
function deliveredDateFrom(status, orderDate) {
  if (!status || !/delivered/i.test(status)) return null;
  if (/today/i.test(status)) return todayISO();
  return parseMonthDay(status, orderDate ?? todayISO());
}

function siteItemsOf(order) {
  const deliveredByTitle = new Map();
  for (const sh of order.shipments ?? []) {
    const d = deliveredDateFrom(sh.delivery_status, isoDate(order.order_placed_date));
    for (const it of sh.items ?? []) if (d && it.title) deliveredByTitle.set(it.title, d);
  }
  return (order.items ?? []).filter((i) => i.title).map((i) => ({
    title: String(i.title).trim(),
    asin: i.asin ?? null,
    priceCents: cents(i.price),
    quantity: Number(i.quantity) || 1,
    seller: i.seller?.name && !/^amazon(\.com)?( services)?/i.test(i.seller.name) ? i.seller.name : null,
    returnBy: isoDate(i.return_eligible_date),
    deliveredDate: deliveredByTitle.get(i.title) ?? null,
  }));
}

/** Pair leftover site items with leftover email rows: best word overlap first, then in order. */
function pairLeftovers(rows, siteItems) {
  const pairs = [];
  const r = [...rows];
  const s = [...siteItems];
  while (r.length && s.length) {
    let best = null;
    for (const row of r) for (const it of s) {
      const score = similarity(row.email_name || row.name, it.title);
      if (!best || score > best.score) best = { row, it, score };
    }
    if (!best || best.score === 0) break;
    pairs.push(best);
    r.splice(r.indexOf(best.row), 1);
    s.splice(s.indexOf(best.it), 1);
  }
  r.forEach((row, i) => { if (s[i]) pairs.push({ row, it: s[i], score: 0, positional: true }); });
  return pairs;
}

function enrich(db, row, it, { orderUrl, today, positional }) {
  const fields = {};
  if (row.name_source !== 'you' && row.name !== it.title) {
    fields.name = it.title;
    // Keep what emails call it, for matching later emails — unless we had to
    // guess which category is which, in which case don't trust the label.
    fields.email_name = positional ? null : row.email_name ?? row.name;
    fields.name_source = 'amazon_site';
  }
  if (it.priceCents != null && (row.unit_price_cents == null || TOTAL_NOTE_RE.test(row.notes ?? ''))) fields.unit_price_cents = it.priceCents;
  if (it.asin && !row.retailer_item_id) fields.retailer_item_id = it.asin;
  if (it.seller && !row.seller) fields.seller = it.seller;
  let notes = (row.notes ?? '').replace(CATEGORY_NOTE_RE, '');
  if (fields.unit_price_cents != null) notes = notes.replace(TOTAL_NOTE_RE, '');
  if (positional && fields.name) notes = `${notes} Several items in this order had only category names; if two names look swapped, use Rename.`;
  notes = notes.trim() || null;
  if (notes !== (row.notes ?? null)) fields.notes = notes;
  if (it.deliveredDate && !row.delivered_date) fields.delivered_date = it.deliveredDate;
  if (Object.keys(fields).length) {
    db.prepare(`UPDATE items SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id: row.id });
    addEvent(db, row.id, { kind: 'amazon_site', occurredAt: today, source: 'system', detail: 'Details filled in from your Amazon order page' });
  }
  if (it.deliveredDate && stageRank(row.stage) < stageRank('delivered')) {
    db.prepare("UPDATE items SET stage = 'delivered' WHERE id = ?").run(row.id);
    addEvent(db, row.id, { kind: 'stage:delivered', occurredAt: it.deliveredDate, source: 'system', detail: 'Delivered (from your Amazon order page)' });
  }
  if (it.returnBy) {
    const current = getItem(db, row.id);
    const existing = current.policy_json ? JSON.parse(current.policy_json) : {};
    if (existing?.fixedReturnBy !== it.returnBy) {
      applyPolicyResult(db, row.id, {
        // Amazon's own date for this exact item; keeps AI-found extras like drop-off days and refund timing.
        policy: { ...(existing ?? {}), eligible: true, fixedReturnBy: it.returnBy, fixedReturnBasis: `Your Amazon order page says this item can be returned through ${it.returnBy}.`, confidence: 'confirmed' },
        explanation: "Return date from your Amazon order page (Amazon's own date for this item).",
        sourceUrl: orderUrl,
        checkedAt: today,
      }, 'amazon_site');
    }
  } else if (fields.delivered_date) {
    recomputeDeadlines(db, row.id);
  }
  return !!fields.name;
}

/** Merge amazon-orders results into the database. Returns counts for the sync summary. */
export function applyAmazonOrders(db, orders, { today = todayISO() } = {}) {
  const summary = { orders: 0, named: 0, created: 0, returnDates: 0 };
  db.transaction(() => {
    for (const o of orders ?? []) {
      if (!o.order_number || o.cancelled) continue;
      summary.orders++;
      const orderDate = isoDate(o.order_placed_date);
      db.prepare(`INSERT INTO orders (retailer, order_number, order_date, order_total_cents, payment_method, is_sample) VALUES ('amazon', ?, ?, ?, ?, 0)
                  ON CONFLICT (retailer, order_number) DO UPDATE SET order_date = COALESCE(orders.order_date, excluded.order_date),
                    order_total_cents = COALESCE(excluded.order_total_cents, orders.order_total_cents),
                    payment_method = COALESCE(orders.payment_method, excluded.payment_method)`)
        .run(o.order_number, orderDate, cents(o.grand_total), o.payment_method ?? null);
      const order = db.prepare("SELECT * FROM orders WHERE retailer = 'amazon' AND order_number = ?").get(o.order_number);
      const orderUrl = o.order_details_link ? new URL(o.order_details_link, 'https://www.amazon.com').toString() : null;
      const site = siteItemsOf(o);
      const rows = db.prepare('SELECT * FROM items WHERE order_id = ? AND is_sample = 0 ORDER BY id').all(order.id);
      const returnDatesBefore = rows.filter((r) => r.policy_origin === 'amazon_site').length;

      // 1) Same product already known (by Amazon item id or name)
      const leftoverSite = [];
      const usedRows = new Set();
      for (const it of site) {
        const candidates = rows.filter((r) => !usedRows.has(r.id)).map((r) => ({ ...r, name: r.name }));
        const byAsin = it.asin && candidates.find((r) => r.retailer_item_id === it.asin);
        const m = byAsin ? { match: byAsin } : matchItem(candidates, { name: it.title });
        if (m.match) {
          usedRows.add(m.match.id);
          // split rows (partial returns) share a product: enrich all of them
          for (const r of rows.filter((x) => x.id === m.match.id || x.split_from_item_id === m.match.id)) enrich(db, r, it, { orderUrl, today });
        } else leftoverSite.push(it);
      }
      // 2) Rows that only had category names
      const leftoverRows = rows.filter((r) => !usedRows.has(r.id) && !r.split_from_item_id && r.name_source !== 'amazon_site');
      const pairs = pairLeftovers(leftoverRows, leftoverSite);
      const guessing = pairs.some((p) => p.positional) && leftoverRows.length > 1;
      const returnInProgress = leftoverRows.some((r) => stageRank(r.stage) >= stageRank('need_to_return'));
      if (guessing && returnInProgress) {
        // Don't guess names for items with a return/refund in progress: list the options instead.
        const names = leftoverSite.map((it) => it.title).join('; ');
        for (const row of leftoverRows) {
          const note = `Your Amazon order page lists: ${names}. Use Rename to pick the right one.`;
          if (!(row.notes ?? '').includes(note)) db.prepare('UPDATE items SET notes = ? WHERE id = ?').run(`${(row.notes ?? '').replace(CATEGORY_NOTE_RE, '')} ${note}`.trim(), row.id);
        }
        leftoverSite.length = 0;
      } else {
        for (const p of pairs) {
          if (enrich(db, p.row, p.it, { orderUrl, today, positional: guessing && p.positional })) summary.named++;
          leftoverSite.splice(leftoverSite.indexOf(p.it), 1);
        }
      }
      // 3) Nothing in email for these: create them
      if (!rows.length) {
        for (const it of leftoverSite) {
          const id = db.prepare(`INSERT INTO items (order_id, name, retailer_item_id, seller, quantity, unit_price_cents, name_source, stage, delivered_date, is_sample)
                                 VALUES (?, ?, ?, ?, ?, ?, 'amazon_site', ?, ?, 0)`)
            .run(order.id, it.title, it.asin, it.seller, it.quantity, it.priceCents, it.deliveredDate ? 'delivered' : 'purchased', it.deliveredDate).lastInsertRowid;
          addEvent(db, id, { kind: 'stage:purchased', occurredAt: orderDate, source: 'system', detail: 'Order found on your Amazon order page' });
          if (it.deliveredDate) addEvent(db, id, { kind: 'stage:delivered', occurredAt: it.deliveredDate, source: 'system', detail: 'Delivered (from your Amazon order page)' });
          enrich(db, getItem(db, id), { ...it, title: it.title }, { orderUrl, today });
          summary.created++;
        }
      }
      const after = db.prepare("SELECT COUNT(*) n FROM items WHERE order_id = ? AND policy_origin = 'amazon_site'").get(order.id).n;
      summary.returnDates += Math.max(0, after - returnDatesBefore);
    }
  })();
  return summary;
}

// ---------- run + remember the outcome ----------

const LAST_KEY = 'amazon_site_last';
export function lastAmazonSiteRun(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LAST_KEY);
  return row ? JSON.parse(row.value) : null;
}
function saveRun(db, run) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(LAST_KEY, JSON.stringify(run));
}

/** Amazon orders where every item already has a real (not grand-total) price: no need to load their detail pages again. */
export function ordersWithPrices(db) {
  return db.prepare(`SELECT o.order_number FROM orders o JOIN items i ON i.order_id = o.id
                     WHERE o.retailer = 'amazon' AND o.is_sample = 0
                     GROUP BY o.id
                     HAVING SUM(CASE WHEN i.unit_price_cents IS NULL OR IFNULL(i.notes, '') LIKE '%grand total%' THEN 1 ELSE 0 END) = 0`)
    .all().map((r) => r.order_number);
}

/** Fetch + merge. First run looks back 3 months; later runs the last 30 days. */
export async function syncAmazonSite(db, { config = amazonSiteConfig(), runner = runBridge, today = todayISO() } = {}) {
  if (!config.available) return { ok: false, error: 'not_installed' };
  const first = !lastAmazonSiteRun(db)?.everSucceeded;
  const res = await runner({ python: config.python, script: config.script, timeFilter: first ? 'months-3' : 'last30', skipDetails: ordersWithPrices(db) });
  const at = new Date().toISOString();
  if (!res.ok) {
    saveRun(db, { ...(lastAmazonSiteRun(db) ?? {}), at, ok: false, error: res.error, detail: res.detail ?? null });
    return res;
  }
  const summary = applyAmazonOrders(db, res.orders, { today });
  saveRun(db, { at, ok: true, everSucceeded: true, summary });
  return { ok: true, ...summary };
}
