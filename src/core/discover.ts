import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { isMapping, type BankConfig } from "./bank.ts";
import { listRecords } from "./query.ts";
import { splitFrontmatter, type ParsedRecord } from "./record.ts";

export type Kind = "adr" | "pr" | "transcript" | "prd" | "document";
export type Entry = { path: string; kind: Kind; title: string; bytes: number; cited_by: string[] | null };
export type Aliases = { Context: string[]; Decision: string[] };
type Heading = { level: number; text: string };
type SourceFile = { rel: string; ext: string; text: string; headings: Heading[] };

const MAX_BYTES = 1_048_576;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SPEAKER = /^[A-Z][\w .'-]{0,40}: /;
// CommonMark fences: a closer must repeat the opener's character at least as long, so an inner
// ``` line can't end a ```` block and ~~~ can't end a backtick block. An unclosed fence runs to EOF.
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Frontmatter is skipped so a `# comment` line in YAML can't pose as a heading.
function headingsOf(text: string): Heading[] {
  const body = splitFrontmatter(text)?.body ?? text;
  const out: Heading[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const close = CLOSE_FENCE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = null;
      continue;
    }
    const open = OPEN_FENCE.exec(line);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      continue;
    }
    const m = HEADING.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]! });
  }
  return out;
}

// "Context and Problem Statement" has to count as Context, so match on a word prefix.
function hasHeading(headings: Heading[], names: string[]): boolean {
  const wanted = names.map((n) => n.toLowerCase());
  return headings.some((h) => {
    const t = h.text.toLowerCase();
    return wanted.some((n) => t === n || t.startsWith(`${n} `));
  });
}

function isPrJson(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return isMapping(v) && ["number", "title", "body"].every((k) => Object.hasOwn(v, k));
  } catch {
    return false;
  }
}

export const CLASSIFIERS: readonly {
  kind: Kind;
  test(file: SourceFile, aliases: Aliases): boolean;
}[] = [
  {
    kind: "adr",
    test: (f, a) => {
      if (f.ext !== ".md") return false;
      const dirs = f.rel.split("/").slice(0, -1);
      if (dirs.some((d) => d === "adr" || d === "adrs" || d === "decisions")) return true;
      return hasHeading(f.headings, ["Context", ...a.Context]) && hasHeading(f.headings, ["Decision", ...a.Decision]);
    },
  },
  { kind: "pr", test: (f) => f.ext === ".json" && isPrJson(f.text) },
  {
    kind: "transcript",
    test: (f) =>
      f.ext === ".vtt" ||
      f.ext === ".srt" ||
      (f.ext === ".txt" && f.text.split(/\r?\n/).filter((l) => SPEAKER.test(l)).length >= 5),
  },
  {
    kind: "prd",
    test: (f) => {
      if (f.ext !== ".md") return false;
      const h1 = f.headings.find((h) => h.level === 1);
      if (h1 && (h1.text.includes("PRD") || h1.text.toLowerCase().includes("product requirements"))) return true;
      return hasHeading(f.headings, ["Problem"]) && hasHeading(f.headings, ["Requirements"]);
    },
  },
  { kind: "document", test: (f) => f.ext === ".md" || f.ext === ".txt" },
];

export function classify(relPath: string, text: string, aliases: Aliases): Kind | null {
  const file: SourceFile = {
    rel: relPath,
    ext: extname(relPath).toLowerCase(),
    text,
    headings: headingsOf(text),
  };
  return CLASSIFIERS.find((c) => c.test(file, aliases))?.kind ?? null;
}

export function titleOf(relPath: string, kind: Kind, text: string): string {
  const split = splitFrontmatter(text);
  if (split) {
    try {
      const fm: unknown = parse(split.frontmatterLines.join("\n"));
      if (isMapping(fm) && typeof fm.title === "string") return fm.title;
    } catch {
      // Bad YAML in a source must not hide the file; the H1 or basename still names it.
    }
  }
  if (kind === "pr") {
    try {
      const v: unknown = JSON.parse(text);
      if (isMapping(v) && typeof v.title === "string") return v.title;
    } catch {
      // Unreachable for a classified pr; kept so titleOf stays total.
    }
  } else {
    const h1 = headingsOf(text).find((h) => h.level === 1);
    if (h1) return h1.text;
  }
  return basename(relPath);
}

