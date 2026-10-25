import { readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Pair } from "yaml";
import { ConfigError, isInside, loadConfig, type BankConfig, type MemoryType } from "./bank.ts";
import { listRecordFiles } from "./query.ts";
import { splitFrontmatter, unrepresentable, type Unrepresentable } from "./record.ts";
import { byCodeUnit as cmp, firstLine } from "./text.ts";

export type Rule =
  | "config-schema"
  | "schema"
  | "canonical-list"
  | "line-budget"
  | "folder-type"
  | "facet-prefix"
  | "unique-id"
  | "frontmatter"
  | "walk"
  | "supersession-missing-target"
  | "supersession-incomplete"
  | "supersession-status"
  | "supersession-facets"
  | "body-sections"
  | "bright-line";

export type Severity = "error" | "warning";

export type Finding = { file: string; line: number; rule: Rule; severity: Severity; key: string | null; message: string };

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

const finding = (
  file: string,
  line: number,
  rule: Rule,
  key: string | null,
  message: string,
  severity: Severity = "error",
): Finding => ({
  file,
  line,
  rule,
  severity,
  key,
  message,
});

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
  body: string;
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
  const doc = parseDocument(src, { logLevel: "error" });
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
  return { findings: [], fm: { rel, src, closingLine: split.closingLine, body: split.body, keys, data, lineOf } };
}

function checkSchema({ rel, data, lineOf }: Frontmatter): Finding[] {
  const validate = recordSchema();
  if (validate(data)) return [];
  const errors = validate.errors ?? [];
  // An undeclared key's `anyOf` reports each branch's errors (at /key or /key/0, so not always one
  // instancePath) plus a closing anyOf error. The closing one alone says what's wrong.
  const collapsed = new Set(errors.filter((e) => e.keyword === "anyOf").map(errorKey));
  const kept = errors.filter((e) => e.keyword === "anyOf" || !collapsed.has(errorKey(e)));
  return kept.map((e) => {
    const key = errorKey(e);
    let message = e.keyword === "anyOf" ? "must be a scalar or a flat list of scalars" : (e.message ?? e.keyword);
    if (e.keyword === "required" && key !== null && KEYS_LTM_FMT_FILLS.has(key)) message += "; `ltm fmt` will add it";
    return finding(rel, lineOf(key), "schema", key, message);
  });
}

