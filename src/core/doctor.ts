import memoryBankSchema from "../../schema/memory-bank.schema.json" with { type: "json" };
import { isMapping, type BankConfig } from "./bank.ts";
import { isCalendarDate } from "./clock.ts";
import { RETIRED_STATUSES } from "./query.ts";
import type { ParsedRecord } from "./record.ts";
import { byCodeUnit } from "./text.ts";
import { sharesScope } from "./validate.ts";

export type CheckName =
  | "stale-confirmed"
  | "review-due"
  | "stale-proposal"
  | "long-chain"
  | "orphan"
  | "broken-related"
  | "supersession-no-shared-facet";

export type DoctorFinding = { file: string; check: CheckName; message: string; related_files: string[] };

export type Thresholds = {
  stale_confirmed_days: number;
  proposal_age_days: number;
  max_chain_length: number;
  orphan_days: number;
};

const THRESHOLD_KEYS: readonly (keyof Thresholds)[] = [
  "stale_confirmed_days",
  "proposal_age_days",
  "max_chain_length",
  "orphan_days",
];

// Read from the config schema rather than copied in, so the defaults `ltm doctor` applies and the ones the
// schema documents can't drift apart.
const DEFAULT_THRESHOLDS: Readonly<Thresholds> = (() => {
  const props: Record<string, { default?: unknown }> = memoryBankSchema.properties.doctor.properties;
  const out = {} as Thresholds;
  for (const key of THRESHOLD_KEYS) {
    const v = props[key]?.default;
    if (!isThreshold(v)) throw new Error(`schema/memory-bank.schema.json: doctor.${key} has no usable default`);
    out[key] = v;
  }
  if (Object.keys(props).some((k) => !(THRESHOLD_KEYS as readonly string[]).includes(k))) {
    throw new Error("schema/memory-bank.schema.json: doctor lists a key the Thresholds type doesn't");
  }
  return Object.freeze(out);
})();

function isThreshold(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

export function loadThresholds(config: BankConfig): Thresholds | { error: string } {
  const out: Thresholds = { ...DEFAULT_THRESHOLDS };
  const raw = config.raw.doctor;
  if (raw === undefined) return out;
  // `doctor:` with no value parses as null, which the schema rejects too, so it isn't read as "no overrides".
  if (!isMapping(raw)) return { error: "doctor is not a mapping" };
  for (const [key, v] of Object.entries(raw)) {
    if (!(THRESHOLD_KEYS as readonly string[]).includes(key)) return { error: `doctor.${key}: unknown key` };
    if (!isThreshold(v)) return { error: `doctor.${key} must be an integer of 1 or more` };
    out[key as keyof Thresholds] = v;
  }
  return out;
}

// Howard Hinnant's days_from_civil, in integers. Date.UTC would read years 0-99 as 1900-1999.
function dayNumber(s: string): number {
  if (!isCalendarDate(s)) throw new Error(`'${s}' is not a YYYY-MM-DD date`);
  const [y0, m, d] = s.split("-").map(Number) as [number, number, number];
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe;
}

export function daysBetween(earlier: string, later: string): number {
  return dayNumber(later) - dayNumber(earlier);
}

type Edge = { old: ParsedRecord; new: ParsedRecord };

type DoctorContext = {
  records: readonly ParsedRecord[];
  today: string;
  thresholds: Thresholds;
  heldIds: ReadonlySet<string>;
  edges: readonly Edge[];
  inbound: ReadonlyMap<ParsedRecord, number>;
};

const isLive = (r: ParsedRecord): boolean =>
  !(typeof r.frontmatter.status === "string" && RETIRED_STATUSES.includes(r.frontmatter.status));

// A malformed value is `ltm validate`'s to report, so a check that needs it gets null and skips the Record.
function dateField(r: ParsedRecord, key: string): string | null {
  const v = r.frontmatter[key];
  return typeof v === "string" && isCalendarDate(v) ? v : null;
}

const absent = (v: unknown): boolean => v === undefined || v === null;

// null marks a malformed field so callers skip the Record; validate reports the malformation.
function stringListField(r: ParsedRecord, key: string): string[] | null {
  const v = r.frontmatter[key];
  if (absent(v)) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return null;
}

// Same reading `checkBrightLine` gives a `related` entry: the id follows the last `::`.
const relatedId = (entry: string): string =>
  entry.includes("::") ? entry.slice(entry.lastIndexOf("::") + 2) : entry;

const finding = (file: string, check: CheckName, message: string, related: string[] = []): DoctorFinding => ({
  file,
  check,
  message,
  related_files: [...related].sort(byCodeUnit),
});

function staleConfirmed(ctx: DoctorContext): DoctorFinding[] {
  const t = ctx.thresholds.stale_confirmed_days;
  const out: DoctorFinding[] = [];
  for (const r of ctx.records) {
    // A Proposal hasn't been confirmed yet; `stale-proposal` covers its age.
    if (!isLive(r) || r.frontmatter.status === "proposed") continue;
    const hasConfirmed = !absent(r.frontmatter.last_confirmed);
    const ref = dateField(r, hasConfirmed ? "last_confirmed" : "date");
    if (ref === null) continue;
    const n = daysBetween(ref, ctx.today);
    if (n <= t) continue;
    out.push(
      finding(
        r.path,
        "stale-confirmed",
        hasConfirmed
          ? `last_confirmed ${ref} is ${n} days old (threshold ${t})`
          : `date ${ref} is ${n} days old and there's no last_confirmed (threshold ${t})`,
      ),
    );
  }
  return out;
}

function reviewDue(ctx: DoctorContext): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const r of ctx.records) {
    if (!isLive(r)) continue;
    const v = dateField(r, "review_by");
    if (v === null || daysBetween(v, ctx.today) < 1) continue;
    out.push(finding(r.path, "review-due", `review_by ${v} has passed`));
  }
  return out;
}

