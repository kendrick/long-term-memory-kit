import { readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
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
const KEYS_LTM_FMT_FILLS = new Set(["id", "memory_type", "schema"]);

// Both packages are CJS, and TS under NodeNext types the default import as the whole
// `module.exports`; each also sets `exports.default` to itself, so `.default` works at runtime too.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const compiled = new Map<string, ValidateFunction>();
function compileSchema(file: string): ValidateFunction {
  const hit = compiled.get(file);
  if (hit) return hit;
  // Strict mode otherwise logs a warning to stderr on every run for $defs/scalar's
  // `type: [...]` union; the schema is out of scope to change, so allow just that.
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(new URL(`../../schema/${file}`, import.meta.url), "utf8"));
  const validate = ajv.compile(schema);
  compiled.set(file, validate);
  return validate;
}

const recordSchema = (): ValidateFunction => compileSchema("record.schema.json");
const configSchema = (): ValidateFunction => compileSchema("memory-bank.schema.json");

const finding = (file: string, line: number, rule: Rule, key: string | null, message: string): Finding => ({
  file,
  line,
  rule,
  severity: "error",
  key,
  message,
});

const firstLine = (s: string): string => s.split("\n")[0] ?? s;

type KeyLines = Map<string, { line: number; pair: Pair }>;

function keyLines(doc: Document, src: string, srcStartLine: number): KeyLines {
  const out: KeyLines = new Map();
  if (!isMap(doc.contents)) return out;
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || !pair.key.range) continue;
    const name = String(pair.key.value);
    if (out.has(name)) continue;
    const before = src.slice(0, pair.key.range[0]);
    out.set(name, { line: srcStartLine + (before.match(/\n/g)?.length ?? 0), pair });
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

type Frontmatter = {
  rel: string;
  src: string;
  closingLine: number;
  keys: KeyLines;
  data: Record<string, unknown>;
  lineOf: (key: string | null) => number;
};

// Parse failures are findings too, but every later check needs the parsed mapping, so
// this one hands back either its findings or the Frontmatter, never both.
function checkFrontmatter(rel: string, text: string): { findings: Finding[]; fm: Frontmatter | null } {
  const fail = (line: number, message: string) => ({ findings: [finding(rel, line, "frontmatter", null, message)], fm: null });
  const split = splitFrontmatter(text);
  if (!split) return fail(1, "no frontmatter block (expected --- on line 1 and a closing ---)");
  const src = split.frontmatterLines.join("\n");
  const doc = parseDocument(src);
  const err = doc.errors[0];
  if (err) return fail(1 + (err.linePos?.[0]?.line ?? 0), firstLine(err.message));
  if (!isMap(doc.contents)) return fail(1, "frontmatter is not a YAML mapping");
  const keys = keyLines(doc, src, 2);
  const lineOf = (k: string | null): number => (k === null ? 1 : (keys.get(k)?.line ?? 1));
  let data: Record<string, unknown>;
  try {
    // A source that parses cleanly can still blow yaml's alias limit on expansion.
    data = doc.toJS() as Record<string, unknown>;
  } catch (e) {
    return fail(1, firstLine((e as Error).message));
  }
  return { findings: [], fm: { rel, src, closingLine: split.closingLine, keys, data, lineOf } };
}

function checkSchema({ rel, data, lineOf }: Frontmatter): Finding[] {
  const validate = recordSchema();
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => {
    const key = errorKey(e);
    let message = e.message ?? e.keyword;
    if (e.keyword === "required" && key !== null && KEYS_LTM_FMT_FILLS.has(key)) message += "; `ltm fmt` will add it";
    return finding(rel, lineOf(key), "schema", key, message);
  });
}

function checkCanonicalLists({ rel, src, keys }: Frontmatter): Finding[] {
  const out: Finding[] = [];
  for (const [name, { line, pair }] of keys) {
    const v = pair.value;
    if (!isSeq(v)) continue;
    const multiline = v.range ? src.slice(v.range[0], v.range[1]).includes("\n") : false;
    if (v.flow && !multiline) continue;
    const items = v.items.filter(isScalar).map((i) => String(i.value)).join(", ");
    out.push(finding(rel, line, "canonical-list", name, `${name} must be a single-line list, e.g. \`${name}: [${items}]\``));
  }
  return out;
}

