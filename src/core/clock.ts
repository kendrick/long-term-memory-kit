const pad = (n: number): string => String(n).padStart(2, "0");

// The regex alone passes 2026-02-30, so the parts go through Date.UTC and must come back unchanged.
function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
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
