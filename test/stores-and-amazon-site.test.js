// Other stores (generic parser) and the optional Amazon order-page helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseGenericEmails, senderInfo, classifyGeneric, baseDomain } from '../src/retailers/generic.js';
import { decodeMessage } from '../src/gmail/client.js';
import { policySourceFor } from '../src/ai/policyReview.js';
import { openDb } from '../src/db.js';
import { saveAccount } from '../src/gmail/account.js';
import { syncGmail } from '../src/services/sync.js';
import { ingestParsedEmail } from '../src/services/ingest.js';
import { renameItem, getItem } from '../src/services/items.js';
import { applyAmazonOrders, runBridge, syncAmazonSite, lastAmazonSiteRun, ordersWithPrices } from '../src/integrations/amazonSite.js';
import { computeReminders } from '../src/services/reminders.js';
import { updateSettings } from '../src/settings.js';
import { gmailMessage, fakeGmail, twoOrderHtml } from './helpers/gmail.js';

const parse = (o) => parseGenericEmails(decodeMessage(gmailMessage(o)));

const jsonLdOrder = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'http://schema.org', '@type': 'Order', merchant: { '@type': 'Organization', name: 'Target' },
  orderNumber: '912003456789', orderDate: '2026-11-02T10:00:00-05:00', orderStatus: 'http://schema.org/OrderProcessing',
  acceptedOffer: [
    { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Threshold Bath Towel, Gray' }, price: '12.00', priceCurrency: 'USD', eligibleQuantity: { '@type': 'QuantitativeValue', value: 2 } },
    { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Room Essentials Shower Curtain' }, price: '15.99', priceCurrency: 'USD' },
  ],
})}</script></head><body><p>Thanks for your order!</p></body></html>`;

test('store identity from the sender', () => {
  assert.deepEqual(senderInfo('Target <orders@oe.target.com>'), { address: 'orders@oe.target.com', domain: 'target.com', name: 'Target' });
  assert.equal(senderInfo('"Best Buy Orders" <BestBuyInfo@emailinfo.bestbuy.com>').name, 'Best Buy');
  assert.equal(senderInfo('noreply@shop.example.co.uk').domain, 'example.co.uk');
  assert.equal(baseDomain('mail.walmart.com'), 'walmart.com');
});

test('generic subjects', () => {
  assert.equal(classifyGeneric('Thanks for your order, Eric!'), 'order_confirmation');
  assert.equal(classifyGeneric('Your order has shipped'), 'shipped');
  assert.equal(classifyGeneric('Your package was delivered'), 'delivered');
  assert.equal(classifyGeneric('Your refund is on its way'), 'refund_issued');
  assert.equal(classifyGeneric('20% off everything this weekend'), null);
  assert.equal(classifyGeneric('Items in your cart are selling fast'), null);
});

test('schema.org order markup gives store, items, prices and quantities', () => {
  const [p] = parse({ id: 't1', subject: 'Thanks for your order!', html: jsonLdOrder, from: 'Target <orders@oe.target.com>', date: '2026-11-02T10:00:00' });
  assert.equal(p.retailer, 'target.com');
  assert.equal(p.merchantName, 'Target');
  assert.equal(p.orderNumber, '912003456789');
  assert.equal(p.kind, 'order_confirmation');
  assert.equal(p.orderDate, '2026-11-02');
  assert.deepEqual(p.items.map((i) => [i.name, i.quantity, i.unitPriceCents]), [['Threshold Bath Towel, Gray', 2, 1200], ['Room Essentials Shower Curtain', 1, 1599]]);
});

test('without markup: general rules, and skip when there is no order number', () => {
  const [p] = parse({ id: 'g1', subject: 'Order confirmation #A1B2C3D4', from: 'Allbirds <hello@allbirds.com>',
    text: 'Thanks for your purchase\nWool Runners - Natural White\nQuantity: 1\n$98.00\nEstimated delivery: November 12' , date: '2026-11-05T09:00:00' });
  assert.equal(p.retailer, 'allbirds.com');
  assert.equal(p.orderNumber, 'A1B2C3D4');
  assert.deepEqual(p.items.map((i) => [i.name, i.quantity, i.unitPriceCents]), [['Wool Runners - Natural White', 1, 9800]]);
  assert.equal(p.estimatedDeliveryDate, '2026-11-12');
  assert.deepEqual(parse({ id: 'g2', subject: 'Thanks for your order', from: 'Shop <hi@shop.com>', text: 'We got it!' }), []);
});

test('rides, food delivery and payment receipts are not shopping', () => {
  assert.deepEqual(parse({ id: 'u1', subject: 'Your order receipt #ABC12345', from: 'Uber Eats <uber@uber.com>', text: 'Order #ABC12345 $23.10' }), []);
  assert.deepEqual(parse({ id: 'p1', subject: 'Receipt for your purchase #9988776', from: 'PayPal <service@paypal.com>', text: 'Order #9988776' }), []);
});

test('policy source for other stores is their own site', () => {
  assert.deepEqual(policySourceFor('target.com', 'Target').domains, ['target.com']);
  assert.equal(policySourceFor('amazon').name, 'Amazon');
  assert.equal(policySourceFor('not a domain'), null);
});

test('sync imports other stores with their names; stopped stores are skipped', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const gmail = fakeGmail([gmailMessage({ id: 't1', subject: 'Thanks for your order!', html: jsonLdOrder, from: 'Target <orders@oe.target.com>' })]);
  await syncGmail(db, { client: gmail });
  assert.equal(db.prepare("SELECT merchant_name FROM orders WHERE retailer = 'target.com'").get().merchant_name, 'Target');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 2);

  db.prepare("INSERT INTO ignored_stores (domain, name) VALUES ('bestbuy.com', 'Best Buy')").run();
  gmail.add(gmailMessage({ id: 'b1', subject: 'Order confirmation #BBY01-123456', from: 'Best Buy <orders@emailinfo.bestbuy.com>', text: 'Order #BBY01-123456\nUSB Cable\nQuantity: 1\n$9.99' }));
  await syncGmail(db, { client: gmail });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE retailer = 'bestbuy.com'").get().n, 0);
  assert.match(db.prepare("SELECT reason FROM skipped_messages WHERE message_id = 'b1' AND provider = 'gmail:other'").get().reason, /stop tracking/);
});

// ---------- Amazon order pages ----------

const siteOrders = [
  {
    order_number: '111-3646931-0001058', order_placed_date: '2026-11-05', grand_total: 25.46, order_details_link: '/gp/your-account/order-details?orderID=111-3646931-0001058',
    items: [
      { title: 'Yankee Candle Lavender Jar Candle', price: 9.99, quantity: 1, return_eligible_date: '2026-12-06', asin: 'B0CANDLE01' },
      { title: 'Bounty Paper Towels, 6 Double Rolls', price: 13.49, quantity: 1, return_eligible_date: '2026-12-06', seller: { name: 'Amazon.com' }, asin: 'B0TOWELS01' },
    ],
    shipments: [{ delivery_status: 'Delivered November 6', items: [{ title: 'Yankee Candle Lavender Jar Candle' }] }],
  },
  {
    order_number: '111-9999999-0000001', order_placed_date: '2026-10-20',
    items: [{ title: 'Kitchen Scale, Digital', price: 19.99, quantity: 1, seller: { name: 'GadgetCo' }, return_eligible_date: '2026-11-25' }],
    shipments: [{ delivery_status: 'Delivered October 23', items: [{ title: 'Kitchen Scale, Digital' }] }],
  },
];

async function emailFirst() {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  await syncGmail(db, { client: fakeGmail([gmailMessage({ id: 'r1', subject: 'Ordered 3 items: Storage & Organization, Household Supplies, and more', html: twoOrderHtml, date: '2026-11-05T07:51:00' })]) });
  return db;
}

test('fills real names, prices and Amazon return dates into category items; creates orders no email covered', async () => {
  const db = await emailFirst();
  const s = applyAmazonOrders(db, siteOrders, { today: '2026-11-07' });
  assert.equal(s.orders, 2);
  assert.equal(s.named, 2);
  assert.equal(s.created, 1);

  const candle = db.prepare("SELECT * FROM items WHERE name LIKE 'Yankee%'").get();
  assert.equal(candle.email_name, null, 'no shared words with either category, so the category label is no longer trusted');
  assert.match(candle.notes, /look swapped, use Rename/);
  assert.equal(candle.unit_price_cents, 999);
  assert.equal(candle.name_source, 'amazon_site');
  assert.equal(candle.return_deadline, '2026-12-06');
  assert.equal(candle.return_deadline_status, 'confirmed');
  assert.equal(candle.stage, 'delivered');
  assert.equal(candle.delivered_date, '2026-11-06');
  assert.ok(!/only gave the category/.test(candle.notes ?? ''), 'category note removed');

  const towels = db.prepare("SELECT * FROM items WHERE name LIKE 'Bounty%'").get();
  assert.equal(towels.email_name, null);
  assert.equal(towels.seller, null, 'sold by Amazon is not a third-party seller');

  const scale = db.prepare("SELECT * FROM items WHERE name LIKE 'Kitchen Scale%'").get();
  assert.equal(scale.seller, 'GadgetCo');
  assert.equal(scale.stage, 'delivered');
  assert.equal(scale.return_deadline, '2026-11-25');

  // Storage & Organization order wasn't in the site data: untouched
  assert.equal(db.prepare("SELECT name FROM items WHERE email_name = 'Storage & Organization' OR name = 'Storage & Organization'").get().name, 'Storage & Organization');

  // Running again changes nothing
  const again = applyAmazonOrders(db, siteOrders, { today: '2026-11-08' });
  assert.equal(again.created, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 4);
});

test('later category-only emails attach to site-named items instead of duplicating; your renames win', async () => {
  const db = openDb(':memory:');
  applyAmazonOrders(db, [siteOrders[0]], { today: '2026-11-05' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 2);
  const r = ingestParsedEmail(db, { messageId: 'x1', retailer: 'amazon', kind: 'order_confirmation', orderNumber: '111-3646931-0001058', orderDate: '2026-11-05', receivedAt: '2026-11-05',
    items: [{ name: 'Household Supplies', quantity: 1, categoryName: true }, { name: 'Home Fragrance', quantity: 1, categoryName: true }] });
  assert.equal(r.status, 'imported');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 2, 'no duplicates');

  const towels = db.prepare("SELECT id FROM items WHERE name LIKE 'Bounty%'").get().id;
  renameItem(db, towels, 'Paper towels', '2026-11-06');
  applyAmazonOrders(db, [siteOrders[0]], { today: '2026-11-07' });
  assert.equal(getItem(db, towels).name, 'Paper towels');
});

function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit('data', stdout); child.stderr.emit('data', stderr); child.emit('close', code, null); });
    return child;
  };
}

test('bridge output is parsed; garbage output becomes a readable error', async () => {
  const ok = await runBridge({ python: 'py', script: 's', spawnImpl: fakeSpawn({ stdout: JSON.stringify({ ok: true, orders: [] }) }) });
  assert.deepEqual(ok, { ok: true, orders: [] });
  const bad = await runBridge({ python: 'py', script: 's', spawnImpl: fakeSpawn({ stdout: 'Traceback...', stderr: 'ModuleNotFoundError: x', code: 1 }) });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /ModuleNotFoundError/);
});

test('first run looks back 3 months, later runs 30 days; expired sign-in raises an alert', async () => {
  const db = openDb(':memory:');
  updateSettings(db, { amazonSiteEnabled: true });
  const filters = [];
  const config = { available: true, python: 'py', script: 's' };
  await syncAmazonSite(db, { config, runner: async ({ timeFilter }) => { filters.push(timeFilter); return { ok: true, orders: [] }; } });
  await syncAmazonSite(db, { config, runner: async ({ timeFilter }) => { filters.push(timeFilter); return { ok: false, error: 'signin_required' }; } });
  assert.deepEqual(filters, ['months-3', 'last30']);
  assert.equal(lastAmazonSiteRun(db).error, 'signin_required');
  assert.ok(computeReminders(db, '2026-11-07').some((r) => r.kind === 'amazon_signin'));
  assert.deepEqual(await syncAmazonSite(db, { config: { available: false } }), { ok: false, error: 'not_installed' });
});

test('names are not guessed for items with a return in progress', async () => {
  const db = await emailFirst();
  const fragrance = db.prepare("SELECT id FROM items WHERE name = 'Home Fragrance'").get().id;
  db.prepare("UPDATE items SET stage = 'return_started' WHERE id = ?").run(fragrance);
  applyAmazonOrders(db, [siteOrders[0]], { today: '2026-11-07' });
  const it = getItem(db, fragrance);
  assert.equal(it.name, 'Home Fragrance');
  assert.match(it.notes, /Your Amazon order page lists: Yankee Candle Lavender Jar Candle; Bounty Paper Towels/);
});

test('exact pairing when names share words', async () => {
  const db = openDb(':memory:');
  ingestParsedEmail(db, { messageId: 'e1', retailer: 'amazon', kind: 'order_confirmation', orderNumber: '111-0000000-0000002', orderDate: '2026-11-01', receivedAt: '2026-11-01',
    items: [{ name: 'Kitchen & Dining', quantity: 1, categoryName: true }, { name: 'Office Products', quantity: 1, categoryName: true }] });
  applyAmazonOrders(db, [{ order_number: '111-0000000-0000002', order_placed_date: '2026-11-01',
    items: [{ title: 'Office Desk Organizer', price: 15 }, { title: 'Kitchen Timer, Digital', price: 8 }] }], { today: '2026-11-02' });
  const rows = db.prepare('SELECT name, email_name FROM items ORDER BY id').all();
  assert.deepEqual(rows, [{ name: 'Kitchen Timer, Digital', email_name: 'Kitchen & Dining' }, { name: 'Office Desk Organizer', email_name: 'Office Products' }]);
});

test('only orders still missing prices get their detail pages loaded', async () => {
  const db = await emailFirst(); // one Amazon order has a real price from the email? no: grand-total stand-in and one with none
  assert.deepEqual(ordersWithPrices(db), [], 'grand-total stand-ins and missing prices both count as "needs prices"');
  applyAmazonOrders(db, [{ order_number: '111-3646931-0001058', order_placed_date: '2026-11-05', payment_method: 'Visa ending in 4242',
    items: [{ title: 'Yankee Candle Lavender Jar Candle', price: 9.99 }, { title: 'Bounty Paper Towels, 6 Double Rolls', price: 13.49 }] }], { today: '2026-11-07' });
  assert.deepEqual(ordersWithPrices(db), ['111-3646931-0001058']);
  assert.equal(db.prepare("SELECT payment_method FROM orders WHERE order_number = '111-3646931-0001058'").get().payment_method, 'Visa ending in 4242');

  let args;
  await runBridge({ python: 'py', script: 's', skipDetails: ordersWithPrices(db), spawnImpl: (cmd, a) => { args = a; return fakeSpawn({ stdout: '{"ok":true,"orders":[]}' })(); } });
  assert.deepEqual(args, ['s', '--time-filter', 'last30', '--skip-details', '111-3646931-0001058']);
});

test('Costco-style confirmation: "order N is confirmed" subject, item numbers are not names', () => {
  const [p] = parse({ id: 'c1', subject: 'Your Costco.com order 1317669410 is confirmed!', from: 'Costco Orders <Costco@orders.costco.com>', date: '2026-09-27T23:57:00',
    text: 'Thank you for your order\nSamsung 65" Class - S85H OLED Series - 4K Vision AI Smart TV\nItem #1711427\nQty: 1\n$1,799.99\nOrder Total: $1,925.99' });
  assert.equal(p.kind, 'order_confirmation');
  assert.equal(p.retailer, 'costco.com');
  assert.equal(p.merchantName, 'Costco');
  assert.equal(p.orderNumber, '1317669410');
  assert.equal(p.orderDate, '2026-09-27');
  assert.deepEqual(p.items.map((i) => [i.name, i.retailerItemId, i.quantity, i.unitPriceCents]), [['Samsung 65" Class - S85H OLED Series - 4K Vision AI Smart TV', '1711427', 1, 179999]]);
  assert.equal(p.orderTotalCents, 192599);
});

test('with Amazon order details on: Amazon purchase emails are skipped, returns/refunds still read', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const gmail = fakeGmail([
    gmailMessage({ id: 'o1', subject: 'Ordered 3 items: Storage & Organization, Household Supplies, and more', html: twoOrderHtml, date: '2026-11-05T07:51:00' }),
    gmailMessage({ id: 'ret', subject: 'Your return request for "Home Fragrance"', date: '2026-11-08T10:00:00',
      html: '<p>Order # 111-3646931-0001058</p><p>Home Fragrance</p><p>Quantity: 1</p><p>Drop off by November 20</p>' }),
  ]);
  const r = await syncGmail(db, { client: gmail, amazonFromSite: true });
  assert.ok(gmail.calls.list.some((q) => q.startsWith('from:amazon.com subject:(return OR refund')));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'order_confirmation'").get().n, 0);
  assert.match(db.prepare("SELECT reason FROM skipped_messages WHERE message_id = 'o1' AND provider = 'gmail:amazon'").get().reason, /Amazon order pages/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'return_started'").get().n, 1);
  assert.equal(r.imported, 1);

  // Turning Amazon order details off re-checks those skipped purchase emails
  await syncGmail(db, { client: gmail, amazonFromSite: false });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'order_confirmation'").get().n, 2);
});

test('all-mail search: obvious non-purchases are skipped from the preview, without downloading them', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const gmail = fakeGmail([
    gmailMessage({ id: 'n1', subject: 'Your weekly newsletter', from: 'Blog <news@blog.example>', text: 'Read our latest posts about receipts and budgeting' }),
    gmailMessage({ id: 'r1', subject: 'Your ride receipt', from: 'Lyft <no-reply@lyft.com>', text: 'Order # 123456789' }),
    gmailMessage({ id: 'c1', subject: 'Your Costco.com order 1317669410 is confirmed!', from: 'Costco Orders <Costco@orders.costco.com>', date: '2026-09-27T23:57:00',
      text: 'Samsung 65" OLED TV\nItem #1711427\nQty: 1\n$1,799.99' }),
  ]);
  await syncGmail(db, { client: gmail });
  assert.ok(!gmail.calls.get.includes('n1') && !gmail.calls.get.includes('r1'), 'skipped from the preview alone');
  assert.match(db.prepare("SELECT reason FROM skipped_messages WHERE message_id = 'n1' AND provider = 'gmail:other'").get().reason, /look like a purchase/);
  assert.equal(db.prepare("SELECT merchant_name FROM orders WHERE order_number = '1317669410'").get().merchant_name, 'Costco');
});

test('order emails with an unhelpful subject are recognized from their text', () => {
  const [p] = parse({ id: 'x1', subject: 'A note about your recent visit', from: 'REI <rei@notices.rei.com>', date: '2026-11-01T10:00:00',
    text: 'Thank you for your order!\nOrder number: 9988776655\nTrail Running Shoe\nQuantity: 1\n$129.95' });
  assert.equal(p.kind, 'order_confirmation');
  assert.equal(p.orderNumber, '9988776655');
  assert.equal(p.items[0].name, 'Trail Running Shoe');
  assert.deepEqual(parse({ id: 'x2', subject: '30% off this weekend only', from: 'REI <rei@notices.rei.com>', text: 'Thank you for your order! Order number: 1234567' }), []);
});

test('after the rules change, the next sync searches the full window again (once)', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const gmail = fakeGmail([]);
  await syncGmail(db, { client: gmail });
  await syncGmail(db, { client: gmail });
  const other = () => gmail.calls.list.filter((q) => q.startsWith('-from:amazon.com'));
  assert.match(other()[0], /newer_than:180d/);
  assert.match(other()[1], /after:/, 'normal syncs only look at recent mail');

  db.prepare("UPDATE settings SET value = 'old-rules' WHERE key = 'sync_scope:other'").run(); // simulate a rules upgrade
  await syncGmail(db, { client: gmail });
  assert.match(other()[2], /newer_than:180d/, 'full window after a change');
  await syncGmail(db, { client: gmail });
  assert.match(other()[3], /after:/, 'then back to recent mail');
});