function checkLineBudget({ rel, closingLine }: Frontmatter): Finding[] {
  const closing = closingLine + 1;
  if (closing <= LINE_BUDGET) return [];
  return [finding(rel, closing, "line-budget", null, `frontmatter closes on line ${closing}; the budget is ${LINE_BUDGET}`)];
}

function checkFolderType({ rel, data, lineOf }: Frontmatter, folderType: MemoryType): Finding[] {
  const written = data.memory_type;
  if (typeof written !== "string" || written === folderType) return [];
  return [
    finding(
      rel,
      lineOf("memory_type"),
      "folder-type",
      "memory_type",
      `memory_type is '${written}' but the file is in the ${folderType} folder (${posix.dirname(rel)})`,
    ),
  ];
}

function checkFacetPrefixes({ rel, data, lineOf }: Frontmatter, known: ReadonlySet<string> | null): Finding[] {
  if (!known) return [];
  const out: Finding[] = [];
  for (const key of ["applies_to", "owners"]) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const i = entry.indexOf(":");
      if (i < 0) continue;
      const prefix = entry.slice(0, i);
      if (known.has(prefix)) continue;
      out.push(finding(rel, lineOf(key), "facet-prefix", key, `'${entry}' uses prefix '${prefix}', which facet_prefixes doesn't list`));
    }
  }
  return out;
}

type RecordResult = { findings: Finding[]; id: string | null; idLine: number };

function analyzeRecord(
  rel: string,
  folderType: MemoryType,
  text: string,
  facetPrefixes: ReadonlySet<string> | null,
): RecordResult {
  const { findings, fm } = checkFrontmatter(rel, text);
  if (!fm) return { findings, id: null, idLine: 1 };
  findings.push(
    ...checkSchema(fm),
    ...checkCanonicalLists(fm),
    ...checkLineBudget(fm),
    ...checkFolderType(fm, folderType),
    ...checkFacetPrefixes(fm, facetPrefixes),
  );
  const id = typeof fm.data.id === "string" ? fm.data.id : null;
  return { findings, id, idLine: fm.lineOf("id") };
}

export function checkRecordText(
  rel: string,
  folderType: MemoryType,
  text: string,
  facetPrefixes: string[] | null,
): { findings: Finding[]; id: string | null } {
  const { findings, id } = analyzeRecord(rel, folderType, text, facetPrefixes && new Set(facetPrefixes));
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
    group.sort((a, b) => cmp(a.file, b.file));
    // A filtered run must not report against a file the caller didn't name.
    const at = named ? group.find((g) => named.has(g.file)) : group[0];
    if (!at) continue;
    const rest = group.filter((g) => g !== at).map((g) => g.file);
    out.push(finding(at.file, at.line, "unique-id", "id", `id '${id}' is also used by ${rest.join(", ")}`));
  }
  return out;
}

export function checkConfig(root: string): { findings: Finding[]; config: BankConfig | null } {
  let config: BankConfig;
  try {
    config = loadConfig(root);
  } catch (e) {
    // loadConfig lets yaml's alias-limit ReferenceError through unwrapped; anything else is a bug, not a bad config.
    if (!(e instanceof ConfigError) && !(e instanceof ReferenceError)) throw e;
    // Without a config, every Record's type folder is unknown.
    const line = e instanceof ConfigError ? (e.line ?? 1) : 1;
    return { findings: [finding(CONFIG_FILE, line, "config-schema", null, firstLine(e.message))], config: null };
  }

  const findings: Finding[] = [];
  const validate = configSchema();
  if (!validate(config.raw)) {
    const src = readFileSync(join(root, CONFIG_FILE), "utf8");
    // Config line 1 is the file's first line; Records start their frontmatter at line 2.
    const keys = keyLines(parseDocument(src), src, 1);
    for (const e of validate.errors ?? []) {
      const key = errorKey(e);
      findings.push(finding(CONFIG_FILE, key === null ? 1 : (keys.get(key)?.line ?? 1), "config-schema", key, e.message ?? e.keyword));
    }
  }
  return { findings, config };
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
  const prefixes = Array.isArray(raw) && raw.every((x) => typeof x === "string") ? new Set(raw as string[]) : null;

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
