import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthUrl, checkScopes, GMAIL_READONLY } from '../src/gmail/oauth.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { getAccount } from '../src/gmail/account.js';

const cfg = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/auth/google/callback', configured: true };

test('auth URL asks only for read-only Gmail, offline access, and carries state', () => {
  const u = new URL(buildAuthUrl(cfg, 'abc'));
  assert.equal(u.searchParams.get('scope'), GMAIL_READONLY);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('state'), 'abc');
  assert.ok(!u.toString().includes('secret'), 'client secret never goes to the browser');
});

test('refuses tokens with more than read-only access', () => {
  assert.doesNotThrow(() => checkScopes(GMAIL_READONLY));
  assert.throws(() => checkScopes(`${GMAIL_READONLY} https://www.googleapis.com/auth/gmail.modify`), /more than read-only/);
  assert.throws(() => checkScopes('https://mail.google.com/'), /did not grant read-only/);
});

function fakeGoogle({ scope = GMAIL_READONLY } = {}) {
  return async (url) => {
    const json = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) });
    if (String(url).includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope });
    if (String(url).endsWith('/profile')) return json({ emailAddress: 'me@example.com' });
    if (String(url).includes('/revoke')) return json({});
    throw new Error(`unexpected ${url}`);
  };
}

async function withServer(opts, fn) {
  const db = openDb(':memory:');
  const server = createApp(db, { google: cfg, ...opts }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, db); } finally { server.close(); }
}

test('connect flow: state is checked, tokens stored server-side, status shows connected', () => withServer({ fetchImpl: fakeGoogle() }, async (base, db) => {
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  const forged = await fetch(`${base}/auth/google/callback?code=x&state=wrong`, { redirect: 'manual' });
  assert.match(decodeURIComponent(forged.headers.get('location')), /expired or was not started/);
  assert.equal(getAccount(db), null);

  const ok = await fetch(`${base}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual' });
  assert.match(ok.headers.get('location'), /gmail=connected/);
  assert.equal(getAccount(db).refresh_token, 'rt');

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.gmail.connected, true);
  assert.equal(status.gmail.email, 'me@example.com');
  assert.ok(!JSON.stringify(status).includes('rt'), 'tokens never sent to the browser');

  // state can't be reused
  const replay = await fetch(`${base}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual' });
  assert.match(decodeURIComponent(replay.headers.get('location')), /expired/);

  await fetch(`${base}/api/gmail/disconnect`, { method: 'POST' });
  assert.equal(getAccount(db), null);
}));

test('connect is refused if Google grants broader access', () => withServer({ fetchImpl: fakeGoogle({ scope: `${GMAIL_READONLY} https://mail.google.com/` }) }, async (base, db) => {
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const r = await fetch(`${base}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual' });
  assert.match(decodeURIComponent(r.headers.get('location')), /more than read-only/);
  assert.equal(getAccount(db), null);
}));

test('sync without a connection explains what to do', () => withServer({}, async (base) => {
  const r = await fetch(`${base}/api/sync`, { method: 'POST' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Connect Gmail/);
}));

test('optional app password protects everything', () => withServer({ appPassword: 'hunter2-long' }, async (base) => {
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const auth = { headers: { Authorization: `Basic ${Buffer.from('me:hunter2-long').toString('base64')}` } };
  assert.equal((await fetch(`${base}/api/status`, auth)).status, 200);
  const wrong = { headers: { Authorization: `Basic ${Buffer.from('me:nope').toString('base64')}` } };
  assert.equal((await fetch(`${base}/api/status`, wrong)).status, 401);
}));
