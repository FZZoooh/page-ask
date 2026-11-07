// 用假时钟把 fmtTime 的边界跑一遍：今天/昨天/周内/更早/去年/跨年
// 注意：非今天的都带具体时刻（「周三 16:04」这种）
import assert from 'node:assert/strict';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fmtTime(ts, nowMs) {
  const d = new Date(ts);
  const now = new Date(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (dayDiff <= 0) return hm;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) return `${WEEKDAYS[d.getDay()]} ${hm}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`} ${hm}`;
}

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// 现在：2026-11-06（周五）21:21
const now = at(2026, 11, 6, 21, 21);
const cases = [
  ['今天稍早', at(2026, 11, 6, 16, 4), '16:04'],
  ['昨天', at(2026, 11, 5, 13, 13), '昨天 13:13'],
  ['2 天前（周三）', at(2026, 11, 4, 9, 5), '周三 09:05'],
  ['6 天前（周六）', at(2026, 10, 31, 23, 59), '周六 23:59'],
  ['7 天前（正好一周）', at(2026, 10, 30, 9, 0), '10/30 09:00'],
  ['去年同月', at(2025, 11, 2, 8, 7), '2025/11/2 08:07'],
  ['今年更早', at(2026, 3, 8, 15, 30), '3/8 15:30'],
];

for (const [label, ts, want] of cases) {
  const got = fmtTime(ts, now);
  assert.equal(got, want, `${label}: 期望 ${want}，实际 ${got}`);
  console.log(`✓ ${label.padEnd(14)} -> ${got}`);
}

// 跨年边界：1 月 2 日看 12 月 31 日（2 天前）应该是「周X + 时刻」，不是 12/31 也不是 2025/12/31
const nyd = at(2026, 1, 2, 10, 0);
for (const [label, ts, want] of [
  ['新年 1 天前', at(2026, 1, 1, 9, 30), '昨天 09:30'],
  ['跨年 2 天前', at(2025, 12, 31, 9, 30), '周三 09:30'],
  ['跨年 3 天前', at(2025, 12, 30, 9, 30), '周二 09:30'],
  ['跨年 4 天前', at(2025, 12, 29, 9, 30), '周一 09:30'],
]) {
  const got = fmtTime(ts, nyd);
  assert.equal(got, want, `${label}: 期望 ${want}，实际 ${got}`);
  console.log(`✓ ${label.padEnd(14)} -> ${got}（today=1/2）`);
}

// 跨年但超过一周：要带年份，也带时刻
const got = fmtTime(at(2025, 12, 20, 21, 45), nyd);
assert.equal(got, '2025/12/20 21:45', `跨年超一周应为 2025/12/20 21:45，实际 ${got}`);
console.log(`✓ ${'跨年 13 天前'.padEnd(14)} -> ${got}`);

console.log('\n全部通过');
