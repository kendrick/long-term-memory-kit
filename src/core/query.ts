import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { MEMORY_TYPES, type BankConfig, type MemoryType } from "./bank.ts";
import { search } from "./recall.ts";
import { parseRecordFile, RecordError, type ParsedRecord } from "./record.ts";
import { firstLine } from "./text.ts";

export type Filter = { key: string; value: string };

// Split at the first '=' so a value may itself contain '='.
export function parseFilter(arg: string): Filter | null {
  const i = arg.indexOf("=");
  if (i <= 0) return null;
  return { key: arg.slice(0, i), value: arg.slice(i + 1) };
}

const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");

// A non-.md link can't be a Record, so only one that reaches a directory is worth reporting
// (it could hide Records). statSync resolves the link only to learn the target's type; nothing
// behind it is read or descended into. A dangling link holds nothing; any other error can't
// rule a directory out.
function linkMayHoldRecords(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return !(code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP");
  }
}

function walkMarkdown(
  dir: string,
  into: string[],
  root: string,
  onSkip: (relPath: string, reason: string) => void,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // A Bank needn't have every type's folder; a missing one just holds no Records.
    // Anything else (EACCES, EIO) would silently drop matches, so surface it.
    if (code === "ENOENT" || code === "ENOTDIR") return;
    onSkip(toRel(root, dir), firstLine((e as Error).message ?? "") || code || "unreadable");
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    // Bun may resolve a `\` name as a different path in stat/readFileSync/readdirSync, so such an
    // entry is reported without any lookup. Dirent carries lstat's answer for links.
    if (e.name.includes("\\")) {
      onSkip(toRel(root, p), e.isSymbolicLink() ? "symlink, not followed" : "name contains a backslash");
      continue;
    }
    if (e.isSymbolicLink()) {
      if (e.name.endsWith(".md") || linkMayHoldRecords(p)) onSkip(toRel(root, p), "symlink, not followed");
      continue;
    }
    if (e.isDirectory()) walkMarkdown(p, into, root, onSkip);
    else if (e.isFile() && e.name.endsWith(".md")) into.push(p);
  }
}

// Git keeps symlinks, so a cloned Bank can link a type folder or its parent outside the
// root. Each component is lstat'd and no link is followed, because Bun 1.3.13's real-path
// resolver reads `\` as a separator: for a literal entry `q\z` it throws ENOENT, or returns
// `<bank>/q/z` when that dir exists, while readdir and Node see the link's target. A
// containment check built on it can't be trusted.
function folderIsWalkable(
  root: string,
  folderAbs: string,
  onSkip: (relPath: string, reason: string) => void,
): boolean {
  const parts = relative(root, folderAbs).split(sep).filter((x) => x !== "");
  let p = root;
  for (let i = 0; i < parts.length; i++) {
    p = join(p, parts[i]!);
    const rel = parts.slice(0, i + 1).join("/");
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Same rule as walkMarkdown: missing is silent, anything else would drop matches unseen.
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        onSkip(rel, firstLine((e as Error).message ?? "") || code || "unreadable");
      }
      return false;
    }
    if (st.isSymbolicLink()) {
      onSkip(rel, "symlink, not followed");
      return false;
    }
    if (!st.isDirectory()) return false;
  }
  return true;
}

export type RecordFile = { abs: string; rel: string; type: MemoryType };

