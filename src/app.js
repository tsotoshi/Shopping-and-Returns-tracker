// The web server: serves the phone-friendly UI from /public and a JSON API
// under /api. createApp() takes the database so tests can use a throwaway one.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, DEFAULT_SETTINGS } from './db.js';
import { todayISO } from './lib/dates.js';
import { STAGES } from './lib/stages.js';
import { dashboard, listItems, itemDetail, stores } from './services/queries.js';
import * as items from './services/items.js';
import { loadSampleData, clearSampleData } from './sample/sampleData.js';
import { RETAILERS } from './retailers/index.js';
import crypto from 'node:crypto';
import { googleConfig, buildAuthUrl, exchangeCode } from './gmail/oauth.js';
import { getAccount, saveAccount, disconnect, tokenProvider } from './gmail/account.js';
import { createGmailClient } from './gmail/client.js';
import { syncGmail, lastSyncRun, isSyncing } from './services/sync.js';
import Anthropic from '@anthropic-ai/sdk';
import { reviewPolicies, itemsNeedingReview, isReviewing, setPolicyLink } from './services/policyReviews.js';

// Turn AI API errors into plain-English messages (typed classes, not string matching).
function aiErrorMessage(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected — check ANTHROPIC_API_KEY in .env.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Your Anthropic account doesn\'t have access to this model or tool.';
  if (e instanceof Anthropic.RateLimitError) return 'The AI service is busy or your usage limit was reached — try again in a few minutes.';
  if (e instanceof Anthropic.APIConnectionError) return 'Couldn\'t reach the AI service — check your internet connection.';
  if (e instanceof Anthropic.APIError) return `The AI service returned an error (${e.status ?? 'unknown'}).`;
  return e.message;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const toCents = (v) => (v === '' || v == null ? undefined : Math.round(Number(v) * 100));

// Optional password for the whole app (recommended when you open it from
// your phone over Wi-Fi). Uses the browser's built-in login prompt.
function passwordGate(password) {
  const expected = Buffer.from(password);
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const given = scheme === 'Basic' ? Buffer.from(Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':')) : Buffer.alloc(0);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Returns Tracker"').status(401).send('Password required');
  };
}

