import { readFileSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { isMap, isScalar, isSeq, parseDocument, type Document, type Pair } from "yaml";
import { ConfigError, isInside, loadConfig, type BankConfig, type MemoryType } from "./bank.ts";
import { listRecordFiles } from "./query.ts";
import { splitFrontmatter } from "./record.ts";

export type Rule =
  | "config-schema"
  | "schema"
  | "canonical-list"
  | "line-budget"
  | "folder-type"
  | "facet-prefix"
  | "unique-id"
  | "frontmatter"
  | "walk";

export type Finding = { file: string; line: number; rule: Rule; severity: "error"; key: string | null; message: string };

const CONFIG_FILE = "memory-bank.yaml";
const LINE_BUDGET = 20;
const FMT_ADDS = new Set(["id", "memory_type", "schema"]);

// Both packages are CJS, and TS under NodeNext types the default import as the whole
// `module.exports`; each also sets `exports.default` to itself, so `.default` works at runtime too.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

let recordValidator: ValidateFunction | null = null;
function recordSchema(): ValidateFunction {
  if (recordValidator) return recordValidator;
  // Strict mode otherwise logs a warning to stderr on every run for $defs/scalar's
  // `type: [...]` union; the schema is out of scope to change, so allow just that.
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(new URL("../../schema/record.schema.json", import.meta.url), "utf8"));
  recordValidator = ajv.compile(schema);
  return recordValidator;
}

const finding = (file: string, line: number, rule: Rule, key: string | null, message: string): Finding => ({
  file,
  line,
  rule,
  severity: "error",
  key,
  message,
});

const firstLine = (s: string): string => s.split("\n")[0] ?? s;

// `offset` is the file line holding the first character of `src`.
function keyLines(doc: Document, src: string, offset: number): Map<string, { line: number; pair: Pair }> {
  const out = new Map<string, { line: number; pair: Pair }>();
  if (!isMap(doc.contents)) return out;
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || !pair.key.range) continue;
    const name = String(pair.key.value);
    if (out.has(name)) continue;
    const before = src.slice(0, pair.key.range[0]);
    out.set(name, { line: offset + (before.match(/\n/g)?.length ?? 0), pair });
  }
  return out;
}

const decodePointer = (seg: string): string => seg.replace(/~1/g, "/").replace(/~0/g, "~");

function errorKey(e: ErrorObject): string | null {
  if (e.keyword === "required") return String(e.params.missingProperty);
  if (e.keyword === "additionalProperties") return String(e.params.additionalProperty);
  const seg = e.instancePath.split("/")[1];
  return seg === undefined || seg === "" ? null : decodePointer(seg);
}

type RecordResult = { findings: Finding[]; id: string | null; idLine: number };

function analyzeRecord(rel: string, folderType: MemoryType, text: string, facetPrefixes: string[] | null): RecordResult {
  const findings: Finding[] = [];
  const split = splitFrontmatter(text);
  if (!split) {
    findings.push(
      finding(rel, 1, "frontmatter", null, "no frontmatter block (expected --- on line 1 and a closing ---)"),
    );
    return { findings, id: null, idLine: 1 };
  }
  const src = split.frontmatterLines.join("\n");
  const doc = parseDocument(src);
  const err = doc.errors[0];
  if (err) {
    findings.push(finding(rel, 1 + (err.linePos?.[0]?.line ?? 0), "frontmatter", null, firstLine(err.message)));
    return { findings, id: null, idLine: 1 };
  }
  if (!isMap(doc.contents)) {
    findings.push(finding(rel, 1, "frontmatter", null, "frontmatter is not a YAML mapping"));
    return { findings, id: null, idLine: 1 };
  }
  const keys = keyLines(doc, src, 2);
  const lineOf = (k: string | null): number => (k === null ? 1 : (keys.get(k)?.line ?? 1));
  const data = doc.toJS() as Record<string, unknown>;

  const validate = recordSchema();
  if (!validate(data)) {
    for (const e of validate.errors ?? []) {
      const key = errorKey(e);
      let message = e.message ?? e.keyword;
      if (e.keyword === "required" && key !== null && FMT_ADDS.has(key)) message += "; `ltm fmt` will add it";
      findings.push(finding(rel, lineOf(key), "schema", key, message));
    }
  }

  for (const [name, { line, pair }] of keys) {
    const v = pair.value;
    if (!isSeq(v)) continue;
    const multiline = v.range ? src.slice(v.range[0], v.range[1]).includes("\n") : false;
    if (v.flow && !multiline) continue;
    const items = v.items.filter(isScalar).map((i) => String(i.value)).join(", ");
    findings.push(finding(rel, line, "canonical-list", name, `${name} must be a single-line list, e.g. \`${name}: [${items}]\``));
  }

  const closing = split.closingLine + 1;
  if (closing > LINE_BUDGET) {
    findings.push(finding(rel, closing, "line-budget", null, `frontmatter closes on line ${closing}; the budget is ${LINE_BUDGET}`));
  }

  const written = data.memory_type;
  if (typeof written === "string" && written !== folderType) {
    findings.push(
      finding(
        rel,
        lineOf("memory_type"),
        "folder-type",
        "memory_type",
        `memory_type is '${written}' but the file is in the ${folderType} folder (${posix.dirname(rel)})`,
      ),
    );
  }

  if (facetPrefixes) {
    const known = new Set(facetPrefixes);
    for (const key of ["applies_to", "owners"]) {
      const list = data[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry !== "string") continue;
        const i = entry.indexOf(":");
        if (i < 0) continue;
        const prefix = entry.slice(0, i);
        if (known.has(prefix)) continue;
        findings.push(
          finding(rel, lineOf(key), "facet-prefix", key, `'${entry}' uses prefix '${prefix}', which facet_prefixes doesn't list`),
        );
      }
    }
  }

  const id = typeof data.id === "string" ? data.id : null;
  return { findings, id, idLine: lineOf("id") };
}

