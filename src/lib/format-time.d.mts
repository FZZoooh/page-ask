export function clockTime(ts: number): string;
export function formatTime(
  ts: number,
  nowMs: number,
  labels: { yesterday: string; weekdays: string[] },
): string;