export function createApp(db, {
  today = () => process.env.TODAY || todayISO(),
  google = googleConfig(),
  appPassword = process.env.APP_PASSWORD || '',
  fetchImpl = fetch,
  makeGmailClient = () => createGmailClient({ getAccessToken: tokenProvider(db, google, fetchImpl), fetchImpl }),
  aiConfigured = !!process.env.ANTHROPIC_API_KEY,
  // The SDK reads ANTHROPIC_API_KEY from the environment; the key never reaches the browser.
  makeAiClient = () => new Anthropic(),
} = {}) {
  const app = express();
  if (appPassword) app.use(passwordGate(appPassword));
  app.use(express.json());

  // ---- Gmail sign-in (OAuth) ----
  const pendingStates = new Map(); // random state -> expiry; blocks forged callbacks
  app.get('/auth/google/start', (req, res) => {
    if (!google.configured) return res.status(400).send('Gmail is not configured: add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI to .env and restart.');
    const state = crypto.randomBytes(24).toString('hex');
    pendingStates.set(state, Date.now() + 10 * 60_000);
    res.redirect(buildAuthUrl(google, state));
  });
  app.get('/auth/google/callback', async (req, res) => {
    const back = (msg) => res.redirect(`/#/settings?gmail=${encodeURIComponent(msg)}`);
    const exp = pendingStates.get(req.query.state);
    pendingStates.delete(req.query.state);
    if (!exp || exp < Date.now()) return back('Sign-in expired or was not started from this app. Please try again.');
    if (req.query.error) return back(req.query.error === 'access_denied' ? 'You cancelled the Google sign-in.' : `Google said: ${req.query.error}`);
    try {
      const tokens = await exchangeCode(google, String(req.query.code || ''), fetchImpl);
      const client = createGmailClient({ getAccessToken: async () => tokens.access_token, fetchImpl });
      const profile = await client.profile();
      saveAccount(db, { email: profile.emailAddress, tokens });
      back('connected');
    } catch (e) {
      console.error('Gmail connect failed:', e.message);
      back(e.message);
    }
  });
  app.use(express.static(path.join(here, '..', 'public')));

  const api = express.Router();
  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e instanceof items.UserError) return res.status(400).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
  const id = (req) => Number(req.params.id);

  // What's actually connected. The UI uses this to be honest about what's live.
  api.get('/status', wrap(() => {
    const acct = getAccount(db);
    return {
    gmail: {
      configured: google.configured,
      connected: !!acct && !acct.needs_reconnect,
      needsReconnect: !!acct?.needs_reconnect,
      email: acct?.email ?? null,
      lastSyncAt: acct?.last_sync_at ?? null,
      lastRun: lastSyncRun(db),
      syncing: isSyncing(),
    },
    ai: { configured: aiConfigured, reviewing: isReviewing(), pending: itemsNeedingReview(db).length },
    retailers: Object.values(RETAILERS).map((r) => ({ id: r.id, name: r.name, parserReady: !!r.parse })),
    today: today(),
    };
  }));

  api.get('/dashboard', wrap(() => dashboard(db, today())));
  api.get('/items', wrap((req) => ({ items: listItems(db, req.query), stores: stores(db), stages: STAGES })));
  api.get('/items/:id', wrap((req, res) => {
    const d = itemDetail(db, id(req));
    if (!d) { res.status(404).json({ error: 'Not found' }); return; }
    return d;
  }));

  api.post('/items/:id/stage', wrap((req) => { items.manualStage(db, id(req), req.body.stage, req.body.note, today()); return itemDetail(db, id(req)); }));
  api.post('/items/:id/dropoff', wrap((req) => { items.markDroppedOff(db, id(req), req.body.date, today()); return itemDetail(db, id(req)); }));
  api.post('/items/:id/deadlines', wrap((req) => { items.correctDeadlines(db, id(req), req.body, today()); return itemDetail(db, id(req)); }));
  api.post('/items/:id/expected-refund', wrap((req) => { items.setExpectedRefund(db, id(req), toCents(req.body.amount), today()); return itemDetail(db, id(req)); }));
  api.post('/items/:id/refund/received', wrap((req) => { items.confirmRefund(db, id(req), { amountCents: toCents(req.body.amount), date: req.body.date }, today()); return itemDetail(db, id(req)); }));
  api.post('/items/:id/refund/not-yet', wrap((req) => { items.snoozeRefund(db, id(req), today()); return itemDetail(db, id(req)); }));
  api.post('/items/:id/refund/problem', wrap((req) => { items.reportRefundProblem(db, id(req), { note: req.body.note, receivedCents: toCents(req.body.received) }, today()); return itemDetail(db, id(req)); }));
  api.post('/items/:id/refund/resolve', wrap((req) => { items.resolveRefund(db, id(req), { note: req.body.note }, today()); return itemDetail(db, id(req)); }));
  api.post('/suggestions/:id/accept', wrap((req) => { items.acceptSuggestion(db, id(req)); return { ok: true }; }));
  api.post('/suggestions/:id/reject', wrap((req) => { items.rejectSuggestion(db, id(req)); return { ok: true }; }));

  api.post('/sync', async (req, res) => {
    const acct = getAccount(db);
    if (!google.configured) return res.status(400).json({ error: 'Gmail is not set up yet — see Settings.' });
    if (!acct) return res.status(400).json({ error: 'Connect Gmail in Settings first. Nothing was synced.' });
    try {
      res.json(await syncGmail(db, { client: makeGmailClient() }));
    } catch (e) {
      if (e.reconnect || e.status === 401) {
        db.prepare('UPDATE gmail_account SET needs_reconnect = 1 WHERE id = 1').run();
        return res.status(401).json({ error: 'Gmail access expired — tap Reconnect in Settings. (Google requires this weekly while the app is in Testing mode.)' });
      }
      console.error('Sync failed:', e);
      res.status(500).json({ error: `Sync failed: ${e.message}` });
    }
  });
  const runReview = async (res, itemIds) => {
    if (!aiConfigured) return res.status(400).json({ error: 'AI review isn\'t set up — add ANTHROPIC_API_KEY to .env and restart. See Settings.' });
    try {
      res.json(await reviewPolicies(db, { client: makeAiClient(), itemIds, today: today() }));
    } catch (e) {
      if (!(e instanceof Anthropic.APIError)) console.error('Policy review failed:', e);
      res.status(e instanceof Anthropic.APIError ? 502 : 500).json({ error: aiErrorMessage(e) });
    }
  };
  api.post('/policy/review', (req, res) => {
    const ids = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(Number).filter(Number.isInteger) : undefined;
    return runReview(res, ids);
  });
  api.post('/items/:id/policy-link', (req, res) => {
    try { setPolicyLink(db, id(req), String(req.body?.url ?? '')); } catch (e) { return res.status(400).json({ error: e.message }); }
    return runReview(res, [id(req)]);
  });

  api.post('/gmail/disconnect', async (req, res) => {
    await disconnect(db, fetchImpl);
    res.json({ ok: true });
  });

  api.post('/sample/load', wrap(() => { clearSampleData(db); loadSampleData(db, today()); return { ok: true }; }));
  api.post('/sample/clear', wrap(() => { clearSampleData(db); return { ok: true }; }));

  api.get('/settings', wrap(() => getSettings(db)));
  api.post('/settings', wrap((req) => {
    const map = { refundReminderDays: 'refund_reminder_days', snoozeDays: 'snooze_days', overdueGraceDays: 'overdue_grace_days', deadlineWarningDays: 'deadline_warning_days' };
    for (const [k, col] of Object.entries(map)) {
      if (req.body[k] == null) continue;
      const n = Number(req.body[k]);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw new items.UserError(`${k} must be a whole number from 1 to 365`);
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(n), col);
    }
    // Re-run refund windows so a new default reminder interval takes effect.
    for (const r of db.prepare("SELECT item_id FROM refunds WHERE status IN ('pending','issued','partial','problem')").all()) {
      items.recomputeRefundWindow(db, r.item_id);
    }
    return getSettings(db);
  }));

  app.use('/api', api);
  return app;
}

export { DEFAULT_SETTINGS };
