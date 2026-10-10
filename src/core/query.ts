import { readdirSync } from "node:fs";
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

function walkMarkdown(dir: string, into: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A Bank needn't have every type's folder; a missing one just holds no Records.
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(p, into);
    else if (e.isFile() && e.name.endsWith(".md")) into.push(p);
  }
}

const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");

export function listRecords(
  config: BankConfig,
  onSkip: (relPath: string, reason: string) => void,
): ParsedRecord[] {
  // A file under nested configured folders belongs to the deepest one, so keep the
  // owner with the longest folder path rather than whichever type walked it first.
  const owner = new Map<string, { type: MemoryType; depth: number }>();
  for (const type of MEMORY_TYPES) {
    const folderAbs = resolve(config.root, config.folders[type]);
    const depth = folderAbs.length;
    const files: string[] = [];
    walkMarkdown(folderAbs, files);
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
      onSkip(rel, e.message);
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
