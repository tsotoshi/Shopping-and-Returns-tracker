// Tests built from the layout of real Amazon emails (Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseAmazonEmails, parseArriving, parseCategoryItems } from '../src/retailers/amazon.js';
import { decodeMessage } from '../src/gmail/client.js';
import { openDb } from '../src/db.js';
import { saveAccount } from '../src/gmail/account.js';
import { syncGmail } from '../src/services/sync.js';
import { renameItem } from '../src/services/items.js';
import { gmailMessage, fakeGmail, twoOrderHtml } from './helpers/gmail.js';

const SUBJECT = 'Ordered 3 items: Storage & Organization, Household Supplies, and more';
const realMsg = (id = 'r1') => gmailMessage({ id, subject: SUBJECT, html: twoOrderHtml, date: '2026-11-05T07:51:00' });

test('recognizes the real subject formats', () => {
  assert.equal(classify('Ordered 3 items: Storage & Organization, Household Supplies, an...'), 'order_confirmation');
  assert.equal(classify('Ordered 1 item: Kitchen & Dining'), 'order_confirmation');
  assert.equal(classify('Ordered: 1 item. Thanks for shopping with us!'), 'order_confirmation');
  assert.equal(classify('Shipped 1 item: Kitchen & Dining'), 'shipped');
  assert.equal(classify('Delivered 2 items: Household Supplies'), 'delivered');
  assert.equal(classify('David sent you printing information about an Amazon.com return'), null);
  assert.equal(classify('Fwd: Your Amazon.com Order'), null);
});

test('reads category items and delivery wording', () => {
  assert.deepEqual(parseCategoryItems(['2 items: 1 Household Supplies, 1 Home Fragrance']), [
    { name: 'Household Supplies', quantity: 1 }, { name: 'Home Fragrance', quantity: 1 }]);
  assert.deepEqual(parseCategoryItems(['1 Storage & Organization item']), [{ name: 'Storage & Organization', quantity: 1 }]);
  assert.equal(parseArriving('today 5 PM – 8 PM', '2026-11-05'), '2026-11-05');
  assert.equal(parseArriving('overnight 3 AM – 6 AM', '2026-11-05'), '2026-11-06');
  assert.equal(parseArriving('Friday', '2026-11-05'), '2026-11-06'); // Nov 5 2026 is a Thursday
  assert.equal(parseArriving('Monday, November 9', '2026-11-05'), '2026-11-09');
});

test('one email with two orders becomes two parsed orders with their own items and totals', () => {
  const results = parseAmazonEmails(decodeMessage(realMsg()));
  assert.equal(results.length, 2);
  const [a, b] = results;
  assert.equal(a.orderNumber, '111-3646931-0001058');
  assert.equal(a.messageId, 'r1#111-3646931-0001058');
  assert.deepEqual(a.items.map((i) => [i.name, i.quantity, i.unitPriceCents]), [['Household Supplies', 1, null], ['Home Fragrance', 1, null]]);
  assert.equal(a.orderTotalCents, 2546);
  assert.equal(a.estimatedDeliveryDate, '2026-11-06');
  assert.match(a.items[0].note, /only gave the category/);

  assert.equal(b.orderNumber, '111-7056707-4221854');
  assert.deepEqual(b.items.map((i) => [i.name, i.quantity, i.unitPriceCents]), [['Storage & Organization', 1, 2336]]);
  assert.match(b.items[0].note, /grand total/);
  assert.equal(b.estimatedDeliveryDate, '2026-11-05');
  assert.deepEqual(a.warnings, [], 'all 3 items found, so no warning');
});

test('sync imports both orders once; previously skipped emails are re-checked after a parser upgrade', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  // Simulate the old parser having skipped this email:
  db.prepare("INSERT INTO skipped_messages (provider, message_id, reason) VALUES ('gmail', 'r1', 'old parser')").run();
  const gmail = fakeGmail([realMsg()]);

  const r1 = await syncGmail(db, { client: gmail });
  assert.equal(r1.imported, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skipped_messages").get().n, 0);
  assert.equal(db.prepare("SELECT web_link FROM emails LIMIT 1").get().web_link, 'https://mail.google.com/mail/?authuser=me%40example.com#all/r1');

  const before = gmail.calls.get.length;
  const r2 = await syncGmail(db, { client: gmail });
  assert.equal(r2.already_had, 1);
  assert.equal(gmail.calls.get.length, before, 'not downloaded again');
});

test('skipped emails are recorded with subject and reason', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const promo = gmailMessage({ id: 'p1', subject: 'Deals on household supplies', html: '<p>Sale</p>' });
  await syncGmail(db, { client: fakeGmail([promo]) });
  const row = db.prepare('SELECT subject, reason, parser_version FROM skipped_messages').get();
  assert.equal(row.subject, 'Deals on household supplies');
  assert.match(row.reason, /not an order/);
  assert.equal(row.parser_version, 2);
});

test('renaming an item keeps later emails matching it', async () => {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  const gmail = fakeGmail([realMsg()]);
  await syncGmail(db, { client: gmail });
  const fragrance = db.prepare("SELECT id FROM items WHERE name = 'Home Fragrance'").get().id;
  renameItem(db, fragrance, 'Lavender candle', '2026-11-05');
  assert.equal(db.prepare('SELECT name, email_name FROM items WHERE id = ?').get(fragrance).name, 'Lavender candle');

  gmail.add(gmailMessage({ id: 'd1', subject: 'Delivered 1 item: Home Fragrance', date: '2026-11-06T10:00:00',
    html: '<p>Delivered today</p><p>1 Home Fragrance item</p><p>Order # 111-3646931-0001058</p>' }));
  await syncGmail(db, { client: gmail });
  const it = db.prepare('SELECT stage, delivered_date FROM items WHERE id = ?').get(fragrance);
  assert.equal(it.stage, 'delivered');
  assert.equal(it.delivered_date, '2026-11-06');
  assert.equal(db.prepare("SELECT stage FROM items WHERE name = 'Household Supplies'").get().stage, 'purchased');
});