// The walk alone, unparsed, for callers like `ltm validate` that read each file's own
// text and judge parse failures themselves rather than skipping them.
export function listRecordFiles(
  config: BankConfig,
  onSkip: (relPath: string, reason: string) => void,
): RecordFile[] {
  // A file under nested configured folders belongs to the deepest one, so keep the
  // owner with the longest folder path rather than whichever type walked it first.
  const owner = new Map<string, { type: MemoryType; depth: number }>();
  // Types share parents (`_memory`) and may nest, so the same path can come up more than once.
  const reported = new Set<string>();
  const skip = (relPath: string, reason: string) => {
    const key = `${relPath}\0${reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    onSkip(relPath, reason);
  };
  for (const type of MEMORY_TYPES) {
    const folderAbs = resolve(config.root, config.folders[type]);
    const depth = folderAbs.length;
    const files: string[] = [];
    if (!folderIsWalkable(config.root, folderAbs, skip)) continue;
    walkMarkdown(folderAbs, files, config.root, skip);
    for (const abs of files) {
      const prev = owner.get(abs);
      if (!prev || depth > prev.depth) owner.set(abs, { type, depth });
    }
  }
  const entries = [...owner].map(([abs, { type }]) => ({ abs, rel: toRel(config.root, abs), type }));
  // Plain code-unit comparison, not localeCompare, so order doesn't vary by locale.
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

export function listRecords(
  config: BankConfig,
  onSkip: (relPath: string, reason: string) => void,
): ParsedRecord[] {
  const reported = new Set<string>();
  const skip = (relPath: string, reason: string) => {
    const key = `${relPath}\0${reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    onSkip(relPath, reason);
  };
  const records: ParsedRecord[] = [];
  for (const { abs, rel, type } of listRecordFiles(config, skip)) {
    try {
      records.push(parseRecordFile(abs, rel, type));
    } catch (e) {
      if (!(e instanceof RecordError)) throw e;
      skip(rel, e.message);
    }
  }
  return records;
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function fieldMatches(field: unknown, value: string): boolean {
  if (isScalar(field)) return String(field) === value;
  if (Array.isArray(field)) return field.some((x) => isScalar(x) && String(x) === value);
  return false;
}

export function matches(record: ParsedRecord, filters: Filter[]): boolean {
  return filters.every(({ key, value }) => {
    // The folder decides memory_type; the frontmatter's copy may have drifted.
    if (key === "memory_type") return record.memoryType === value;
    if (!Object.hasOwn(record.frontmatter, key)) return false;
    return fieldMatches(record.frontmatter[key], value);
  });
}

export const RETIRED_STATUSES: readonly string[] = ["superseded", "deprecated", "rejected"];

const isRetired = (r: ParsedRecord): boolean =>
  typeof r.frontmatter.status === "string" && RETIRED_STATUSES.includes(r.frontmatter.status);

export type QueryOptions = {
  filters: Filter[];
  type?: MemoryType;
  statuses: string[];
  facets: string[];
  text?: string;
  all: boolean;
};

// A string `applies_to` is a hand-edited one-entry list, and `null` is org-wide like a
// missing key. Any other shape is malformed; reading that as org-wide would leak the
// Record into every Facet.
function appliesTo(r: ParsedRecord): string[] | "org-wide" | null {
  const v = r.frontmatter.applies_to;
  if (v === undefined || v === null) return "org-wide";
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return "org-wide";
  return v.filter((x): x is string => typeof x === "string");
}

export function isOrgWide(r: ParsedRecord): boolean {
  return appliesTo(r) === "org-wide";
}

function inFacets(r: ParsedRecord, facets: string[]): boolean {
  const scope = appliesTo(r);
  if (scope === "org-wide") return true;
  if (scope === null) return false;
  return scope.some((f) => facets.includes(f));
}

// Selection order lives only here, so `ltm query` and `ltm mcp` (#19) can't drift apart.
export function selectRecords(records: ParsedRecord[], opts: QueryOptions): ParsedRecord[] {
  // Naming a retired status asks to see retired Records. The status checks below still
  // apply, so `--status accepted` never lets a retired Record through.
  const wantsRetired =
    opts.all ||
    opts.statuses.some((s) => RETIRED_STATUSES.includes(s)) ||
    opts.filters.some((f) => f.key === "status" && RETIRED_STATUSES.includes(f.value));
  let out = records.filter(
    (r) =>
      (wantsRetired || !isRetired(r)) &&
      matches(r, opts.filters) &&
      (opts.type === undefined || r.memoryType === opts.type) &&
      (opts.statuses.length === 0 ||
        (typeof r.frontmatter.status === "string" && opts.statuses.includes(r.frontmatter.status))) &&
      (opts.facets.length === 0 || inFacets(r, opts.facets)),
  );
  if (opts.text !== undefined) out = search(out, opts.text).map((h) => h.record);
  return out;
}

export function countFacets(records: ParsedRecord[], all: boolean): { facet: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (!all && isRetired(r)) continue;
    const scope = appliesTo(r);
    if (scope === "org-wide" || scope === null) continue;
    for (const f of new Set(scope)) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts]
    .map(([facet, count]) => ({ facet, count }))
    .sort((a, b) => (a.facet < b.facet ? -1 : a.facet > b.facet ? 1 : 0));
}