function staleProposal(ctx: DoctorContext): DoctorFinding[] {
  const t = ctx.thresholds.proposal_age_days;
  const out: DoctorFinding[] = [];
  for (const r of ctx.records) {
    if (r.frontmatter.status !== "proposed") continue;
    const v = dateField(r, "date");
    if (v === null) continue;
    const n = daysBetween(v, ctx.today);
    if (n <= t) continue;
    out.push(finding(r.path, "stale-proposal", `proposed on ${v}, ${n} days ago (threshold ${t})`));
  }
  return out;
}

// Memoized per Record because enumerating every simple path is exponential once Records fork and merge.
// A Record still being walked is a dead end, which ends a chain that runs into a cycle; inside a cycle the
// length is a lower bound, since exact longest simple path is NP-hard there. Children arrive sorted by path
// and only a strictly longer branch wins, so a tie goes to the first.
function longestPath(
  from: ParsedRecord,
  olderOf: ReadonlyMap<ParsedRecord, readonly ParsedRecord[]>,
  memo: Map<ParsedRecord, readonly ParsedRecord[]>,
  walking: Set<ParsedRecord>,
): readonly ParsedRecord[] {
  const known = memo.get(from);
  if (known) return known;
  walking.add(from);
  let best: readonly ParsedRecord[] = [];
  for (const older of olderOf.get(from) ?? []) {
    if (walking.has(older)) continue;
    const sub = longestPath(older, olderOf, memo, walking);
    if (sub.length > best.length) best = sub;
  }
  walking.delete(from);
  const path = [from, ...best];
  memo.set(from, path);
  return path;
}

function longChain(ctx: DoctorContext): DoctorFinding[] {
  const t = ctx.thresholds.max_chain_length;
  const olderOf = new Map<ParsedRecord, ParsedRecord[]>();
  const isOld = new Set<ParsedRecord>();
  for (const e of ctx.edges) {
    isOld.add(e.old);
    const list = olderOf.get(e.new);
    if (list) list.push(e.old);
    else olderOf.set(e.new, [e.old]);
  }
  for (const list of olderOf.values()) list.sort((x, y) => byCodeUnit(x.path, y.path));
  const memo = new Map<ParsedRecord, readonly ParsedRecord[]>();
  const out: DoctorFinding[] = [];
  for (const head of olderOf.keys()) {
    // A closed cycle has no newest Record, so it's never walked or reported. `ltm supersede` refuses to
    // create one, but nothing reports a hand-written one. A chain that runs into a cycle still has a head.
    if (isOld.has(head)) continue;
    // A Record that supersedes several independent Records has branches, so only the longest one counts.
    const path = longestPath(head, olderOf, memo, new Set());
    if (path.length <= t) continue;
    const rest = path.slice(1).map((r) => r.path);
    out.push(finding(head.path, "long-chain", `Supersession chain holds ${path.length} Records (threshold ${t})`, rest));
  }
  return out;
}

