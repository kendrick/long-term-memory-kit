import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isMapping, type MemoryType } from "./bank.ts";

export type Split = { frontmatterLines: string[]; closingLine: number; body: string };

const isFence = (line: string): boolean => line === "---" || line === "---\r";

// Scans line by line instead of splitting on "\n" so `body` can be sliced from the
// original text and come back byte for byte, terminators and all.
export function splitFrontmatter(text: string): Split | null {
  const frontmatterLines: string[] = [];
  let start = 0;
  let index = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end);
    if (index === 0) {
      if (!isFence(line)) return null;
    } else if (isFence(line)) {
      return { frontmatterLines, closingLine: index, body: nl === -1 ? "" : text.slice(nl + 1) };
    } else {
      frontmatterLines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (nl === -1) return null;
    start = nl + 1;
    index++;
  }
  return null;
}

export type ParsedRecord = {
  path: string;
  memoryType: MemoryType;
  frontmatter: Record<string, unknown>;
};

export class RecordError extends Error {
  constructor(
    public path: string,
    message: string,
  ) {
    super(message);
    this.name = "RecordError";
  }
}

// `memoryType` comes from the caller (the folder), never from the frontmatter:
// the folder is the source of truth and a mismatch is #9's to report.
export function parseRecordFile(absPath: string, relPath: string, memoryType: MemoryType): ParsedRecord {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    throw new RecordError(relPath, (e as Error).message);
  }
  const split = splitFrontmatter(text);
  if (!split) throw new RecordError(relPath, "no frontmatter");
  const source = split.frontmatterLines.join("\n");
  let frontmatter: unknown;
  try {
    frontmatter = parse(source);
  } catch (e) {
    throw new RecordError(relPath, (e as Error).message.split("\n")[0] ?? "invalid YAML");
  }
  if (!isMapping(frontmatter)) throw new RecordError(relPath, "frontmatter is not a YAML mapping");
  // A recursive alias (`x: &a { self: *a }`) parses to a cyclic object that crashes
  // `--json` (#37). Refusing it here keeps every reader, `ltm mcp` included, from
  // receiving a Record it can't send.
  try {
    JSON.stringify(frontmatter);
  } catch (e) {
    const first = (e as Error).message.split("\n")[0] || "unserializable";
    throw new RecordError(relPath, `frontmatter can't be serialized: ${first}`);
  }
  const [first] = unrepresentable(source);
  if (first) throw new RecordError(relPath, `frontmatter value ${first.key} can't be represented in JSON: ${first.reason}`);
  return { path: relPath, memoryType, frontmatter };
}

export type Unrepresentable = { key: string; reason: string };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function reasonFor(value: unknown): string | null {
  if (typeof value === "bigint") return value > MAX_SAFE || value < -MAX_SAFE ? "integer outside the safe range" : null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "not a finite number";
    return Object.is(value, -0) ? "negative zero" : null;
  }
  if (value instanceof Date) return "timestamp";
  if (value instanceof Uint8Array) return "binary value";
  if (value instanceof Set) return "set";
  if (value instanceof Map) return "ordered map";
  return null;
}

// Every value reasonFor flags parses to a JS value that `JSON.stringify` rewrites without complaint (a rounded number, null, {}, an ISO string, 0 for -0.0), so `--json` would print something the Record doesn't say (#44). The value parse can't see a lost integer once it's a `number`, so this function parses again with `intAsBigInt`, apart from the parse every caller reads, where integers must stay `number`. The `intAsBigInt` parse reads an integer `-0` as `0n` and leaves it unflagged. YAML has no negative integer zero, so JSON's `0` is the same value.
export function unrepresentable(src: string): Unrepresentable[] {
  const root: unknown = parse(src, { intAsBigInt: true });
  if (!isMapping(root)) return [];
  const found: Unrepresentable[] = [];
  // A recursive alias is #37's to reject, but this is exported and may run first.
  const seen = new Set<object>();
  const walk = (key: string, value: unknown): void => {
    const reason = reasonFor(value);
    if (reason) {
      found.push({ key, reason });
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) walk(key, child);
  };
  for (const [key, value] of Object.entries(root)) walk(key, value);
  return found;
}
