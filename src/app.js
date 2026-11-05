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

const here = path.dirname(fileURLToPath(import.meta.url));
const toCents = (v) => (v === '' || v == null ? undefined : Math.round(Number(v) * 100));

export function createApp(db, { today = () => process.env.TODAY || todayISO() } = {}) {
  const app = express();
  app.use(express.json());
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
  api.get('/status', wrap(() => ({
    gmail: { connected: false, stage: 2, note: 'Gmail import arrives in Stage 2.' },
    ai: { configured: false, stage: 3, note: 'AI policy review arrives in Stage 3.' },
    retailers: Object.values(RETAILERS).map((r) => ({ id: r.id, name: r.name, parserReady: !!r.parse })),
    today: today(),
  })));

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

  api.post('/sync', wrap((req, res) => {
    res.status(501).json({ error: 'Gmail is not connected yet. Real email import is built in Stage 2 — nothing was synced.' });
  }));

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