function orphan(ctx: DoctorContext): DoctorFinding[] {
  const t = ctx.thresholds.orphan_days;
  const out: DoctorFinding[] = [];
  for (const r of ctx.records) {
    if (!isLive(r)) continue;
    const v = dateField(r, "date");
    if (v === null) continue;
    const n = daysBetween(v, ctx.today);
    if (n <= t) continue;
    const related = stringListField(r, "related");
    const supersedes = stringListField(r, "supersedes");
    const by = r.frontmatter.superseded_by;
    if (related === null || supersedes === null || !(absent(by) || typeof by === "string")) continue;
    if (related.length > 0 || supersedes.length > 0 || (typeof by === "string" && by !== "")) continue;
    if ((ctx.inbound.get(r) ?? 0) > 0) continue;
    out.push(
      finding(
        r.path,
        "orphan",
        `no related, supersedes, or superseded_by, and no Record relates to it (date ${v}, ${n} days old, threshold ${t})`,
      ),
    );
  }
  return out;
}

function brokenRelated(ctx: DoctorContext): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const r of ctx.records) {
    const related = stringListField(r, "related");
    if (related === null) continue;
    // A repeated entry is one broken link, not several.
    for (const entry of new Set(related)) {
      const id = relatedId(entry);
      if (ctx.heldIds.has(id)) continue;
      out.push(finding(r.path, "broken-related", `related entry '${entry}' names id '${id}', which no Record has`));
    }
  }
  return out;
}

function supersessionNoSharedFacet(ctx: DoctorContext): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const e of ctx.edges) {
    const a = stringListField(e.old, "applies_to");
    const b = stringListField(e.new, "applies_to");
    if (a === null || b === null) continue;
    // Disjoint non-empty lists fail sharesScope and are validate's `supersession-facets`; this check is
    // the gap it leaves, where an empty list overlaps everything yet the two name no Facet in common.
    if (!sharesScope(a, b) || a.some((x) => b.includes(x))) continue;
    out.push(
      finding(
        e.new.path,
        "supersession-no-shared-facet",
        `supersedes ${e.old.path}, but the two share no applies_to Facet`,
        [e.old.path],
      ),
    );
  }
  return out;
}

export const CHECKS: readonly { name: CheckName; run(ctx: DoctorContext): DoctorFinding[] }[] = [
  { name: "stale-confirmed", run: staleConfirmed },
  { name: "review-due", run: reviewDue },
  { name: "stale-proposal", run: staleProposal },
  { name: "long-chain", run: longChain },
  { name: "orphan", run: orphan },
  { name: "broken-related", run: brokenRelated },
  { name: "supersession-no-shared-facet", run: supersessionNoSharedFacet },
];

function buildContext(records: ParsedRecord[], today: string, thresholds: Thresholds): DoctorContext {
  const byId = new Map<string, ParsedRecord[]>();
  for (const r of records) {
    const id = r.frontmatter.id;
    if (typeof id !== "string") continue;
    const held = byId.get(id);
    if (held) held.push(r);
    else byId.set(id, [r]);
  }
  // Mirrors checkSupersession: a shared id is `unique-id`'s to report, and a link can't pick between holders.
  const resolve = (id: string): ParsedRecord | undefined => {
    const held = byId.get(id);
    return held?.length === 1 ? held[0] : undefined;
  };

  // Either side may be the one that wrote the link down, so both directions feed one deduplicated edge set.
  const edges = new Map<string, Edge>();
  const addEdge = (o: ParsedRecord, n: ParsedRecord) => {
    // A Record naming itself is malformed, not a chain; it'd otherwise report "supersedes itself".
    if (o === n) return;
    const k = `${o.path}\0${n.path}`;
    if (!edges.has(k)) edges.set(k, { old: o, new: n });
  };
  const inbound = new Map<ParsedRecord, number>();
  for (const r of records) {
    for (const id of stringListField(r, "supersedes") ?? []) {
      const target = resolve(id);
      if (target) addEdge(target, r);
    }
    const by = r.frontmatter.superseded_by;
    if (typeof by === "string" && by !== "") {
      const target = resolve(by);
      if (target) addEdge(r, target);
    }
    // Retired Records' links count: a superseded Record pointing here still ties this one into the Bank.
    for (const entry of stringListField(r, "related") ?? []) {
      const target = resolve(relatedId(entry));
      if (target && target !== r) inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }

  return {
    records,
    today,
    thresholds,
    heldIds: new Set(byId.keys()),
    edges: [...edges.values()],
    inbound,
  };
}

export function runDoctor(records: ParsedRecord[], today: string, thresholds: Thresholds): DoctorFinding[] {
  const ctx = buildContext(records, today, thresholds);
  const rank = new Map(CHECKS.map((c, i) => [c.name, i]));
  return CHECKS.flatMap((c) => c.run(ctx)).sort(
    (a, b) =>
      byCodeUnit(a.file, b.file) || rank.get(a.check)! - rank.get(b.check)! || byCodeUnit(a.message, b.message),
  );
}
