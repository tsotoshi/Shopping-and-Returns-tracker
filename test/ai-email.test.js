// AI email reading (with a fake AI client — no real calls, no cost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, verifyExtraction, extractWithAI, aiToParsed, monthSpendCents, recordUsage } from '../src/ai/emailExtract.js';
import { decodeMessage } from '../src/gmail/client.js';
import { openDb } from '../src/db.js';
import { saveAccount } from '../src/gmail/account.js';
import { syncGmail } from '../src/services/sync.js';
import { purchases } from '../src/services/queries.js';
import { gmailMessage, fakeGmail } from './helpers/gmail.js';

const EMAIL_TEXT = `Thanks for your purchase, Eric!
Confirmation code: ZX81QK2
Merino Crew Sweater - Navy, M
$89.00
Ship to: 123 Maple Street, Quincy MA
Questions? Call 617-555-0142 or write help@woolstore.example
Paid with card 4111 1111 1111 1111
Total charged: $95.23`;

const aiAnswer = (overrides = {}) => ({
  kind: 'order_confirmation',
  merchantName: 'Wool Store',
  orders: [{ orderNumber: 'ZX81QK2', orderDate: null, items: [{ name: 'Merino Crew Sweater - Navy, M', quantity: 1, price: '$89.00' }], orderTotal: '$95.23', refundAmount: null, estimatedDelivery: null }],
  ...overrides,
});

function fakeAi(answers) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const a = answers.shift();
        if (a instanceof Error) throw a;
        if (a?.stop_reason) return { stop_reason: a.stop_reason, content: [], usage: { input_tokens: 100, output_tokens: 0 } };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(a) }], usage: { input_tokens: 3000, output_tokens: 400 } };
      },
    },
  };
}

test('personal details are removed before sending; order numbers stay', () => {
  const r = redact(EMAIL_TEXT);
  assert.ok(!r.includes('help@woolstore.example') && r.includes('[email]'));
  assert.ok(!r.includes('617-555-0142') && r.includes('[phone]'));
  assert.ok(!r.includes('4111 1111 1111 1111') && r.includes('[card]'));
  assert.ok(!r.includes('123 Maple Street') && r.includes('[address]'));
  assert.ok(r.includes('ZX81QK2') && r.includes('$89.00'));
  assert.ok(redact('Order number 1317669410').includes('1317669410'), '10-digit order numbers are not mistaken for phones');
  assert.ok(redact('Ref 4111111111111112').includes('4111111111111112'), 'numbers failing the card checksum stay');
});

test('the AI answer is checked against the email: invented details are dropped', () => {
  const v = verifyExtraction(aiAnswer({
    orders: [
      { orderNumber: 'ZX81QK2', orderDate: null, items: [
        { name: 'Merino Crew Sweater - Navy, M', quantity: 1, price: '$79.00' }, // wrong price
        { name: 'Cashmere Scarf', quantity: 1, price: '$40.00' }, // not in email
      ], orderTotal: '$95.23', refundAmount: null, estimatedDelivery: null },
      { orderNumber: 'FAKE999', orderDate: null, items: [], orderTotal: null, refundAmount: null, estimatedDelivery: null }, // invented order
    ],
  }), EMAIL_TEXT);
  assert.equal(v.orders.length, 1);
  assert.deepEqual(v.orders[0].items, [{ name: 'Merino Crew Sweater - Navy, M', quantity: 1, unitPriceCents: null }]);
  assert.equal(v.orders[0].orderTotalCents, 9523);
  assert.equal(v.dropped, 3);
});

test('calls Haiku 5.5 with redacted text, records the cost, handles refusals', async () => {
  const db = openDb(':memory:');
  const msg = decodeMessage(gmailMessage({ id: 'w1', subject: 'Thanks for your purchase', from: 'Wool Store <orders@woolstore.example>', text: EMAIL_TEXT }));
  const ai = fakeAi([aiAnswer(), { stop_reason: 'refusal' }]);
  const out = await extractWithAI(ai, db, msg);
  const sent = ai.calls[0];
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.deepEqual(sent.thinking, { type: 'disabled' });
  assert.equal(sent.output_config.effort, 'low');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(sent.messages).includes('4111 1111 1111 1111'), 'card number not sent');
  assert.equal(out.orders[0].items[0].unitPriceCents, 8900);
  // 3000 in x $0.10/M + 400 out x $0.50/M = $0.0005 = 0.05 cents
  assert.equal(monthSpendCents(db).cents, 0.05);
  assert.equal(monthSpendCents(db).emails, 1);
  const declined = await extractWithAI(ai, db, msg);
  assert.equal(declined.kind, 'not_a_purchase');
});

