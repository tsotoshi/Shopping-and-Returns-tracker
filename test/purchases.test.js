import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { saveAccount } from '../src/gmail/account.js';
import { syncGmail } from '../src/services/sync.js';
import { purchases } from '../src/services/queries.js';
import { applyAmazonOrders } from '../src/integrations/amazonSite.js';
import { loadSampleData } from '../src/sample/sampleData.js';
import { gmailMessage, fakeGmail, twoOrderHtml } from './helpers/gmail.js';

async function setup() {
  const db = openDb(':memory:');
  loadSampleData(db, '2026-11-05'); // must NOT show up in the list
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const target = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Order', merchant: { name: 'Target' }, orderNumber: '912003456789', orderDate: '2026-11-02',
    price: '39.99', acceptedOffer: [{ itemOffered: { name: 'Bath Towel' }, price: '12.00', eligibleQuantity: { value: 2 } }, { itemOffered: { name: 'Shower Curtain' }, price: '15.99' }] })}</script>`;
  await syncGmail(db, { client: fakeGmail([
    gmailMessage({ id: 'r1', subject: 'Ordered 3 items: Storage & Organization, Household Supplies, and more', html: twoOrderHtml, date: '2026-11-05T07:51:00' }),
    gmailMessage({ id: 't1', subject: 'Thanks for your order!', html: target, from: 'Target <orders@oe.target.com>', date: '2026-11-02T10:00:00' }),
  ]) });
  return db;
}

test('purchase list: real items only, merchant names, amounts, order totals, data source and flags', async () => {
  const db = await setup();
  const rows = purchases(db);
  assert.equal(rows.length, 5, '3 Amazon items + 2 Target items, no sample data');
  const towel = rows.find((r) => r.name === 'Bath Towel');
  assert.equal(towel.merchant, 'Target');
  assert.equal(towel.quantity, 2);
  assert.equal(towel.amount_cents, 2400, 'price x quantity');
  assert.equal(towel.order_total_cents, 3999);
  assert.equal(towel.source, 'Email');
  assert.match(towel.email_link, /#all\/t1$/);

  const storage = rows.find((r) => r.name === 'Storage & Organization');
  assert.equal(storage.merchant, 'Amazon');
  assert.equal(storage.order_total_cents, 2336);
  assert.equal(storage.price_is_total, true);
  assert.equal(storage.source, 'Email (category only)');
  const household = rows.find((r) => r.name === 'Household Supplies');
  assert.equal(household.amount_cents, null);
  assert.equal(household.order_total_cents, 2546);
});

test('Amazon order page fills names/prices and its grand total wins', async () => {
  const db = await setup();
  applyAmazonOrders(db, [{ order_number: '111-7056707-4221854', order_placed_date: '2026-11-05', grand_total: 23.36,
    items: [{ title: 'Clear Storage Bins, 3 Pack', price: 21.49, quantity: 1 }] }], { today: '2026-11-06' });
  const bins = purchases(db).find((r) => r.order_number === '111-7056707-4221854');
  assert.ok(bins, 'order present');
  assert.equal(bins.name, 'Clear Storage Bins, 3 Pack');
  assert.equal(bins.amount_cents, 2149);
  assert.equal(bins.price_is_total, false, 'grand-total note removed once the real price is known');
  assert.equal(bins.source, 'Amazon order page');
});
