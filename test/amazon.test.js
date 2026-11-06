import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isFromAmazon, parseAmazonEmail, parseMonthDay, parseRefundTiming } from '../src/retailers/amazon.js';
import { decodeMessage } from '../src/gmail/client.js';
import { gmailMessage, orderHtml } from './helpers/gmail.js';

const parse = (o) => parseAmazonEmail(decodeMessage(gmailMessage(o)));

test('classifies Amazon subjects and ignores marketing', () => {
  assert.equal(classify('Ordered: "Anker 735 Charger..." and 1 more item'), 'order_confirmation');
  assert.equal(classify('Your Amazon.com order #113-1234567-7654321'), 'order_confirmation');
  assert.equal(classify('Shipped: "Anker 735 Charger..."'), 'shipped');
  assert.equal(classify('Your Amazon.com order #113-1234567-7654321 has shipped'), 'shipped');
  assert.equal(classify('Delivered: "Anker 735 Charger..."'), 'delivered');
  assert.equal(classify('Your return request for "Socks"'), 'return_started');
  assert.equal(classify('Your drop off receipt'), 'dropped_off');
  assert.equal(classify('We received your return'), 'return_received');
  assert.equal(classify('Your refund for Merino Wool Socks'), 'refund_issued');
  assert.equal(classify('Out for delivery: "Anker..."'), null);
  assert.equal(classify('Your Amazon.com order has been canceled'), null);
  assert.equal(classify('Deals picked for you'), null);
  assert.equal(classify('Your return window closes soon'), null);
});

test('only trusts real amazon.com senders', () => {
  assert.ok(isFromAmazon('Amazon.com <auto-confirm@amazon.com>'));
  assert.ok(isFromAmazon('"Amazon" <return@email.amazon.com>'));
  assert.ok(!isFromAmazon('Amazon <auto-confirm@amazon.com.evil.example>'));
  assert.ok(!isFromAmazon('amazon.com support <help@notamazon.co>'));
  assert.equal(parse({ id: 'x', subject: 'Ordered: "Charger"', html: orderHtml, from: 'Amazon <a@amaz0n-security.com>' }), null);
});

test('order confirmation: items, quantities, prices, seller, payment, delivery estimate', () => {
  const p = parse({ id: 'm1', subject: 'Ordered: "Anker 735 Charger (Nano II 65W)..." and 1 more item', html: orderHtml, date: '2026-10-01T15:00:00' });
  assert.equal(p.kind, 'order_confirmation');
  assert.equal(p.orderNumber, '113-1234567-7654321');
  assert.equal(p.orderDate, '2026-10-01');
  assert.equal(p.paymentMethod, 'Visa ••4242');
  assert.equal(p.estimatedDeliveryDate, '2026-10-08');
  assert.deepEqual(p.items, [
    { name: 'Anker 735 Charger (Nano II 65W), 3-Port Fast Compact Foldable USB C Charger', quantity: 1, unitPriceCents: 3999, seller: 'Anker Direct' },
    { name: 'Merino Wool Socks 3-Pack', quantity: 2, unitPriceCents: 1200, seller: null },
  ]);
  assert.deepEqual(p.warnings, []);
});

test('falls back to the subject item and warns when items are missing', () => {
  const p = parse({ id: 'm2', subject: 'Ordered: "Desk Lamp..." and 2 more items', html: '<p>Order #113-0000000-0000001</p><p>View your order</p>' });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].name, 'Desk Lamp');
  assert.ok(p.warnings.some((w) => /mentions 3 items/.test(w)));
  assert.ok(!p.warnings.some((w) => /prices/.test(w)), 'missing prices are normal now, not a warning');
});

test('return started: drop-off date, QR link only from amazon.com, partial quantity', () => {
  const html = `<p>Your return request for order #113-1234567-7654321</p>
    <p>Merino Wool Socks 3-Pack</p><p>Quantity: 1</p>
    <p>Drop off your item by Friday, October 23</p>
    <p>Bring the item and QR code to any UPS Store. No box or label needed.</p>
    <p>Estimated refund: $12.00</p>
    <a href="https://evil.example/qr">Show QR code</a>
    <a href="https://www.amazon.com/spr/returns/qr?id=1">View QR code</a>`;
  const p = parse({ id: 'm3', subject: 'Your return request for "Merino Wool Socks 3-Pack"', html, date: '2026-10-12T10:00:00' });
  assert.equal(p.kind, 'return_started');
  assert.equal(p.dropoffBy, '2026-10-23');
  assert.equal(p.qrUrl, 'https://www.amazon.com/spr/returns/qr?id=1');
  assert.equal(p.labelUrl, null);
  assert.match(p.instructions, /UPS Store/);
  assert.deepEqual(p.items, [{ name: 'Merino Wool Socks 3-Pack', quantity: 1, unitPriceCents: null, seller: null, refundCents: 1200 }]);
});

test('refund: amount, destination, and stated timing', () => {
  const html = `<p>Order #113-1234567-7654321</p><p>Your refund of $12.00 has been issued to your Visa ending in 4242.</p>
    <p>It may take 3-5 business days for the refund to appear on your statement.</p>`;
  const p = parse({ id: 'm4', subject: 'Your refund for Merino Wool Socks 3-Pack', html, date: '2026-10-28T10:00:00' });
  assert.equal(p.kind, 'refund_issued');
  assert.equal(p.refundCents, 1200);
  assert.equal(p.refundDestination, 'Visa ••4242');
  assert.deepEqual(p.refundTiming, { minDays: 3, maxDays: 5, unit: 'business', unitAssumed: false, startEvent: 'refund_issued' });
});

test('refund timing without a unit is assumed business days and flagged', () => {
  assert.equal(parseRefundTiming('Refunds usually appear within 2 to 10 days.').unitAssumed, true);
  assert.equal(parseRefundTiming('Arrives in 3-5 days. Free shipping.'), null); // not about refunds
});

test('refund with no readable amount warns instead of guessing', () => {
  const p = parse({ id: 'm5', subject: 'Your refund is on the way', html: '<p>Order #113-1234567-7654321</p><p>We processed your refund.</p>' });
  assert.equal(p.refundCents, undefined);
  assert.ok(p.warnings.some((w) => /refund amount/.test(w)));
});

test('dates without a year roll into next year near New Year', () => {
  assert.equal(parseMonthDay('Friday, January 8', '2026-12-28'), '2027-01-08');
  assert.equal(parseMonthDay('Nov 20, 2026', '2026-11-01'), '2026-11-20');
  assert.equal(parseMonthDay('tomorrow', '2026-11-01'), null);
});

test('decodes HTML entities and plain-text-only emails', () => {
  const p = parse({ id: 'm6', subject: 'Ordered: "Mug"', text: 'Order #113-2222222-3333333\nCoffee Mug &amp; Saucer\nQuantity: 1\n$9.50' });
  assert.equal(p.items[0].name, 'Coffee Mug &amp; Saucer'); // plain text is NOT HTML-decoded
  const h = parse({ id: 'm7', subject: 'Ordered: "Mug"', html: '<p>Order #113-2222222-3333333</p><p>Coffee Mug &amp; Saucer</p><p>Quantity: 1</p><p>$9.50</p>' });
  assert.equal(h.items[0].name, 'Coffee Mug & Saucer');
});
