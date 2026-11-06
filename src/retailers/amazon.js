// Amazon email parser: decoded Gmail message -> "parsed email" (see
// services/ingest.js) or null if it isn't an order/return/refund email.
//
// IMPORTANT: Amazon doesn't publish its email formats and changes them.
// This parser looks for the common patterns (order numbers, "Quantity:",
// dollar amounts, "Ordered:/Shipped:/Delivered:" subjects). When it can't
// read something confidently it adds a warning, which puts the email in
// "Emails that need a look" instead of guessing.
//
// Email text is untrusted data. We only extract values with fixed patterns;
// nothing in an email can change what the app does.

import { addDays } from '../lib/dates.js';

const ORDER_RE = /\b(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})\b/;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const toCents = (s) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);

/** Only trust mail that really comes from an amazon.com address. */
export function isFromAmazon(from) {
  const m = String(from).match(/<([^>]+)>/);
  const addr = (m ? m[1] : String(from)).trim().toLowerCase();
  return /@(?:[a-z0-9-]+\.)*amazon\.com$/.test(addr);
}

export function classify(subject) {
  const s = subject.toLowerCase();
  if (/cancel|out for delivery|delay|review|rate your|recommend|deal|sale|prime day|your account|password|sign-in|verify/.test(s)) return null;
  if (/\bsent you\b|\bshared\b|^fwd?:/.test(s)) return null; // someone else's order/return shared with you
  if (/return window|eligible for return|still time to return/.test(s)) return null;
  if (/refund/.test(s)) return 'refund_issued';
  if (/drop[- ]?off|dropped off/.test(s) && /receipt|received|confirm|complete/.test(s)) return 'dropped_off';
  if (/received your return|return (?:was |has been )?received|return.*(?:arrived|processed)/.test(s)) return 'return_received';
  if (/return/.test(s)) return 'return_started';
  if (/^delivered\b|was delivered|been delivered|delivered today/.test(s)) return 'delivered';
  if (/^shipped\b|has shipped|shipped:|is on the way|on its way/.test(s)) return 'shipped';
  if (/^ordered\b|your amazon\.com order|order confirmation|thanks for your order/.test(s)) return 'order_confirmation';
  return null;
}

