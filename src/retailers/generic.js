// Parser for every store other than Amazon.
//
// 1. Best case: the email carries a schema.org order summary (JSON-LD) — the
//    machine-readable data many big retailers add so Gmail can show order
//    "highlights". That gives store, order number, items, prices, status.
// 2. Otherwise: general rules — subject wording, "Order #..." numbers,
//    "Quantity:" lines, dollar amounts.
// When neither gives an order number, the email is skipped (and listed in
// Settings → "Emails the app skipped") rather than guessed at.

import { parseItems, parseCategoryItems, parseMonthDay, parseRefundTiming, parseArriving, paymentMethod, instructions } from './amazon.js';

export const GENERIC_PARSER_VERSION = 1;

// Senders whose "orders" aren't returnable shopping (rides, food, money, subscriptions).
const NOT_SHOPPING = [
  'amazon.com', 'uber.com', 'lyft.com', 'doordash.com', 'grubhub.com', 'postmates.com', 'seamless.com', 'instacart.com',
  'caviar.com', 'gopuff.com', 'apple.com', 'google.com', 'spotify.com', 'netflix.com', 'hulu.com', 'disneyplus.com',
  'paypal.com', 'venmo.com', 'cash.app', 'square.com', 'squareup.com', 'stripe.com', 'zelle.com', 'chase.com',
  'bankofamerica.com', 'wellsfargo.com', 'capitalone.com', 'americanexpress.com', 'citi.com', 'discover.com',
  'airbnb.com', 'booking.com', 'expedia.com', 'opentable.com', 'ticketmaster.com', 'eventbrite.com',
];
const TWO_PART_TLDS = ['co.uk', 'com.au', 'co.jp', 'com.br', 'co.nz', 'com.mx', 'co.in'];
const ORDER_NUM_RE = /order\s*(?:#|number|no\.?|id)\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{4,30})\b/i;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/;
const toCents = (s) => Math.round(parseFloat(String(s).replace(/[,$\s]/g, '')) * 100);

export function baseDomain(host) {
  const parts = String(host).toLowerCase().split('.').filter(Boolean);
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_TLDS.includes(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function senderInfo(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const address = (m ? m[2] : String(from)).trim().toLowerCase();
  const domain = baseDomain(address.split('@')[1] ?? '');
  const cleaned = (m ? m[1] : '')
    .replace(/\b(orders?|order confirmation|customer (service|care)|no-?reply|notifications?|support|team|shipping|updates?)\b/gi, '')
    .replace(/[|•·-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fallback = domain.split('.')[0] ?? '';
  return { address, domain, name: cleaned || fallback.charAt(0).toUpperCase() + fallback.slice(1) };
}

export const isShoppingSender = (domain) => !!domain && !NOT_SHOPPING.some((d) => domain === d || domain.endsWith(`.${d}`));

export function classifyGeneric(subject) {
  const s = String(subject).toLowerCase();
  if (/\b\d+% off\b|\bsale\b|\bdeals?\b|\bcoupon|\bsave \$|newsletter|recommend|review|survey|rate your|your cart|wish ?list|back in stock|price drop|last chance|ends (today|tonight)|reward points|\bsent you\b|^fwd?:/.test(s)) return null;
  if (/return policy|return window/.test(s)) return null;
  if (/\brefund/.test(s)) return 'refund_issued';
  if (/drop[- ]?off|dropped off/.test(s) && /receipt|received|confirm/.test(s)) return 'dropped_off';
  if (/received your return|return (?:was |has been )?received|return.*(?:processed|arrived)/.test(s)) return 'return_received';
  if (/\breturn\b/.test(s)) return 'return_started';
  if (/\bdelivered\b|has arrived|was delivered/.test(s)) return 'delivered';
  if (/\bshipped\b|on (?:its|the) way|has been sent|out for delivery|shipment/.test(s)) return 'shipped';
  if (/order (?:confirmation|confirmed|received|placed|#)|thanks? (?:you )?for (?:your )?(?:order|purchase)|your (?:\w+ )?order|receipt for your|purchase confirmation/.test(s)) return 'order_confirmation';
  return null;
}

const STATUS_KIND = {
  OrderDelivered: 'delivered', OrderInTransit: 'shipped', OrderPickupAvailable: 'shipped',
  OrderProcessing: 'order_confirmation', OrderPaymentDue: 'order_confirmation', OrderReturned: 'return_received',
};
const typeIs = (node, t) => [].concat(node?.['@type'] ?? []).some((x) => String(x).endsWith(t));
const statusKind = (status) => STATUS_KIND[String(status ?? '').split('/').pop()] ?? null;
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

function offerItems(offers) {
  return [].concat(offers ?? []).map((o) => {
    const thing = o.itemOffered ?? o.item ?? o;
    const name = thing?.name ?? o.name;
    if (!name) return null;
    const qty = Number(o.eligibleQuantity?.value ?? o.orderQuantity ?? o.quantity ?? 1) || 1;
    const price = o.price ?? o.priceSpecification?.price;
    return { name: String(name).trim(), quantity: qty, unitPriceCents: price != null && !Number.isNaN(Number(String(price).replace(/[$,]/g, ''))) ? toCents(price) : null, seller: o.seller?.name ?? null };
  }).filter(Boolean);
}

/** Orders described by schema.org markup in the email. */
function structuredOrders(nodes) {
  const out = [];
  for (const n of nodes) {
    if (typeIs(n, 'Order') && n.orderNumber) {
      out.push({
        orderNumber: String(n.orderNumber), merchantName: n.merchant?.name ?? n.seller?.name ?? null, orderDate: isoDate(n.orderDate),
        items: offerItems(n.acceptedOffer ?? n.orderedItem), kind: statusKind(n.orderStatus),
        totalCents: n.price != null || n.totalPaymentDue?.price != null ? toCents(n.price ?? n.totalPaymentDue.price) : null,
        paymentMethod: n.paymentMethod?.name ?? null,
      });
    } else if (typeIs(n, 'ParcelDelivery') && n.partOfOrder?.orderNumber) {
      const delivered = /Delivered$/.test(String(n.deliveryStatus?.['@type'] ?? n.deliveryStatus ?? ''));
      out.push({
        orderNumber: String(n.partOfOrder.orderNumber), merchantName: n.partOfOrder.merchant?.name ?? null,
        items: [].concat(n.itemShipped ?? []).map((i) => (i?.name ? { name: String(i.name).trim() } : null)).filter(Boolean),
        kind: delivered ? 'delivered' : statusKind(n.partOfOrder.orderStatus) ?? 'shipped',
        estimatedDeliveryDate: isoDate(n.expectedArrivalUntil ?? n.expectedArrivalFrom),
      });
    }
  }
  return out;
}

function linkOnDomain(links, domain, re) {
  return links.find((l) => {
    try {
      const u = new URL(l.href);
      return u.protocol === 'https:' && baseDomain(u.hostname) === domain && re.test(`${l.text} ${u.pathname}`);
    } catch {
      return false;
    }
  })?.href ?? null;
}

/** Decoded Gmail message -> array of parsed emails (usually one), or [] to skip. */
export function parseGenericEmails(msg) {
  const sender = senderInfo(msg.from);
  if (!isShoppingSender(sender.domain)) return [];
  // Claims to be Amazon but isn't amazon.com: likely a scam. Real Amazon mail is handled by the Amazon parser.
  if (/amazon/i.test(`${sender.address} ${msg.from}`)) return [];
  const text = msg.text ?? '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const subjectKind = classifyGeneric(msg.subject);
  const structured = structuredOrders(msg.structured ?? []);

  let orders;
  if (structured.length) {
    orders = structured.map((o) => ({ ...o, kind: o.kind ?? subjectKind ?? 'order_confirmation', fromMarkup: true }));
  } else {
    if (!subjectKind) return [];
    const orderNumber = (msg.subject.match(ORDER_NUM_RE) || text.match(ORDER_NUM_RE) || msg.subject.match(/#\s?([A-Z0-9][A-Z0-9-]{5,30})\b/i) || [])[1] ?? null;
    if (!orderNumber) return []; // can't tie it to an order: skip rather than guess
    let items = parseItems(lines);
    if (!items.length) items = parseCategoryItems(lines).map((it) => ({ ...it, categoryName: true }));
    orders = [{ orderNumber, items, kind: subjectKind, fromMarkup: false }];
  }

  const multi = orders.length > 1;
  return orders.map((o) => {
    const kind = o.kind;
    const warnings = [];
    const items = o.items.map((it) => ({ ...it }));
    if (kind !== 'order_confirmation' && kind !== 'return_started') for (const it of items) delete it.quantity;
    if (kind === 'order_confirmation' && !items.length) warnings.push('No items could be read from this order email.');
    const totalMatch = !multi && text.match(/(?:order|grand)\s+total\s*:?\s*\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/i);
    const parsed = {
      provider: 'gmail',
      orderTotalCents: o.totalCents ?? (totalMatch ? toCents(totalMatch[1]) : null),
      messageId: multi ? `${msg.id}#${o.orderNumber}` : msg.id,
      threadId: msg.threadId,
      retailer: sender.domain,
      merchantName: o.merchantName || sender.name,
      kind,
      subject: msg.subject,
      from: msg.from,
      receivedAt: msg.receivedAt,
      eventDate: msg.date,
      orderNumber: o.orderNumber,
      items,
      warnings,
    };
    if (kind === 'order_confirmation') {
      parsed.orderDate = o.orderDate ?? msg.date;
      parsed.paymentMethod = o.paymentMethod ?? paymentMethod(text);
    }
    if (kind === 'order_confirmation' || kind === 'shipped') {
      let est = o.estimatedDeliveryDate ?? null;
      if (!est) {
        const arr = text.match(/(?:arriving|estimated delivery|expected (?:delivery|by|to arrive)|delivery estimate|arrives?)\s*:?\s*([^\n]{3,40})/i);
        if (arr) est = parseArriving(arr[1], msg.date);
      }
      if (est) parsed.estimatedDeliveryDate = est;
    }
    if (kind === 'delivered') parsed.deliveredDate = msg.date;
    if (kind === 'return_started') {
      const by = text.match(/(?:drop[- ]?off|ship|send|return)[a-z ]{0,25}\bby\s*:?\s*([^\n]{3,40})/i);
      if (by) parsed.dropoffBy = parseMonthDay(by[1], msg.date);
      parsed.labelUrl = linkOnDomain(msg.links ?? [], sender.domain, /label/i);
      parsed.qrUrl = linkOnDomain(msg.links ?? [], sender.domain, /\bqr\b|qr[-_ ]?code/i);
      parsed.instructions = instructions(lines);
    }
    if (kind === 'refund_issued') {
      const amt = text.match(/(?:refund(?:ed)?|total refund|refund total|amount)[^\n$]{0,40}\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/i) || text.match(MONEY_RE);
      if (amt) parsed.refundCents = toCents(amt[1]);
      else warnings.push('The refund amount could not be read from this email.');
      parsed.refundDestination = paymentMethod(text);
      parsed.refundTiming = parseRefundTiming(text);
    }
    return parsed;
  });
}

