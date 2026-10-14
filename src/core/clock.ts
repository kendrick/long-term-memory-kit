const pad = (n: number): string => String(n).padStart(2, "0");

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// The regex alone passes 2026-02-30, so month lengths are checked by hand. A round trip through Date.UTC
// can't do it, because Date.UTC reads years 0-99 as 1900-1999.
function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12) return false;
  const days = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d >= 1 && d <= days;
}

// The one date source for commands that stamp Records (accept, propose, doctor). LTM_TODAY pins it so tests
// stamp a known day on any machine. Empty counts as unset, as LTM_CONFIG does. The fallback is local time,
// since a person accepting at 23:30 means today, not UTC's tomorrow.
export function today(env: Record<string, string | undefined>, now: Date = new Date()): string {
  const pinned = env.LTM_TODAY;
  if (pinned) {
    if (!isCalendarDate(pinned)) throw new Error(`LTM_TODAY '${pinned}' is not a YYYY-MM-DD date`);
    return pinned;
  }
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