/** "November 12", "Nov 12, 2026", "Thursday, November 12" -> YYYY-MM-DD (year inferred near refDate) */
export function parseMonthDay(str, refDate) {
  const m = String(str).match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : Number(refDate.slice(0, 4));
  const iso = (y) => `${y}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // No year given and the date looks > ~2 months in the past: it's next year (e.g. Dec email, "Jan 3").
  if (!m[3] && iso(year) < addDays(refDate, -60)) year += 1;
  return iso(year);
}

function subjectItem(subject) {
  const q = subject.match(/["“]([^"”]+)["”]/);
  const more = subject.match(/and (\d+) more items?/i);
  return { name: q ? q[1].replace(/\.{3}|…$/, '').trim() : null, more: more ? Number(more[1]) : 0 };
}

const LABEL_RE = /^(order (?:total|#|number|placed|date)|order details|subtotal|item\(s\) subtotal|total|grand total|shipping|tax|estimated|arriving|delivered|ship(?:ped)? to|view|track|condition|return|refund|payment|qty|quantity|price|your orders|amazon|hello|hi |thank|sold by|seller|\$)/i;

/** Find item lines: a product name near a "Quantity: N" line, with price/seller nearby. */
export function parseItems(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const q = lines[i].match(/^(?:quantity|qty)\s*:?\s*(\d+)\b/i);
    if (!q) continue;
    let name = null;
    let price = null;
    let seller = null;
    let itemNumber = null;
    const look = (l) => {
      const num = l.match(/^(?:item|sku|model)\s*(?:#|no\.?|number)\s*:?\s*([A-Z0-9-]{3,})$/i);
      if (num) { itemNumber ??= num[1]; return true; }
      const sold = l.match(/^sold by\s*:?\s*(.+)$/i);
      if (sold) { seller ??= sold[1].trim(); return true; }
      const money = l.match(/^\$\s?\d/) && l.match(MONEY_RE);
      if (money) { price ??= toCents(money[1]); return true; }
      return false;
    };
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (look(lines[j])) continue;
      if (LABEL_RE.test(lines[j]) || lines[j].length < 4) continue;
      name = lines[j];
      break;
    }
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
      if (/^(?:quantity|qty)\b/i.test(lines[j])) break;
      look(lines[j]);
    }
    if (name) items.push({ name: name.replace(/\.{3}$|…$/, '').trim(), quantity: Number(q[1]), unitPriceCents: price, seller, ...(itemNumber ? { retailerItemId: itemNumber } : {}) });
  }
  return items;
}

export function paymentMethod(text) {
  const card = text.match(/\b(Visa|Mastercard|MasterCard|American Express|Amex|Discover)\b[^\d\n]{0,25}(\d{4})\b/);
  if (card) return `${card[1].replace('MasterCard', 'Mastercard').replace('American Express', 'Amex')} ••${card[2]}`;
  const other = text.match(/\b(gift card balance|Amazon gift card|original payment method|Amazon Pay balance)\b/i);
  return other ? other[1] : null;
}

/** "3-5 business days" stated near the word refund. Unit unstated -> assume business (later date) and say so. */
export function parseRefundTiming(text) {
  const re = /(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(business|calendar)?\s*days/gi;
  let m;
  while ((m = re.exec(text))) {
    const near = text.slice(Math.max(0, m.index - 160), m.index + 160).toLowerCase();
    if (!/refund|credit|appear|post|statement/.test(near)) continue;
    return {
      minDays: Number(m[1]), maxDays: Number(m[2]),
      unit: m[3] ? m[3].toLowerCase() : 'business',
      unitAssumed: !m[3],
      startEvent: 'refund_issued',
    };
  }
  return null;
}

function safeLinks(links, re) {
  // Only https links on amazon.com (Amazon routes label/QR links through its
  // own domain). Anything else could be a spoofed email trying to send you elsewhere.
  return links.find((l) => {
    try {
      const u = new URL(l.href);
      return u.protocol === 'https:' && /(^|\.)amazon\.com$/.test(u.hostname) && re.test(`${l.text} ${u.pathname}`);
    } catch {
      return false;
    }
  })?.href ?? null;
}

export function instructions(lines) {
  const picked = lines.filter((l) => /\b(drop[- ]?off|bring|print|pack|tape|qr code|no box|label|ups|whole foods|kohl|locker)\b/i.test(l) && l.length > 25 && l.length < 220);
  return picked.length ? picked.slice(0, 3).join(' ').slice(0, 400) : null;
}

// Bump this whenever the parser improves: emails skipped by an older version
// are automatically re-checked on the next sync.
export const PARSER_VERSION = 2;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ORDER_LINE_RE = /order\s*(?:#|number|no\.?)\s*:?\s*(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})/i;

/** "today 5 PM – 8 PM", "overnight 3 AM", "tomorrow", "Friday", "Friday, November 7" -> YYYY-MM-DD */
export function parseArriving(str, refDate) {
  const s = String(str).toLowerCase();
  if (/\btoday\b/.test(s)) return refDate;
  if (/\b(tomorrow|overnight)\b/.test(s)) return addDays(refDate, 1);
  const exact = parseMonthDay(str, refDate);
  if (exact) return exact;
  const wd = WEEKDAYS.findIndex((d) => s.includes(d));
  if (wd >= 0) {
    const cur = new Date(`${refDate}T00:00:00Z`).getUTCDay();
    return addDays(refDate, (wd - cur + 7) % 7);
  }
  return null;
}

/** Amazon's newer emails list categories instead of product names: "2 items: 1 Household Supplies, 1 Home Fragrance" or "1 Storage & Organization item". */
export function parseCategoryItems(lines) {
  for (const l of lines) {
    let m = l.match(/^(\d+)\s+items?\s*:\s*(.+)$/i);
    if (m) {
      return m[2].split(/,\s*/).map((part) => {
        const q = part.trim().match(/^(\d+)\s+(.+?)(?:\s+items?)?$/i);
        return q ? { name: q[2].trim(), quantity: Number(q[1]) } : { name: part.trim(), quantity: 1 };
      }).filter((x) => x.name && !/^(and\s+)?\d+\s+more/i.test(x.name));
    }
    m = l.match(/^(\d+)\s+(.+?)\s+items?$/i);
    if (m && !/^more\b/i.test(m[2])) return [{ name: m[2].trim(), quantity: Number(m[1]) }];
  }
  return [];
}

/** Split an email into one block of lines per order number (some emails hold several orders). */
export function orderBlocks(lines) {
  const marks = [];
  const seen = new Set();
  lines.forEach((l, i) => {
    const m = l.match(ORDER_LINE_RE);
    if (m && !seen.has(m[1])) { seen.add(m[1]); marks.push({ i, orderNumber: m[1] }); }
  });
  if (!marks.length) return [];
  const blocks = [];
  let start = 0;
  marks.forEach((mk, k) => {
    const limit = marks[k + 1]?.i ?? lines.length;
    let end = mk.i;
    for (let j = mk.i + 1; j < limit; j++) {
      if (/^(grand|order)\s+total\b/i.test(lines[j])) {
        end = !MONEY_RE.test(lines[j]) && j + 1 < limit && /^\$\s?\d/.test(lines[j + 1]) ? j + 1 : j;
        break;
      }
    }
    if (k === marks.length - 1 && end === mk.i) end = lines.length - 1; // single/last order without a total: keep the rest
    blocks.push({ orderNumber: mk.orderNumber, lines: lines.slice(start, end + 1) });
    start = end + 1;
  });
  return blocks;
}

function totalOf(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!/^(grand|order)\s+total\b/i.test(lines[i])) continue;
    const m = lines[i].match(MONEY_RE) || (lines[i + 1] ?? '').match(MONEY_RE);
    if (m) return toCents(m[1]);
  }
  return null;
}

const CATEGORY_NOTE = "Amazon's email only gave the category, not the product name. Use Rename to give it a name you'll recognize.";
const TOTAL_NOTE = "Price is the order's grand total (includes tax and shipping), since the email didn't list item prices.";

/** Items, delivery estimate and total for one order's lines. */
function readOrder(lines, { kind, subject, date }) {
  let items = parseItems(lines);
  if (!items.length) {
    items = parseCategoryItems(lines).map((it) => ({ ...it, unitPriceCents: null, seller: null, note: CATEGORY_NOTE, categoryName: true }));
  }
  const subj = subjectItem(subject);
  if (!items.length && subj.name) items = [{ name: subj.name, quantity: kind === 'order_confirmation' ? 1 : undefined }];
  const orderTotalCents = totalOf(lines);
  if (kind === 'order_confirmation' && items.length === 1 && (items[0].quantity ?? 1) === 1 && items[0].unitPriceCents == null && orderTotalCents != null) {
    items[0].unitPriceCents = orderTotalCents;
    items[0].note = [items[0].note, TOTAL_NOTE].filter(Boolean).join(' ');
  }
  const text = lines.join('\n');
  let estimatedDeliveryDate = null;
  const arr = text.match(/(?:arriving|estimated delivery|expected by|delivery estimate)\s*:?\s*([^\n]{3,40})/i);
  if (arr) estimatedDeliveryDate = parseArriving(arr[1], date);
  return { items, orderTotalCents, estimatedDeliveryDate };
}

/**
 * Decoded Gmail message -> array of parsed emails (one per order in the email),
 * or [] if it isn't an order/shipping/return/refund email from Amazon.
 */
export function parseAmazonEmails(msg) {
  if (!isFromAmazon(msg.from)) return [];
  const kind = classify(msg.subject);
  if (!kind) return [];

  const text = msg.text ?? '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let blocks = orderBlocks(lines);
  if (!blocks.length) {
    const orderNumber = (msg.subject.match(ORDER_RE) || text.match(ORDER_RE) || [])[1] ?? null;
    blocks = [{ orderNumber, lines }];
  }
  const multi = blocks.length > 1;

  const results = blocks.map((b) => {
    const warnings = [];
    const { items, orderTotalCents, estimatedDeliveryDate } = readOrder(b.lines, { kind, subject: msg.subject, date: msg.date });
    if (kind !== 'return_started') for (const it of items) if (kind !== 'order_confirmation') delete it.quantity;
    if (kind === 'order_confirmation' && !items.length) warnings.push('No items could be read from this order confirmation.');
    if (!b.orderNumber) warnings.push('No Amazon order number found.');
    const blockText = b.lines.join('\n');

    const parsed = {
      provider: 'gmail',
      // Several orders in one email get their own IDs, so each is imported exactly once.
      messageId: multi ? `${msg.id}#${b.orderNumber}` : msg.id,
      threadId: msg.threadId,
      retailer: 'amazon',
      kind,
      subject: msg.subject,
      from: msg.from,
      receivedAt: msg.receivedAt,
      eventDate: msg.date,
      orderNumber: b.orderNumber,
      items,
      warnings,
      orderTotalCents,
    };
    if (kind === 'order_confirmation') {
      parsed.orderDate = msg.date;
      parsed.paymentMethod = paymentMethod(text);
    }
    if ((kind === 'shipped' || kind === 'order_confirmation') && estimatedDeliveryDate) parsed.estimatedDeliveryDate = estimatedDeliveryDate;
    if (kind === 'delivered') parsed.deliveredDate = msg.date;
    if (kind === 'return_started') {
      const by = blockText.match(/(?:drop[- ]?off|ship|send|return)[a-z ]{0,25}\bby\s*:?\s*([^\n]{3,40})/i);
      if (by) parsed.dropoffBy = parseMonthDay(by[1], msg.date);
      parsed.labelUrl = safeLinks(msg.links ?? [], /label/i);
      parsed.qrUrl = safeLinks(msg.links ?? [], /\bqr\b|qr[-_ ]?code/i);
      parsed.instructions = instructions(b.lines);
      const refund = blockText.match(/(?:refund|estimated refund)[^\n$]{0,30}\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/i);
      if (refund && items.length === 1) items[0].refundCents = toCents(refund[1]);
    }
    if (kind === 'refund_issued') {
      const amt = blockText.match(/(?:refund(?:ed)?|total refund|refund total|amount)[^\n$]{0,40}\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/i);
      if (amt) parsed.refundCents = toCents(amt[1]);
      else warnings.push('The refund amount could not be read from this email.');
      parsed.refundDestination = paymentMethod(text);
      parsed.refundTiming = parseRefundTiming(blockText);
    }
    return parsed;
  });

  // Cross-check the count in subjects like "Ordered 3 items: ..." or "... and 2 more items".
  const subjCount = msg.subject.match(/^ordered:?\s*(\d+)\s+items?\b/i);
  const subj = subjectItem(msg.subject);
  const expected = subjCount ? Number(subjCount[1]) : subj.more ? subj.more + 1 : null;
  const found = results.reduce((sum, r) => sum + r.items.reduce((s, it) => s + (it.quantity ?? 1), 0), 0);
  if (kind === 'order_confirmation' && expected && found < expected) {
    results[0].warnings.push(`The subject mentions ${expected} items but only ${found} could be read — please check this order.`);
  }
  return results;
}

/** Single-result helper (first order in the email), kept for simple callers and tests. */
export function parseAmazonEmail(msg) {
  return parseAmazonEmails(msg)[0] ?? null;
}
