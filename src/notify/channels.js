// Sends reminders outside the app: push to your phone via ntfy, and/or email.
//
// ntfy (https://ntfy.sh) is a free push service with an iPhone app. You pick
// a long random "topic" name, subscribe to it in the ntfy app, and this app
// posts messages to that topic. Anyone who knows the topic name can read it,
// so: the app generates a long random one, and by default leaves item names
// out of push messages (turn on "include item names" in Settings if you like).
//
// Email uses your email provider's SMTP settings from .env. We do NOT send
// through the Gmail connection: that stays read-only.

import nodemailer from 'nodemailer';
import { getSettings } from '../db.js';

const DIGEST_AFTER = 3; // more than this many at once -> one summary message
const EXPIRE_DAYS = 3; // don't push stale reminders that piled up while off

export function isQuietHour(hour, start, end) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function emailConfig(env = process.env) {
  const cfg = {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    to: env.NOTIFY_EMAIL_TO || '',
    from: env.NOTIFY_EMAIL_FROM || env.SMTP_USER || '',
  };
  cfg.configured = !!(cfg.host && cfg.user && cfg.pass && cfg.to);
  return cfg;
}

export function makeChannels({ settings, fetchImpl = fetch, email = emailConfig(), makeTransport = (c) => nodemailer.createTransport(c), appUrl = process.env.APP_URL || '' }) {
  const channels = [];
  const link = (n) => (appUrl ? `${appUrl.replace(/\/$/, '')}/#/${n?.item_id ? `item/${n.item_id}` : 'alerts'}` : undefined);

  if (settings.ntfyTopic) {
    channels.push({
      name: 'push',
      async send({ title, body, notification }) {
        // JSON publishing avoids header-encoding problems with non-ASCII text.
        const res = await fetchImpl(settings.ntfyServer.replace(/\/$/, '') + '/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: settings.ntfyTopic, title, message: body, tags: ['package'], click: link(notification) }),
        });
        if (!res.ok) throw new Error(`push failed (${res.status})`);
      },
    });
  }

  if (settings.emailEnabled && email.configured) {
    let transport;
    channels.push({
      name: 'email',
      async send({ title, fullBody, notification }) {
        transport ??= makeTransport({ host: email.host, port: email.port, secure: email.port === 465, auth: { user: email.user, pass: email.pass } });
        const url = link(notification);
        await transport.sendMail({ from: email.from, to: email.to, subject: `Returns Tracker: ${title}`, text: `${fullBody}${url ? `\n\nOpen: ${url}` : ''}` });
      },
    });
  }
  return channels;
}

/**
 * Send reminders that haven't gone out yet. Safe to call often: each reminder
 * is delivered once. During quiet hours nothing is sent (they wait).
 */
export async function deliverPending(db, { now = new Date(), channels } = {}) {
  const settings = getSettings(db);
  channels ??= makeChannels({ settings });
  const mark = db.prepare("UPDATE notifications SET delivered_at = datetime('now'), delivery_note = ? WHERE id = ?");
  const pending = db.prepare('SELECT * FROM notifications WHERE delivered_at IS NULL ORDER BY id').all();
  const result = { sent: 0, skipped: 0, waiting: 0, errors: [] };

  const toSend = [];
  for (const n of pending) {
    const ageDays = (now - new Date(n.created_at.replace(' ', 'T') + 'Z')) / 86400000;
    if (n.is_sample) { mark.run('sample data — shown in the app only', n.id); result.skipped++; continue; }
    if (ageDays > EXPIRE_DAYS) { mark.run('expired before it could be sent', n.id); result.skipped++; continue; }
    if (!channels.length) { mark.run('in-app only (no push or email set up)', n.id); result.skipped++; continue; }
    toSend.push(n);
  }
  if (!toSend.length) return result;
  if (isQuietHour(now.getHours(), settings.quietStart, settings.quietEnd)) { result.waiting = toSend.length; return result; }

  const messages = toSend.length > DIGEST_AFTER
    ? [{ ids: toSend.map((n) => n.id), title: `${toSend.length} reminders`, body: 'Several returns or refunds need your attention. Open the app to see them.', fullBody: toSend.map((n) => `• ${n.title}: ${n.body}`).join('\n'), notification: null }]
    : toSend.map((n) => ({ ids: [n.id], title: n.title, body: settings.pushIncludeNames ? n.body : n.private_body || n.body, fullBody: n.body, notification: n }));

  for (const m of messages) {
    const outcomes = await Promise.allSettled(channels.map((c) => c.send(m)));
    const ok = channels.filter((_, i) => outcomes[i].status === 'fulfilled').map((c) => c.name);
    const failed = outcomes.map((o, i) => (o.status === 'rejected' ? `${channels[i].name}: ${o.reason.message}` : null)).filter(Boolean);
    result.errors.push(...failed);
    if (ok.length) {
      for (const id of m.ids) mark.run(`sent via ${ok.join(' + ')}${failed.length ? ` (failed: ${failed.join('; ')})` : ''}`, id);
      result.sent += m.ids.length;
    } // if every channel failed, leave pending to retry next time
  }
  return result;
}

/** "Send test notification" button. */
export async function sendTest(db, { channels } = {}) {
  channels ??= makeChannels({ settings: getSettings(db) });
  if (!channels.length) throw new Error('No push or email channel is set up yet.');
  const msg = { title: 'Test from Returns Tracker', body: 'Notifications are working.', fullBody: 'Notifications are working. You will get reminders here.', notification: null };
  const outcomes = await Promise.allSettled(channels.map((c) => c.send(msg)));
  return channels.map((c, i) => ({ channel: c.name, ok: outcomes[i].status === 'fulfilled', error: outcomes[i].reason?.message ?? null }));
}
