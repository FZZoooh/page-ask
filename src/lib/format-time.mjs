// Pure date/time formatting for the side panel. Kept in .mjs so the regression test can import the real
// implementation with Node directly (no TS runtime), instead of keeping a copy that silently drifts.
export function clockTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Today shows the clock only, everything else "day + clock".
 * Always diff by local calendar day (not a 24h span), so "on Jan 2 looking at Dec 30" is 3 days ago.
 *
 * @param {number} ts
 * @param {number} nowMs
 * @param {{ yesterday: string, weekdays: string[] }} labels
 */
export function formatTime(ts, nowMs, labels) {
  const d = new Date(ts);
  const now = new Date(nowMs);
  const hm = clockTime(ts);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  // A DST day can be 23/25 hours long, so round to whole days.
  const dayDiff = Math.round((midnight(now) - midnight(d)) / 86_400_000);

  if (dayDiff <= 0) return hm; // today (a clock-skew "future" still counts as today)
  if (dayDiff === 1) return `${labels.yesterday} ${hm}`;
  if (dayDiff < 7) return `${labels.weekdays[d.getDay()]} ${hm}`;

  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`} ${hm}`;
}