// A value JSON can't carry exactly is a schema error too, but only on a key checkSchema didn't already flag. `.nan`, `!!binary`, and `!!timestamp` already fail the schema, and a second finding would report one problem twice (#44). In practice that leaves the unsafe integer, `-0.0`, and a float spelling that rounds on parse.
function checkUnrepresentable({ rel, src, lineOf }: Frontmatter, flagged: ReadonlySet<string | null>): Finding[] {
  let found: Unrepresentable[];
  try {
    found = unrepresentable(src);
  } catch {
    // The source already parsed once; a throw here is another reader's failure to report, not a finding.
    return [];
  }
  const out: Finding[] = [];
  const seen = new Set<string | null>();
  // Key rows report a key by source spelling (`9007199254740993`, `"1"`), but `keys` is indexed by the parsed value (`9007199254740992`), so lineOf misses and lands on line 1. The `<<` row stays on line 1, which test/core/validate.test.ts pins.
  const contents = parseDocument(src, { logLevel: "error" }).contents;
  const rootPairs = isMap(contents) ? contents.items : [];
  const spellingLine = (key: string | null): number => {
    const pair = rootPairs.find((p) => {
      const k: unknown = p.key;
      return ((isScalar(k) || isAlias(k)) && k.range ? src.slice(k.range[0], k.range[1]) : String(k)).trim() === key;
    });
    const at = (pair?.key as { range?: [number, number, number] | null } | undefined)?.range?.[0];
    return at === undefined ? 1 : 2 + (src.slice(0, at).match(/\n/g)?.length ?? 0);
  };
  for (const { key, reason } of found) {
    if (flagged.has(key) || seen.has(key)) continue;
    seen.add(key);
    const line = lineOf(key) !== 1 || key === null || key === "<<" ? lineOf(key) : spellingLine(key);
    out.push(finding(rel, line, "schema", key, `${reason}; JSON can't carry it exactly`));
  }
  return out;
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

function checkFolderType({ rel, data, lineOf }: Frontmatter, folderType: MemoryType, folderPath?: string): Finding[] {
  const written = data.memory_type;
  if (typeof written !== "string" || written === folderType) return [];
  return [
    finding(
      rel,
      lineOf("memory_type"),
      "folder-type",
      "memory_type",
      `memory_type is '${written}' but the file is in the ${folderType} folder (${folderPath ?? posix.dirname(rel)})`,
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

const SECTIONS = {
  Context: ["context", "context and problem statement"],
  Decision: ["decision", "decision outcome"],
  Consequences: ["consequences"],
} as const;
type Section = keyof typeof SECTIONS;
export type HeadingAliases = Partial<Record<Section, string[]>>;

// Config schema errors are reported on their own; a malformed map here must not also crash the run.
function headingAliases(raw: unknown): HeadingAliases {
  const out: HeadingAliases = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const name of Object.keys(SECTIONS) as Section[]) {
    const v = (raw as Record<string, unknown>)[name];
    // A mixed list is a config typo; honoring half of it would classify on a guess.
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[name] = v as string[];
  }
  return out;
}

// Headings inside a fenced code block are sample text, not structure.
function headingTexts(body: string): Set<string> {
  const out = new Set<string>();
  // CommonMark: a closer repeats the opener's character at least as many times; an unclosed fence runs to EOF.
  let fence: { char: string; len: number } | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.len) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      continue;
    }
    const h = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/.exec(line);
    // An ATX closing sequence is a run of # after a space or tab at the end of the line.
    if (h) out.add((h[1] ?? "").replace(/(^|[ \t]+)#+[ \t]*$/, "").trim().toLowerCase());
  }
  return out;
}

function checkBodySections({ rel, body }: Frontmatter, aliases: HeadingAliases): Finding[] {
  const have = headingTexts(body);
  const missing = (Object.keys(SECTIONS) as Section[]).filter(
    (name) => ![...SECTIONS[name], ...(aliases[name] ?? []).map((a) => a.trim().toLowerCase())].some((h) => have.has(h)),
  );
  if (missing.length === 0) return [];
  return [finding(rel, 1, "body-sections", null, `Decision body has no ${missing.join(", ")} heading`, "warning")];
}

type RecordResult = { findings: Finding[]; id: string | null; idLine: number; fm: Frontmatter | null };

function analyzeRecord(
  rel: string,
  folderType: MemoryType,
  text: string,
  facetPrefixes: ReadonlySet<string> | null,
  opts: { folderPath?: string; aliases?: HeadingAliases } = {},
): RecordResult {
  const { findings, fm } = checkFrontmatter(rel, text);
  if (!fm) return { findings, id: null, idLine: 1, fm: null };
  const schema = checkSchema(fm);
  findings.push(
    ...schema,
    ...checkUnrepresentable(fm, new Set(schema.map((f) => f.key))),
    ...checkCanonicalLists(fm),
    ...checkLineBudget(fm),
    ...checkFolderType(fm, folderType, opts.folderPath),
    ...checkFacetPrefixes(fm, facetPrefixes),
  );
  if (folderType === "Decision") findings.push(...checkBodySections(fm, opts.aliases ?? {}));
  const id = typeof fm.data.id === "string" ? fm.data.id : null;
  return { findings, id, idLine: fm.lineOf("id"), fm };
}

export function checkRecordText(
  rel: string,
  folderType: MemoryType,
  text: string,
  facetPrefixes: string[] | null,
  folderPath?: string,
): { findings: Finding[]; id: string | null } {
  const { findings, id } = analyzeRecord(rel, folderType, text, facetPrefixes && new Set(facetPrefixes), { folderPath });
  return { findings, id };
}

type Node = { file: string; type: MemoryType; fm: Frontmatter };

// A finding plus the other file its message names, so a paths filter can keep it when either end was named.
type Pending = { finding: Finding; also: string };

const stringList = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// Missing, null, or empty means "applies everywhere", so it overlaps with anything. Exported so ltm supersede
// (#11) refuses exactly the pairs this check would flag.
export function sharesScope(a: unknown, b: unknown): boolean {
  const as = stringList(a);
  const bs = stringList(b);
  if (as.length === 0 || bs.length === 0) return true;
  return as.some((x) => bs.includes(x));
}

// Reads every Record, named or not: the other end of an edge may live in a file nobody named.
function checkSupersession(nodes: Node[]): Pending[] {
  const sorted = [...nodes].sort((a, b) => cmp(a.file, b.file));
  // An id held by several Records is `unique-id`'s to report, and an edge can't pick between holders. So an
  // edge is recorded only when its target resolves to one Record, and `incomplete` is skipped when either
  // end's own id is shared, since the reciprocal side can't be resolved. Scope needs no reciprocal, so
  // `facets` still runs on every recorded edge.
  const byId = new Map<string, Node[]>();
  for (const n of sorted) {
    const id = n.fm.data.id;
    if (typeof id !== "string") continue;
    const held = byId.get(id);
    if (held) held.push(n);
    else byId.set(id, [n]);
  }

  const unique = (id: unknown) => typeof id === "string" && byId.get(id)?.length === 1;

  const out: Pending[] = [];
  // Edge (old, new) -> which side wrote it down.
  const edges = new Map<string, { old: Node; new: Node; byOld: boolean; byNew: boolean }>();
  const edge = (o: Node, n: Node) => {
    const k = `${o.file}\0${n.file}`;
    let e = edges.get(k);
    if (!e) edges.set(k, (e = { old: o, new: n, byOld: false, byNew: false }));
    return e;
  };
  const hasSuccessor = (n: Node) => typeof n.fm.data.superseded_by === "string" && n.fm.data.superseded_by !== "";
  const missing = (n: Node, key: string, id: string) =>
    out.push({
      finding: finding(n.file, n.fm.lineOf(key), "supersession-missing-target", key, `${key} names '${id}', which no Record has`),
      also: n.file,
    });

  for (const n of sorted) {
    const { data } = n.fm;
    const by = data.superseded_by;
    if (typeof by === "string" && by !== "") {
      const targets = byId.get(by);
      if (!targets) missing(n, "superseded_by", by);
      else if (unique(by)) edge(n, targets[0]!).byOld = true;
      if (data.status !== "superseded") {
        const key = n.fm.keys.has("status") ? "status" : "superseded_by";
        out.push({
          finding: finding(
            n.file,
            n.fm.lineOf(key),
            "supersession-status",
            "status",
            `status is '${String(data.status ?? "")}' but superseded_by is set; a superseded Record needs status 'superseded'`,
          ),
          also: n.file,
        });
      }
    }
    for (const id of new Set(stringList(data.supersedes))) {
      const targets = byId.get(id);
      if (!targets) missing(n, "supersedes", id);
      else if (unique(id)) edge(targets[0]!, n).byNew = true;
    }
  }

  for (const e of edges.values()) {
    const resolvable = unique(e.old.fm.data.id) && unique(e.new.fm.data.id);
    if (resolvable && e.byOld && !e.byNew) {
      out.push({
        finding: finding(
          e.old.file,
          e.old.fm.lineOf("superseded_by"),
          "supersession-incomplete",
          "superseded_by",
          `superseded_by names ${e.new.file}, which doesn't list it back in supersedes`,
        ),
        also: e.new.file,
      });
    } else if (resolvable && e.byNew && !e.byOld && !(e.new.fm.data.status === "proposed" && !hasSuccessor(e.old))) {
      // A Proposal names what it supersedes before Acceptance; `ltm accept` (#11) writes the old half at Acceptance. Only while the target is still unsuperseded: superseded_by is a scalar, so a target already pointing at another successor can't be reciprocal to both, and accepting would either overwrite that pair or leave this one half-written.
      out.push({
        finding: finding(
          e.new.file,
          e.new.fm.lineOf("supersedes"),
          "supersession-incomplete",
          "supersedes",
          `supersedes names ${e.old.file}, which doesn't list it back in superseded_by`,
        ),
        also: e.old.file,
      });
    }
    if (!sharesScope(e.old.fm.data.applies_to, e.new.fm.data.applies_to)) {
      out.push({
        finding: finding(
          e.old.file,
          e.old.fm.lineOf("applies_to"),
          "supersession-facets",
          "applies_to",
          `${e.old.file} and ${e.new.file} are linked by supersession but share no applies_to entry`,
        ),
        also: e.new.file,
      });
    }
  }
  return out;
}

// A Record scoped to one service and tied to no PolicyRule is probably one repo's working memory.
function checkBrightLine(nodes: Node[]): Finding[] {
  const policyIds = new Set<string>();
  for (const n of nodes) if (n.type === "PolicyRule" && typeof n.fm.data.id === "string") policyIds.add(n.fm.data.id);
  const out: Finding[] = [];
  for (const n of nodes) {
    const scope = n.fm.data.applies_to;
    const only = Array.isArray(scope) && scope.length === 1 ? scope[0] : undefined;
    if (typeof only !== "string" || !only.startsWith("service:")) continue;
    if (stringList(n.fm.data.related).some((r) => policyIds.has(r.includes("::") ? r.slice(r.lastIndexOf("::") + 2) : r))) continue;
    out.push(
      finding(
        n.file,
        n.fm.lineOf("applies_to"),
        "bright-line",
        "applies_to",
        `scoped to only ${only} and tied to no PolicyRule; it may be working memory for that service's repo rather than Bank memory`,
        "warning",
      ),
    );
  }
  return out;
}

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
    // The ReferenceError branch covers loadConfig builds that don't yet wrap yaml's alias-limit error; anything else is a bug, not a bad config.
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

export type BankReport = { findings: Finding[]; files: string[] };

// JUnit needs a testcase per file judged, including the clean ones, which findings alone can't supply.
function report(findings: Finding[], judged: Iterable<string>): BankReport {
  const files = new Set(judged);
  for (const f of findings) files.add(f.file);
  return { findings: sortFindings(findings), files: [...files].sort(cmp) };
}

export function validateBank(root: string, paths: string[] | null, cwd: string): Finding[] {
  return validateBankReport(root, paths, cwd).findings;
}

export function validateBankReport(root: string, paths: string[] | null, cwd: string): BankReport {
  const bankRoot = resolve(root);
  const { findings, config } = checkConfig(bankRoot);
  const judged: string[] = [CONFIG_FILE];
  if (!config) return report(findings, judged);

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

  const aliases = headingAliases(config.raw.heading_aliases);

  const ids: { file: string; line: number; id: string }[] = [];
  const nodes: Node[] = [];
  // Every Record is read even when paths are named: a duplicate id may live in a file nobody named.
  for (const f of files) {
    const isNamed = !namedRels || namedRels.has(f.rel);
    if (isNamed) judged.push(f.rel);
    let text: string;
    try {
      text = readFileSync(f.abs, "utf8");
    } catch (e) {
      if (isNamed) findings.push(finding(f.rel, 1, "walk", null, firstLine((e as Error).message)));
      continue;
    }
    const r = analyzeRecord(f.rel, f.type, text, prefixes, { folderPath: config.folders[f.type], aliases });
    if (isNamed) findings.push(...r.findings);
    if (r.id !== null) ids.push({ file: f.rel, line: r.idLine, id: r.id });
    if (r.fm) nodes.push({ file: f.rel, type: f.type, fm: r.fm });
  }
  findings.push(...checkUniqueIds(ids, namedRels));
  for (const p of checkSupersession(nodes)) {
    if (!namedRels || namedRels.has(p.finding.file) || namedRels.has(p.also)) findings.push(p.finding);
  }
  for (const f of checkBrightLine(nodes)) {
    if (!namedRels || namedRels.has(f.file)) findings.push(f);
  }
  return report(findings, judged);
}
