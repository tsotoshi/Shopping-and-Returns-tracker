import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { saveAccount } from '../src/gmail/account.js';
import { syncGmail } from '../src/services/sync.js';
import { getItem, getRefund } from '../src/services/items.js';
import { gmailMessage, fakeGmail, orderHtml } from './helpers/gmail.js';

function setup(messages) {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 'x' } });
  return { db, gmail: fakeGmail(messages) };
}

const ORDER = gmailMessage({ id: 'g1', subject: 'Ordered: "Anker 735 Charger..." and 1 more item', html: orderHtml, date: '2026-10-01T15:00:00' });

test('first sync imports; second sync skips everything without re-downloading', async () => {
  const promo = gmailMessage({ id: 'g0', subject: 'Deals on chargers you might like', html: '<p>Sale!</p>', date: '2026-09-30T10:00:00' });
  const { db, gmail } = setup([promo, ORDER]);
  const r1 = await syncGmail(db, { client: gmail });
  assert.equal(r1.imported, 1);
  assert.equal(r1.ignored, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 2);
  const amazonQueries = () => gmail.calls.list.filter((q) => q.startsWith('from:amazon.com'));
  assert.match(amazonQueries()[0], /newer_than:180d/);
  assert.ok(gmail.calls.list.some((q) => q.startsWith('(category:purchases')), 'also searches other stores');

  const before = gmail.calls.get.length;
  const r2 = await syncGmail(db, { client: gmail });
  assert.equal(r2.imported, 0);
  assert.equal(r2.already_had, 2);
  assert.equal(gmail.calls.get.length, before, 'no messages downloaded again');
  assert.match(amazonQueries()[1], /after:\d{4}\/\d{2}\/\d{2}/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 2);
});

test('full lifecycle from real-format emails, with Gmail links and refund timing from the email', async () => {
  const msgs = [ORDER];
  const { db, gmail } = setup(msgs);
  gmail.add(gmailMessage({ id: 'g2', subject: 'Delivered: "Merino Wool Socks 3-Pack"', html: '<p>Order #113-1234567-7654321</p><p>Merino Wool Socks 3-Pack</p><p>Quantity: 2</p>', date: '2026-10-05T12:00:00' }));
  gmail.add(gmailMessage({ id: 'g3', subject: 'Your return request for "Merino Wool Socks 3-Pack"', date: '2026-10-12T10:00:00',
    html: '<p>Order #113-1234567-7654321</p><p>Merino Wool Socks 3-Pack</p><p>Quantity: 1</p><p>Drop off by October 23</p><a href="https://www.amazon.com/returns/qr">QR code</a>' }));
  gmail.add(gmailMessage({ id: 'g4', subject: 'Your refund for Merino Wool Socks 3-Pack', date: '2026-10-28T10:00:00',
    html: '<p>Order #113-1234567-7654321</p><p>Merino Wool Socks 3-Pack</p><p>Your refund of $12.00 was issued to your Visa ending in 4242. It may take 3-5 business days to appear.</p>' }));
  const r = await syncGmail(db, { client: gmail });
  assert.equal(r.imported, 4);
  assert.equal(r.needs_review, 0);

  const rows = db.prepare('SELECT * FROM items ORDER BY id').all();
  const charger = rows[0];
  const keptSocks = rows.find((i) => i.name.startsWith('Merino') && !i.split_from_item_id);
  const returned = rows.find((i) => i.split_from_item_id);
  assert.equal(charger.stage, 'purchased'); // delivery email only mentioned the socks
  assert.equal(keptSocks.quantity, 1);
  assert.equal(keptSocks.stage, 'delivered');
  assert.equal(returned.quantity, 1);
  assert.equal(returned.stage, 'refund_issued'); // NOT confirmed: only you can confirm
  assert.equal(returned.qr_url, 'https://www.amazon.com/returns/qr');
  assert.equal(returned.dropoff_deadline, '2026-10-23');

  const refund = getRefund(db, returned.id);
  assert.equal(refund.issued_cents, 1200);
  assert.equal(refund.destination, 'Visa ••4242');
  assert.equal(refund.window_kind, 'retailer');
  assert.equal(refund.window_end, '2026-11-04'); // Wed Oct 28 + 5 business days
  assert.match(refund.window_basis, /Stated in the refund email/);

  const link = db.prepare("SELECT web_link FROM emails WHERE message_id = 'g1'").get().web_link;
  assert.equal(link, 'https://mail.google.com/mail/?authuser=me%40example.com#all/g1');
  // We keep extracted fields, not the email body
  assert.ok(!db.prepare("SELECT parsed_json FROM emails WHERE message_id = 'g1'").get().parsed_json.includes('Hello Sam'));
});

test('spoofed sender is ignored', async () => {
  const fake = gmailMessage({ id: 's1', subject: 'Your refund for Socks', from: 'Amazon <refunds@amazon.com.scam.example>', html: '<p>Order #113-1234567-7654321 refund $500.00</p>' });
  const { db, gmail } = setup([fake]);
  const r = await syncGmail(db, { client: gmail });
  assert.equal(r.ignored, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
});

test('expired Gmail access stops the sync and records the error', async () => {
  const { db } = setup([]);
  const client = { listMessageIds: async () => { const e = new Error('expired'); e.reconnect = true; throw e; } };
  await assert.rejects(syncGmail(db, { client }), /expired/);
  assert.equal(db.prepare('SELECT status FROM sync_runs ORDER BY id DESC').get().status, 'error');
  // and a new sync can run afterwards
  const { gmail } = setup([]);
  await syncGmail(db, { client: gmail });
});

test('one unreadable message does not stop the others', async () => {
  const { db, gmail } = setup([ORDER]);
  const client = { ...gmail, listMessageIds: async () => ['bad', 'g1'], getMessage: async (id) => { if (id === 'bad') throw new Error('boom'); return ORDER; } };
  const r = await syncGmail(db, { client });
  assert.equal(r.failed, 1);
  assert.equal(r.imported, 1);
  assert.ok(getItem(db, 1));
});
