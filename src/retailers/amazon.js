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
  if (/return window|eligible for return|still time to return/.test(s)) return null;
  if (/refund/.test(s)) return 'refund_issued';
  if (/drop[- ]?off|dropped off/.test(s) && /receipt|received|confirm|complete/.test(s)) return 'dropped_off';
  if (/received your return|return (?:was |has been )?received|return.*(?:arrived|processed)/.test(s)) return 'return_received';
  if (/return/.test(s)) return 'return_started';
  if (/^delivered:|was delivered|been delivered|delivered today/.test(s)) return 'delivered';
  if (/^shipped:|has shipped|shipped:|is on the way|on its way/.test(s)) return 'shipped';
  if (/^ordered:|your amazon\.com order|order confirmation|thanks for your order/.test(s)) return 'order_confirmation';
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
    const look = (l) => {
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
    if (name) items.push({ name: name.replace(/\.{3}$|…$/, '').trim(), quantity: Number(q[1]), unitPriceCents: price, seller });
  }
  return items;
}

function paymentMethod(text) {
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

function instructions(lines) {
  const picked = lines.filter((l) => /\b(drop[- ]?off|bring|print|pack|tape|qr code|no box|label|ups|whole foods|kohl|locker)\b/i.test(l) && l.length > 25 && l.length < 220);
  return picked.length ? picked.slice(0, 3).join(' ').slice(0, 400) : null;
}

export function parseAmazonEmail(msg) {
  if (!isFromAmazon(msg.from)) return null;
  const kind = classify(msg.subject);
  if (!kind) return null;

  const text = msg.text ?? '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const orderNumber = (msg.subject.match(ORDER_RE) || text.match(ORDER_RE) || [])[1] ?? null;
  const warnings = [];

  let items = parseItems(lines);
  const subj = subjectItem(msg.subject);
  if (!items.length && subj.name) items = [{ name: subj.name, quantity: kind === 'order_confirmation' ? 1 : undefined }];
  if (subj.more && items.length < subj.more + 1) {
    warnings.push(`The subject mentions ${subj.more + 1} items but only ${items.length} could be read — please check this order.`);
  }
  if (kind === 'order_confirmation' && !items.length) warnings.push('No items could be read from this order confirmation.');
  if (kind === 'order_confirmation' && items.some((i) => i.unitPriceCents == null)) warnings.push('Some item prices could not be read.');
  if (kind !== 'order_confirmation') {
    // Quantity in non-order emails only matters for returns (partial returns).
    for (const it of items) if (kind !== 'return_started') delete it.quantity;
  }

  const parsed = {
    provider: 'gmail',
    messageId: msg.id,
    threadId: msg.threadId,
    retailer: 'amazon',
    kind,
    subject: msg.subject,
    from: msg.from,
    receivedAt: msg.receivedAt,
    eventDate: msg.date,
    orderNumber,
    items,
    warnings,
  };
  if (kind === 'order_confirmation') {
    parsed.orderDate = msg.date;
    parsed.paymentMethod = paymentMethod(text);
  }
  if (kind === 'shipped' || kind === 'order_confirmation') {
    const arr = text.match(/(?:arriving|estimated delivery|expected by|delivery estimate)\s*:?\s*([^\n]{3,40})/i);
    if (arr) {
      if (/tomorrow/i.test(arr[1])) parsed.estimatedDeliveryDate = addDays(msg.date, 1);
      else if (/today/i.test(arr[1])) parsed.estimatedDeliveryDate = msg.date;
      else parsed.estimatedDeliveryDate = parseMonthDay(arr[1], msg.date);
    }
  }
  if (kind === 'delivered') parsed.deliveredDate = msg.date;
  if (kind === 'return_started') {
    const by = text.match(/(?:drop[- ]?off|ship|send|return)[a-z ]{0,25}\bby\s*:?\s*([^\n]{3,40})/i);
    if (by) parsed.dropoffBy = parseMonthDay(by[1], msg.date);
    parsed.labelUrl = safeLinks(msg.links ?? [], /label/i);
    parsed.qrUrl = safeLinks(msg.links ?? [], /\bqr\b|qr[-_ ]?code/i);
    parsed.instructions = instructions(lines);
    const refund = text.match(/(?:refund|estimated refund)[^\n$]{0,30}\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/i);
    if (refund && items.length === 1) items[0].refundCents = toCents(refund[1]);
  }
  if (kind === 'refund_issued') {
    const amt = text.match(/(?:refund(?:ed)?|total refund|refund total|amount)[^\n$]{0,40}\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/i);
    if (amt) parsed.refundCents = toCents(amt[1]);
    else warnings.push('The refund amount could not be read from this email.');
    parsed.refundDestination = paymentMethod(text);
    parsed.refundTiming = parseRefundTiming(text);
  }
  if (!orderNumber) warnings.push('No Amazon order number found.');
  return parsed;
}