export function checkRecordText(
  rel: string,
  folderType: MemoryType,
  text: string,
  facetPrefixes: string[] | null,
): { findings: Finding[]; id: string | null } {
  const { findings, id } = analyzeRecord(rel, folderType, text, facetPrefixes);
  return { findings, id };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function checkUniqueIds(ids: { file: string; line: number; id: string }[], named: Set<string> | null): Finding[] {
  const groups = new Map<string, { file: string; line: number }[]>();
  for (const { file, line, id } of ids) {
    const g = groups.get(id);
    if (g) g.push({ file, line });
    else groups.set(id, [{ file, line }]);
  }
  const out: Finding[] = [];
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    if (named && !group.some((g) => named.has(g.file))) continue;
    group.sort((a, b) => cmp(a.file, b.file));
    const [first, ...rest] = group;
    out.push(finding(first!.file, first!.line, "unique-id", "id", `id '${id}' is also used by ${rest.map((r) => r.file).join(", ")}`));
  }
  return out;
}

// Config-schema findings are Task 2's (#9); this covers only what loadConfig itself refuses,
// since without a config the type folders, and so every Record, are unknown.
export function checkConfig(root: string): { findings: Finding[]; config: BankConfig | null } {
  try {
    return { findings: [], config: loadConfig(root) };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { findings: [finding(CONFIG_FILE, e.line ?? 1, "config-schema", null, firstLine(e.message))], config: null };
  }
}

function sortFindings(fs: Finding[]): Finding[] {
  const keyCmp = (a: string | null, b: string | null): number =>
    a === b ? 0 : a === null ? -1 : b === null ? 1 : cmp(a, b);
  return fs.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.rule, b.rule) || keyCmp(a.key, b.key));
}

const toPosix = (p: string): string => p.split(sep).join("/");

export function validateBank(root: string, paths: string[] | null, cwd: string): Finding[] {
  const bankRoot = resolve(root);
  const { findings, config } = checkConfig(bankRoot);
  if (!config) return sortFindings(findings);

  const named = paths
    ? paths.map((p) => {
        const abs = resolve(cwd, p);
        return { abs, rel: isInside(bankRoot, abs) ? toPosix(relative(bankRoot, abs)) : p };
      })
    : null;
  const namedRels = named ? new Set(named.map((n) => n.rel)) : null;
  // A skipped directory hides every named file beneath it, so it counts as named too.
  const touchesNamed = (rel: string): boolean =>
    !namedRels || [...namedRels].some((n) => n === rel || n.startsWith(`${rel}/`));

  const skipped = new Set<string>();
  const files = listRecordFiles(config, (rel, reason) => {
    skipped.add(rel);
    if (touchesNamed(rel)) findings.push(finding(rel, 1, "walk", null, reason));
  });

  if (named) {
    const known = new Set(files.map((f) => resolve(f.abs)));
    for (const n of named) {
      if (known.has(n.abs) || skipped.has(n.rel)) continue;
      findings.push(finding(n.rel, 1, "walk", null, "not a Record file under any configured type folder"));
    }
  }

  const raw = config.raw.facet_prefixes;
  const prefixes = Array.isArray(raw) && raw.every((x) => typeof x === "string") ? (raw as string[]) : null;

  const ids: { file: string; line: number; id: string }[] = [];
  // Every Record is read even when paths are named: a duplicate id may live in a file nobody named.
  for (const f of files) {
    const isNamed = !namedRels || namedRels.has(f.rel);
    let text: string;
    try {
      text = readFileSync(f.abs, "utf8");
    } catch (e) {
      if (isNamed) findings.push(finding(f.rel, 1, "walk", null, firstLine((e as Error).message)));
      continue;
    }
    const r = analyzeRecord(f.rel, f.type, text, prefixes);
    if (isNamed) findings.push(...r.findings);
    if (r.id !== null) ids.push({ file: f.rel, line: r.idLine, id: r.id });
  }
  findings.push(...checkUniqueIds(ids, namedRels));
  return sortFindings(findings);
}
