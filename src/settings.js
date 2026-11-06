// All user settings in one place: name, database key, type, limits, default.
// Adding a setting = adding one line here; validation and defaults follow.

export const SETTINGS = {
  refundReminderDays: { key: 'refund_reminder_days', type: 'int', min: 1, max: 365, default: 10 }, // when refund timing is unknown
  snoozeDays: { key: 'snooze_days', type: 'int', min: 1, max: 365, default: 3 }, // "Not yet — remind me again"
  overdueGraceDays: { key: 'overdue_grace_days', type: 'int', min: 1, max: 365, default: 7 },
  deadlineWarningDays: { key: 'deadline_warning_days', type: 'int', min: 1, max: 365, default: 14 }, // dashboard look-ahead

  // Stage 4: background work & notifications
  remindBeforeDays: { key: 'remind_before_days', type: 'int', min: 1, max: 30, default: 3 }, // notify this many days before a return deadline
  autoSyncHours: { key: 'auto_sync_hours', type: 'int', min: 0, max: 48, default: 6 }, // 0 = off
  autoReview: { key: 'auto_review', type: 'bool', default: false }, // costs money, so off by default
  quietStart: { key: 'quiet_start', type: 'int', min: 0, max: 23, default: 21 }, // no push/email from 9pm...
  quietEnd: { key: 'quiet_end', type: 'int', min: 0, max: 23, default: 8 }, // ...until 8am (same value = no quiet hours)
  ntfyTopic: { key: 'ntfy_topic', type: 'string', pattern: /^[A-Za-z0-9_-]{0,64}$/, default: '', hint: 'letters, numbers, - and _ only' },
  ntfyServer: { key: 'ntfy_server', type: 'string', pattern: /^https:\/\/[^\s/]+(\/[^\s]*)?$/, default: 'https://ntfy.sh', hint: 'an https:// address' },
  pushIncludeNames: { key: 'push_include_names', type: 'bool', default: false }, // item names in phone notifications
  emailEnabled: { key: 'email_enabled', type: 'bool', default: false },
  // Optional: real Amazon product names/prices/return dates via the amazon-orders helper
  amazonSiteEnabled: { key: 'amazon_site_enabled', type: 'bool', default: false },
  // AI reading of purchase emails the rules can't read (Claude Haiku 5.5)
  aiEmailEnabled: { key: 'ai_email_enabled', type: 'bool', default: false },
  aiMonthlyCapCents: { key: 'ai_monthly_cap_cents', type: 'int', min: 10, max: 5000, default: 100 }, // $1.00
};

export class SettingsError extends Error {}

export function seedSettings(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const s of Object.values(SETTINGS)) ins.run(s.key, String(s.type === 'bool' ? (s.default ? 1 : 0) : s.default));
}

export function getSettings(db) {
  const raw = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const out = {};
  for (const [name, s] of Object.entries(SETTINGS)) {
    const v = raw[s.key];
    if (v == null) out[name] = s.default;
    else if (s.type === 'int') out[name] = Number(v);
    else if (s.type === 'bool') out[name] = v === '1';
    else out[name] = v;
  }
  return out;
}

/** Validate and save any subset of settings. Throws SettingsError with a readable message. */
export function updateSettings(db, input) {
  const writes = [];
  for (const [name, value] of Object.entries(input ?? {})) {
    const s = SETTINGS[name];
    if (!s || value == null) continue;
    let stored;
    if (s.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < s.min || n > s.max) throw new SettingsError(`${name} must be a whole number from ${s.min} to ${s.max}`);
      stored = String(n);
    } else if (s.type === 'bool') {
      stored = value === true || value === 'true' || value === '1' || value === 1 || value === 'on' ? '1' : '0';
    } else {
      const str = String(value).trim();
      if (!s.pattern.test(str)) throw new SettingsError(`${name} must be ${s.hint}`);
      stored = str;
    }
    writes.push([stored, s.key]);
  }
  const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  db.transaction(() => { for (const w of writes) up.run(...w); })();
  return getSettings(db);
}
