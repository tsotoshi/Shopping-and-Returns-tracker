// Date helpers. All dates in this app are plain calendar dates stored as
// "YYYY-MM-DD" strings. We do the math in UTC so daylight-saving changes and
// time zones can never shift a deadline by a day.

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmt(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Today's date in the server's local time zone, as YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso, n) {
  const d = toDate(iso);
  return d ? fmt(new Date(d.getTime() + n * DAY_MS)) : null;
}

export function daysBetween(fromIso, toIso) {
  return Math.round((toDate(toIso) - toDate(fromIso)) / DAY_MS);
}

export function isWeekend(iso) {
  const day = toDate(iso).getUTCDay();
  return day === 0 || day === 6;
}

export function maxDate(...isos) {
  return isos.filter(Boolean).sort().at(-1) ?? null;
}

// --- Bank holidays -------------------------------------------------------
// Refunds post through banks, so "business days" means days banks process
// payments. We use the US Federal Reserve holiday schedule: when a holiday
// falls on Sunday it is observed Monday; when it falls on Saturday the Fed
// does NOT close the Friday before. This is an assumption we disclose in the UI.

function nthWeekday(year, month, weekday, n) {
  // month 0-11, weekday 0=Sun; n=1..5, or -1 for "last"
  if (n === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    const diff = (last.getUTCDay() - weekday + 7) % 7;
    return fmt(new Date(last.getTime() - diff * DAY_MS));
  }
  const first = new Date(Date.UTC(year, month, 1));
  const diff = (weekday - first.getUTCDay() + 7) % 7;
  return fmt(new Date(first.getTime() + (diff + (n - 1) * 7) * DAY_MS));
}

function fixed(year, month, day) {
  const iso = fmt(new Date(Date.UTC(year, month, day)));
  return toDate(iso).getUTCDay() === 0 ? addDays(iso, 1) : iso; // Sunday -> Monday
}

export function bankHolidays(year) {
  return [
    fixed(year, 0, 1), // New Year's Day
    nthWeekday(year, 0, 1, 3), // MLK Day
    nthWeekday(year, 1, 1, 3), // Presidents Day
    nthWeekday(year, 4, 1, -1), // Memorial Day
    fixed(year, 5, 19), // Juneteenth
    fixed(year, 6, 4), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day
    nthWeekday(year, 9, 1, 2), // Columbus / Indigenous Peoples' Day
    fixed(year, 10, 11), // Veterans Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving
    fixed(year, 11, 25), // Christmas
  ].filter((d) => toDate(d).getUTCDay() !== 6); // Saturday holidays aren't observed
}

export const HOLIDAY_ASSUMPTION =
  'Business days skip weekends and US Federal Reserve bank holidays.';

export function isBankHoliday(iso) {
  return bankHolidays(toDate(iso).getUTCFullYear()).includes(iso);
}

export function isBusinessDay(iso) {
  return !isWeekend(iso) && !isBankHoliday(iso);
}

/** Add n business days (n >= 0). Day 0 = the start date itself. */
export function addBusinessDays(iso, n) {
  let cur = iso;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur)) left--;
  }
  return cur;
}