test('AI result becomes a normal purchase, labeled as read by AI', () => {
  const msg = decodeMessage(gmailMessage({ id: 'w1', subject: 'Thanks for your purchase', from: 'Wool Store <orders@woolstore.example>', text: EMAIL_TEXT, date: '2026-11-03T10:00:00' }));
  const [p] = aiToParsed(verifyExtraction(aiAnswer(), EMAIL_TEXT), msg);
  assert.equal(p.retailer, 'woolstore.example');
  assert.equal(p.merchantName, 'Wool Store');
  assert.equal(p.orderNumber, 'ZX81QK2');
  assert.equal(p.orderDate, '2026-11-03');
  assert.equal(p.items[0].source, 'ai');
  assert.equal(p.orderTotalCents, 9523);
});

function syncSetup(messages) {
  const db = openDb(':memory:');
  saveAccount(db, { email: 'me@example.com', tokens: { refresh_token: 'r', access_token: 'a', expires_in: 3600, scope: 's' } });
  return { db, gmail: fakeGmail(messages) };
}
const readerFor = (db, ai, capCents = 100) => async (msg) => {
  if (monthSpendCents(db).cents >= capCents) return { paused: true };
  const r = await extractWithAI(ai, db, msg);
  return { results: aiToParsed(r, msg), note: r.note };
};

test('sync: the AI reads emails the rules cannot, each email only once', async () => {
  const wool = gmailMessage({ id: 'w1', subject: 'Thanks for your purchase', from: 'Wool Store <orders@woolstore.example>', text: EMAIL_TEXT });
  const promo = gmailMessage({ id: 'n1', subject: 'Your order of happiness is waiting', from: 'Spa <hi@spa.example>', text: 'Book a massage today. Thanks for your order of relaxation.' });
  const { db, gmail } = syncSetup([wool, promo]);
  const ai = fakeAi([aiAnswer(), { kind: 'not_a_purchase', merchantName: null, orders: [] }]);
  const r = await syncGmail(db, { client: gmail, aiReader: readerFor(db, ai) });
  assert.equal(r.ai_read, 1);
  const row = purchases(db).find((x) => x.order_number === 'ZX81QK2');
  assert.equal(row.merchant, 'Wool Store');
  assert.equal(row.amount_cents, 8900);
  assert.equal(row.source, 'Email (read by AI)');
  assert.match(db.prepare("SELECT reason FROM skipped_messages WHERE message_id = 'n1'").get().reason, /AI read it: not a purchase/);

  const before = ai.calls.length;
  db.prepare("UPDATE gmail_account SET last_sync_at = NULL").run(); // force a full look again
  await syncGmail(db, { client: gmail, aiReader: readerFor(db, ai) });
  assert.equal(ai.calls.length, before, 'no email is sent to the AI twice');
});

test('sync: monthly limit pauses the AI; AI errors fall back to rules', async () => {
  const wool = gmailMessage({ id: 'w1', subject: 'Thanks for your purchase', from: 'Wool Store <orders@woolstore.example>', text: EMAIL_TEXT });
  const { db, gmail } = syncSetup([wool]);
  recordUsage(db, { purpose: 'email', model: 'claude-haiku-5-5', usage: { input_tokens: 10_000_000, output_tokens: 0 } }); // $1.00 already spent
  const ai = fakeAi([aiAnswer()]);
  const r = await syncGmail(db, { client: gmail, aiReader: readerFor(db, ai, 100) });
  assert.equal(r.ai_paused, 1);
  assert.equal(ai.calls.length, 0);
  assert.match(db.prepare("SELECT reason FROM skipped_messages WHERE message_id = 'w1'").get().reason, /monthly limit/);

  const { db: db2, gmail: gmail2 } = syncSetup([wool]);
  const broken = fakeAi([new Error('invalid x-api-key')]);
  const r2 = await syncGmail(db2, { client: gmail2, aiReader: readerFor(db2, broken) });
  assert.ok(r2.ok);
  assert.ok(db2.prepare("SELECT message FROM sync_runs ORDER BY id DESC").get().message.includes('AI email reading stopped'));
});

test('turning AI on gives emails the rules skipped earlier one AI look', async () => {
  const wool = gmailMessage({ id: 'w1', subject: 'Thanks for your purchase', from: 'Wool Store <orders@woolstore.example>', text: EMAIL_TEXT });
  const { db, gmail } = syncSetup([wool]);
  await syncGmail(db, { client: gmail }); // AI off: rules skip it
  assert.equal(purchases(db).length, 0);
  const ai = fakeAi([aiAnswer()]);
  await syncGmail(db, { client: gmail, aiReader: readerFor(db, ai) }); // AI on: full look, AI reads it
  assert.equal(ai.calls.length, 1);
  assert.equal(purchases(db)[0].order_number, 'ZX81QK2');
});
