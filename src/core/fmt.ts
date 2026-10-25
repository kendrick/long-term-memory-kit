import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Document, isNode, isPair, isScalar, parseDocument, visit } from "yaml";
import { isMapping, type MemoryType } from "./bank.ts";
import { canonicalFrontmatter, canonicalScalar, SCHEMA_KEY_ORDER, type Refusal } from "./canonical.ts";
import { splitFrontmatter } from "./record.ts";
import { firstLine } from "./text.ts";

// Warnings carry no `ltm fmt: warning: <path>: ` prefix: this module never sees a
// path, so the CLI prepends it.
export type FmtResult = { text: string; changed: boolean; warnings: string[] } | Refusal;

export type FmtContext = {
  folderType: MemoryType;
  statusAliases: string[];
  takenIds: Set<string>;
};

// Read from the schema for the same reason canonical.ts reads key order from it: a new
// status shouldn't need a second edit here.
const STATUSES: ReadonlySet<string> = new Set(
  (JSON.parse(readFileSync(new URL("../../schema/record.schema.json", import.meta.url), "utf8")) as {
    properties: { status: { enum: string[] } };
  }).properties.status.enum,
);
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

// Adds the id it returns to `taken`. The CLI calls this once per Record and needs ids
// unique across the whole run, so the set has to grow as ids are handed out; doing it
// here means no caller can forget. The caller still seeds `taken` with the Bank's ids.
export function newId(taken: Set<string>): string {
  for (;;) {
    const bytes = randomBytes(10);
    let id = "";
    // 64 symbols, so `& 63` maps bytes evenly with no modulo bias.
    for (const b of bytes) id += ID_ALPHABET[b & 63];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

function headingText(line: string): string | null {
  const m = ATX.exec(line);
  if (!m) return null;
  // CommonMark's optional closing sequence (`## Status ##`) isn't part of the text.
  return (m[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
}

export function liftStatus(body: string, aliases: string[]): { status: string | null; word: string | null } {
  const names = new Set(["status", ...aliases.map((a) => a.trim().toLowerCase())]);
  const lines = body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  let fence: { char: string; len: number } | null = null;
  let inStatus = false;
  for (const line of lines) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string can't hold a backtick (CommonMark 4.5).
    if (open && !(open[1]!.startsWith("`") && open[2]!.includes("`"))) {
      if (inStatus) return wordResult(line);
      fence = { char: open[1]![0]!, len: open[1]!.length };
      continue;
    }
    const heading = headingText(line);
    if (inStatus) {
      // The section ended before any text, so there's no word to judge.
      if (heading !== null) return { status: null, word: null };
      if (line.trim() !== "") return wordResult(line);
      continue;
    }
    if (heading !== null && names.has(heading.toLowerCase())) inStatus = true;
  }
  return { status: null, word: null };
}

function wordResult(line: string): { status: string | null; word: string } {
  const word = (line.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[.,;:]+$/, "");
  return { status: STATUSES.has(word) ? word : null, word };
}

const isFenceLine = (line: string): boolean => line === "---" || line === "---\r";

function firstLineWithEol(text: string): { line: string; eol: "\n" | "\r\n" } {
  const nl = text.indexOf("\n");
  if (nl === -1) return { line: text, eol: "\n" };
  const line = text.slice(0, nl);
  return { line, eol: line.endsWith("\r") ? "\r\n" : "\n" };
}

// Canonical output re-emits a number from its parsed value, so `id: 0123` would come
// back as `123` and a 20-digit integer would lose digits, both with exit 0. Refuse
// any number whose source spelling isn't already canonical. Booleans and nulls are
// left to fmt: `True` and `~` respell as `true` and `null` with nothing lost.
function nonCanonicalNumber(doc: Document, yaml: string): Refusal | null {
  let refusal: Refusal | null = null;
  visit(doc, {
    Scalar(key, node, path) {
      if (typeof node.value !== "number" || !node.range) return undefined;
      const source = yaml.slice(node.range[0], node.range[1]);
      // canonicalScalar only looks at inFlow for strings.
      const canonical = canonicalScalar(node.value, false);
      if (canonical === source || typeof canonical !== "string") return undefined;
      const pair = [...path].reverse().find(isPair);
      const owner = key === "key" ? "key" : isScalar(pair?.key) ? String(pair.key.value) : "value";
      refusal = { reason: `${owner}: '${source}' would be rewritten as '${canonical}'; quote it or write it canonically` };
      return visit.BREAK;
    },
  });
  return refusal;
}

function parseFrontmatter(yaml: string): { data: Record<string, unknown> } | Refusal {
  const doc = parseDocument(yaml, { logLevel: "error" });
  if (doc.errors.length > 0) {
    return { reason: `invalid YAML: ${firstLine(doc.errors[0]!.message)}` };
  }
  // Canonical output has nowhere to put a comment, so rewriting would silently drop it.
  let commented = Boolean(doc.commentBefore || doc.comment);
  if (!commented) {
    visit(doc, (_key, node) => {
      if (isNode(node) && (node.commentBefore || node.comment)) {
        commented = true;
        return visit.BREAK;
      }
      return undefined;
    });
  }
  if (commented) return { reason: "frontmatter holds a YAML comment, which fmt can't keep" };
  const numeric = nonCanonicalNumber(doc, yaml);
  if (numeric) return numeric;
  // Empty frontmatter between two fences is as fillable as none at all.
  if (doc.contents === null) return { data: {} };
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (e) {
    return { reason: `frontmatter can't be expanded: ${firstLine((e as Error).message)}` };
  }
  if (!isMapping(data)) return { reason: "frontmatter is not a YAML mapping" };
  return { data };
}

export function formatRecordText(text: string, ctx: FmtContext): FmtResult {
  // A BOM hides the opening fence from splitFrontmatter, so the file would read as
  // having none and get a second block stacked on top of the real one.
  if (text.startsWith("\uFEFF")) return { reason: "file starts with a byte order mark" };

  const split = splitFrontmatter(text);
  let data: Record<string, unknown>;
  let body: string;
  let eol: "\n" | "\r\n";
  let closingEol: boolean;
  if (split) {
    const parsed = parseFrontmatter(split.frontmatterLines.join("\n"));
    if ("reason" in parsed) return parsed;
    data = parsed.data;
    body = split.body;
    eol = firstLineWithEol(text).eol;
    // `body` is empty both for `---\n` and for a bare `---` at EOF; only the text's
    // last byte tells which one the closing fence was.
    closingEol = body !== "" || text.endsWith("\n");
  } else {
    if (isFenceLine(firstLineWithEol(text).line)) return { reason: "unterminated frontmatter" };
    data = {};
    body = text;
    eol = firstLineWithEol(text).eol;
    closingEol = true;
  }

  const warnings: string[] = [];
  const filled: Record<string, unknown> = { ...data };
  if (!Object.hasOwn(filled, "schema")) filled.schema = 1;
  if (!Object.hasOwn(filled, "memory_type")) {
    filled.memory_type = ctx.folderType;
  } else if (filled.memory_type !== ctx.folderType) {
    warnings.push(`memory_type is '${String(filled.memory_type)}' but the file is in the ${ctx.folderType} folder`);
  }
  if (!Object.hasOwn(filled, "status")) {
    const lifted = liftStatus(body, ctx.statusAliases);
    if (lifted.status !== null) filled.status = lifted.status;
    else if (lifted.word !== null) warnings.push(`## Status word '${lifted.word}' is not a status; nothing lifted`);
  }

  // Probe with a placeholder id so a refusal never burns a real one into takenIds.
  const needsId = !Object.hasOwn(filled, "id");
  if (needsId) filled.id = "x";
  const probe = canonicalFrontmatter(filled, SCHEMA_KEY_ORDER, eol);
  if (typeof probe !== "string") return probe;
  if (needsId) filled.id = newId(ctx.takenIds);
  const lines = needsId ? canonicalFrontmatter(filled, SCHEMA_KEY_ORDER, eol) : probe;
  if (typeof lines !== "string") return lines;

  const out = `---${eol}${lines}---${closingEol ? eol : ""}${body}`;
  return { text: out, changed: out !== text, warnings };
}
