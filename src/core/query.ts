import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { MEMORY_TYPES, type BankConfig, type MemoryType } from "./bank.ts";
import { parseRecordFile, RecordError, type ParsedRecord } from "./record.ts";

export type Filter = { key: string; value: string };

// Split at the first '=' so a value may itself contain '='.
export function parseFilter(arg: string): Filter | null {
  const i = arg.indexOf("=");
  if (i <= 0) return null;
  return { key: arg.slice(0, i), value: arg.slice(i + 1) };
}

const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");

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
    onSkip(toRel(root, dir), (e as Error).message?.split("\n")[0] || code || "unreadable");
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    // Dirent carries lstat's answer, so a link is caught without a second lookup by path.
    if (e.isSymbolicLink()) {
      onSkip(toRel(root, p), "symlink, not followed");
      continue;
    }
    // Bun may resolve a `\` name as a different path in readFileSync/readdirSync.
    if (e.name.includes("\\")) {
      onSkip(toRel(root, p), "name contains a backslash");
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
        onSkip(rel, (e as Error).message?.split("\n")[0] || code || "unreadable");
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

export function listRecords(
  config: BankConfig,
  onSkip: (relPath: string, reason: string) => void,
): ParsedRecord[] {
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
  const records: ParsedRecord[] = [];
  for (const { abs, rel, type } of entries) {
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
