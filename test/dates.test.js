import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addBusinessDays, bankHolidays, daysBetween } from '../src/lib/dates.js';

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // leap year
  assert.equal(daysBetween('2026-11-01', '2026-11-30'), 29);
});

test('bank holidays for 2026', () => {
  const h = bankHolidays(2026);
  assert.ok(h.includes('2026-11-26'), 'Thanksgiving');
  assert.ok(h.includes('2026-01-19'), 'MLK Day');
  assert.ok(h.includes('2026-05-25'), 'Memorial Day');
  // July 4 2026 is a Saturday: the Fed does NOT close Friday July 3
  assert.ok(!h.includes('2026-07-03'));
  assert.ok(!h.includes('2026-07-04'));
});

test('Sunday holidays are observed on Monday', () => {
  assert.ok(bankHolidays(2023).includes('2023-01-02')); // Jan 1 2023 was a Sunday
});

test('business days skip weekends and holidays', () => {
  // Fri Nov 6 2026 + 1 business day = Mon Nov 9
  assert.equal(addBusinessDays('2026-11-06', 1), '2026-11-09');
  // Wed Nov 25 + 3: Thu 26 is Thanksgiving -> Fri 27, Mon 30, Tue Dec 1
  assert.equal(addBusinessDays('2026-11-25', 3), '2026-12-01');
  // Veterans Day Wed Nov 11 2026 is skipped
  assert.equal(addBusinessDays('2026-11-10', 1), '2026-11-12');
});