export function citedBy(entryPath: string, repoRelPath: string | null, records: ParsedRecord[]): string[] {
  const ids: string[] = [];
  for (const r of records) {
    const refs = r.frontmatter.source_refs;
    const id = r.frontmatter.id;
    if (!Array.isArray(refs) || typeof id !== "string") continue;
    const hit = refs.some(
      (ref) =>
        typeof ref === "string" &&
        (ref === entryPath ||
          (repoRelPath !== null &&
            (ref === repoRelPath || (URL_SCHEME.test(ref) && ref.endsWith(`/${repoRelPath}`))))),
    );
    if (hit) ids.push(id);
  }
  return ids.sort(byCodeUnit);
}

function aliasesOf(bank: BankConfig | null): Aliases {
  const out: Aliases = { Context: [], Decision: [] };
  const raw = bank?.raw.heading_aliases;
  if (!isMapping(raw)) return out;
  for (const k of ["Context", "Decision"] as const) {
    const v = raw[k];
    // A mixed list is a config typo; honoring half of it would classify on a guess.
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v;
  }
  return out;
}

// A nested checkout's `.git` is a file, so any entry counts, not just a directory.
function repoRootOf(dir: string, cache: Map<string, string | null>): string | null {
  if (cache.has(dir)) return cache.get(dir)!;
  let found: string | null = null;
  try {
    lstatSync(join(dir, ".git"));
    found = dir;
  } catch {
    const parent = dirname(dir);
    if (parent !== dir) found = repoRootOf(parent, cache);
  }
  cache.set(dir, found);
  return found;
}

export function discover(
  args: string[],
  opts: {
    cwd: string;
    bank: BankConfig | null;
    onError(msg: string): void;
    onSkip(path: string, reason: string): void;
  },
): Entry[] {
  const { cwd, bank, onError, onSkip } = opts;
  const aliases = aliasesOf(bank);
  const toRel = (abs: string) => relative(cwd, abs).split(sep).join("/");
  const files: string[] = [];

  const walk = (dir: string): void => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      onSkip(toRel(dir), (e as Error).message?.split("\n")[0] || "unreadable");
      return;
    }
    dirents.sort((a, b) => byCodeUnit(a.name, b.name));
    for (const d of dirents) {
      const p = join(dir, d.name);
      if (d.name.startsWith(".")) continue;
      // Bun may resolve a `\` name as a different path in readFileSync/readdirSync.
      if (d.name.includes("\\")) {
        onSkip(toRel(p), "name contains a backslash");
        continue;
      }
      if (d.isSymbolicLink()) {
        onSkip(toRel(p), "symlink, not followed");
        continue;
      }
      if (d.isDirectory()) {
        if (d.name !== "node_modules") walk(p);
      } else if (d.isFile()) files.push(p);
    }
  };

  for (const arg of args) {
    const abs = resolve(cwd, arg);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      onError(`${arg}: no such file or directory`);
      continue;
    }
    if (st.isSymbolicLink()) onSkip(toRel(abs), "symlink, not followed");
    else if (st.isDirectory()) walk(abs);
    else if (st.isFile()) files.push(abs);
  }

  const records = bank ? listRecords(bank, onSkip) : null;
  const repoRoots = new Map<string, string | null>();
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const abs of files) {
    const rel = toRel(abs);
    if (seen.has(rel)) continue;
    seen.add(rel);
    let bytes: number;
    let text: string;
    try {
      bytes = lstatSync(abs).size;
      if (bytes > MAX_BYTES) {
        onSkip(rel, "over 1 MiB");
        continue;
      }
      text = readFileSync(abs, "utf8");
    } catch (e) {
      onSkip(rel, (e as Error).message?.split("\n")[0] || "unreadable");
      continue;
    }
    const root = repoRootOf(dirname(abs), repoRoots);
    const repoRel = root === null ? null : relative(root, abs).split(sep).join("/");
    // The folder rule must see the same directories whether `ltm discover` runs from the repo root or
    // from inside `adr/`. Absolute segments are off the table: a checkout under `~/decisions/` would
    // turn every file into an ADR. Without a repo, the cwd-relative path is all there is.
    const kind = classify(repoRel ?? rel, text, aliases);
    if (kind === null) continue;
    const cited = records ? citedBy(rel, repoRel, records) : null;
    entries.push({ path: rel, kind, title: titleOf(rel, kind, text), bytes, cited_by: cited });
  }
  entries.sort((a, b) => byCodeUnit(a.path, b.path));
  return entries;
}
