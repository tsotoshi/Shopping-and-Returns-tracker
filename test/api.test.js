import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function withServer(fn) {
  const db = openDb(':memory:');
  const server = createApp(db, { today: () => '2026-11-05', google: { configured: false } }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

test('sync is honest that Gmail is not connected', () => withServer(async (call) => {
  const r = await call('/sync', {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not set up|Connect Gmail/);
  assert.equal((await call('/status')).body.gmail.connected, false);
}));

test('sample data loads, is labeled, and can be removed', () => withServer(async (call) => {
  await call('/sample/load', {});
  const d = (await call('/dashboard')).body;
  assert.equal(d.hasSampleData, true);
  assert.ok(d.needsCheck.length >= 1);
  assert.ok(d.toDropOff.length >= 1);
  assert.ok(d.totalOutstandingCents > 0);
  const list = (await call('/items')).body.items;
  assert.ok(list.every((i) => i.is_sample === 1));
  await call('/sample/load', {}); // reloading doesn't duplicate
  assert.equal((await call('/items')).body.items.length, list.length);
  await call('/sample/clear', {});
  assert.equal((await call('/items')).body.items.length, 0);
  assert.equal((await call('/dashboard')).body.hasSampleData, false);
}));

test('search and filters', () => withServer(async (call) => {
  await call('/sample/load', {});
  const q = (await call('/items?q=blender')).body.items;
  assert.equal(q.length, 1);
  const st = (await call('/items?stage=keeping')).body.items;
  assert.ok(st.every((i) => i.stage === 'keeping'));
}));

test('refund actions via API and validation errors', () => withServer(async (call) => {
  await call('/sample/load', {});
  const grinder = (await call('/items?q=grinder')).body.items[0];
  const r = await call(`/items/${grinder.id}/refund/received`, { amount: '60.00' });
  assert.equal(r.body.refund.status, 'partial');
  assert.equal((await call('/settings', { snoozeDays: 0 })).status, 400);
}));
