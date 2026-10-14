import { readFileSync } from "node:fs";
import { type Document, isAlias, isMap, isScalar, isSeq, parse, parseDocument } from "yaml";
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
  if (first) {
    const subject = first.key === null ? "frontmatter" : `frontmatter value ${first.key}`;
    throw new RecordError(relPath, `${subject} can't be represented in JSON: ${first.reason}`);
  }
  return { path: relPath, memoryType, frontmatter };
}

export type Unrepresentable = { key: string | null; reason: string };

const MERGE_TAG = "tag:yaml.org,2002:merge";

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

const CORE_DECIMAL = /^([-+]?)(\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE]([-+]?[0-9]+))?$/;

// Works on digit strings, because a float round trip is the thing under test and converting through Number would hide the rounding.
function decimalParts(text: string): { negative: boolean; digits: string; exponent: bigint } | null {
  const m = CORE_DECIMAL.exec(text);
  if (!m) return null;
  const [, sign, mantissa, exp] = m as unknown as [string, string, string, string | undefined];
  const [whole = "", frac = ""] = mantissa.split(".");
  const trimmedLead = (whole + frac).replace(/^0+/, "");
  const digits = trimmedLead.replace(/0+$/, "");
  if (digits === "") return { negative: false, digits: "", exponent: 0n };
  const exponent = BigInt(exp ?? "0") - BigInt(frac.length) + BigInt(trimmedLead.length - digits.length);
  return { negative: sign === "-", digits, exponent };
}

function roundedOnParse(source: string, value: number): boolean {
  const written = decimalParts(source);
  const held = decimalParts(JSON.stringify(value));
  if (!written || !held) return false;
  return written.negative !== held.negative || written.digits !== held.digits || written.exponent !== held.exponent;
}

// `visiting` stops a self-referencing alias (`a: &a [1, *a]`) from recursing forever.
function hasRoundedScalar(node: unknown, doc: Document, visiting: Set<unknown> = new Set()): boolean {
  if (isAlias(node)) {
    // An alias can point at an anchor declared on a mapping key, which the pair.value walk never reaches.
    return hasRoundedScalar(node.resolve(doc), doc, visiting);
  }
  if (isScalar(node)) {
    const { value, source } = node;
    return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) && typeof source === "string" && roundedOnParse(source, value);
  }
  if (!isMap(node) && !isSeq(node)) return false;
  if (visiting.has(node)) return false;
  visiting.add(node);
  if (isMap(node)) return node.items.some((pair) => hasRoundedScalar(pair.value, doc, visiting));
  return node.items.some((item) => hasRoundedScalar(item, doc, visiting));
}

// Every value reasonFor flags parses to a JS value that `JSON.stringify` rewrites without complaint (a rounded number, null, {}, an ISO string, 0 for -0.0), so `--json` would print something the Record doesn't say (#44). The value parse can't see a lost integer once it's a `number`, so this function parses again with `intAsBigInt`, apart from the parse every caller reads, where integers must stay `number`. The `intAsBigInt` parse reads an integer `-0` as `0n` and leaves it unflagged. YAML has no negative integer zero, so JSON's `0` is the same value. A float spelling (`9007199254740993.0`) is rounded before either parse returns, so the only trace is the scalar's source text, which the document walk compares digit for digit against the number JSON would print.
export function unrepresentable(src: string): Unrepresentable[] {
  const root: unknown = parse(src, { intAsBigInt: true });
  // isMapping accepts any non-array object, so a root !!set or !!timestamp would otherwise walk as an empty mapping and pass.
  const rootReason = reasonFor(root);
  if (rootReason) return [{ key: null, reason: rootReason }];
  if (!isMapping(root)) return [];
  const doc = parseDocument(src);
  const nodes = new Map<string, unknown>();
  if (isMap(doc.contents)) for (const pair of doc.contents.items) nodes.set(String(isScalar(pair.key) ? pair.key.value : pair.key), pair.value);
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
  for (const [key, value] of Object.entries(root)) {
    const before = found.length;
    walk(key, value);
    if (found.length === before && hasRoundedScalar(nodes.get(key), doc)) found.push({ key, reason: "number rounded on parse" });
  }
  // The loop above looks nodes up by name, which misses root keys the JS parse renames (an alias key, `~`, a collection key), so those pairs are checked by position.
  if (isMap(doc.contents)) {
    const rootKeys = new Set(Object.keys(root));
    for (const pair of doc.contents.items) {
      if (isScalar(pair.key) && pair.key.tag === MERGE_TAG) continue;
      const lookup = String(isScalar(pair.key) ? pair.key.value : pair.key);
      if (rootKeys.has(lookup) || !hasRoundedScalar(pair.value, doc)) continue;
      const trimmed = String(pair.key).trim();
      const name = trimmed === "" || trimmed === "null" ? "~" : trimmed;
      if (!found.some((f) => f.key === name)) found.push({ key: name, reason: "number rounded on parse" });
    }
  }
  // A `!!merge <<:` pair spreads its value into the root, so the merged-in keys have no node of their own for the loop above. Only the tagged form merges; an untagged `<<` is an ordinary key.
  if (isMap(doc.contents) && !found.some((f) => f.key === "<<")) {
    const merged = doc.contents.items.some((pair) => isScalar(pair.key) && pair.key.tag === MERGE_TAG && hasRoundedScalar(pair.value, doc));
    if (merged) found.push({ key: "<<", reason: "number rounded on parse" });
  }
  return found;
}
