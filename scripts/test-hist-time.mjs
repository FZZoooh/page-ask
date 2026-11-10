// Drive the real formatTime through its boundaries with a fake clock: today / yesterday / within the week /
// older / last year / across New Year. Anything but today also carries the wall-clock time ("周三 16:04").
import assert from 'node:assert/strict';
import { formatTime } from '../src/lib/format-time.mjs';

const LABELS = {
  yesterday: '昨天',
  weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
};

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// "Now" is 2026-11-06 (Friday) 21:21
const now = at(2026, 11, 6, 21, 21);
const cases = [
  ['earlier today', at(2026, 11, 6, 16, 4), '16:04'],
  ['yesterday', at(2026, 11, 5, 13, 13), '昨天 13:13'],
  ['2 days ago (Wed)', at(2026, 11, 4, 9, 5), '周三 09:05'],
  ['6 days ago (Sat)', at(2026, 10, 31, 23, 59), '周六 23:59'],
  ['7 days ago (exactly one week)', at(2026, 10, 30, 9, 0), '10/30 09:00'],
  ['same month last year', at(2025, 11, 2, 8, 7), '2025/11/2 08:07'],
  ['earlier this year', at(2026, 3, 8, 15, 30), '3/8 15:30'],
];

for (const [label, ts, want] of cases) {
  const got = formatTime(ts, now, LABELS);
  assert.equal(got, want, `${label}: expected ${want}, got ${got}`);
  console.log(`✓ ${label.padEnd(14)} -> ${got}`);
}

// New Year boundary: seen on Jan 2, Dec 31 (2 days back) must render "weekday + time", neither 12/31 nor 2025/12/31
const nyd = at(2026, 1, 2, 10, 0);
for (const [label, ts, want] of [
  ['1 day before New Year', at(2026, 1, 1, 9, 30), '昨天 09:30'],
  ['2 days across the year boundary', at(2025, 12, 31, 9, 30), '周三 09:30'],
  ['3 days across the year boundary', at(2025, 12, 30, 9, 30), '周二 09:30'],
  ['4 days across the year boundary', at(2025, 12, 29, 9, 30), '周一 09:30'],
]) {
  const got = formatTime(ts, nyd, LABELS);
  assert.equal(got, want, `${label}: expected ${want}, got ${got}`);
  console.log(`✓ ${label.padEnd(14)} -> ${got} (today=1/2)`);
}

// Across New Year but more than a week back: the year is included, and so is the time
const got = formatTime(at(2025, 12, 20, 21, 45), nyd, LABELS);
assert.equal(got, '2025/12/20 21:45', `more than a week across New Year should be 2025/12/20 21:45, got ${got}`);
console.log(`✓ ${'13 days across the year boundary'.padEnd(14)} -> ${got}`);

console.log('\nall good');
