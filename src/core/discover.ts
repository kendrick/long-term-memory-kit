import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { isMapping, type BankConfig } from "./bank.ts";
import { fenceTracker } from "./markdown.ts";
import { listRecords } from "./query.ts";
import { splitFrontmatter, type ParsedRecord } from "./record.ts";
import { repoIdentity } from "./resolve.ts";
import { byCodeUnit, firstLine } from "./text.ts";

export type Kind = "adr" | "pr" | "transcript" | "prd" | "document" | "binary-doc";
export type Entry = { path: string; kind: Kind; title: string; bytes: number; cited_by: string[] | null };
export type Aliases = { Context: string[]; Decision: string[] };
type Heading = { level: number; text: string };
type SourceFile = { rel: string; ext: string; text: string; headings: Heading[] };

const MAX_BYTES = 1_048_576;
// Listed by extension and never opened: a SharePoint sync folder's online-only files would download on read, and conversion is the agent's job.
const BINARY_DOC = new Set([".docx", ".pptx", ".xlsx", ".pdf"]);
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SPEAKER = /^[A-Z][\w .'-]{0,40}: /;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

// Frontmatter is skipped so a `# comment` line in YAML can't pose as a heading.
function headingsOf(text: string): Heading[] {
  const body = splitFrontmatter(text)?.body ?? text;
  const out: Heading[] = [];
  const step = fenceTracker();
  for (const line of body.split(/\r?\n/)) {
    if (step(line) !== "text") continue;
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
      const fm: unknown = parse(split.frontmatterLines.join("\n"), { logLevel: "error" });
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

// A synced library's Records cite the remote form (`sharepoint:site/lib/path`), which no local path can match.
export function citedBy(
  entryPath: string,
  repoRelPath: string | null,
  records: ParsedRecord[],
  remoteRef?: string,
  repoRef?: string,
): string[] {
  const ids: string[] = [];
  for (const r of records) {
    const refs = r.frontmatter.source_refs;
    const pf = r.frontmatter.promoted_from;
    const id = r.frontmatter.id;
    if (typeof id !== "string") continue;
    const viaRefs =
      Array.isArray(refs) &&
      refs.some(
        (ref) =>
          typeof ref === "string" &&
          (ref === entryPath ||
            ref === remoteRef ||
            (repoRelPath !== null &&
              (ref === repoRelPath || (URL_SCHEME.test(ref) && ref.endsWith(`/${repoRelPath}`))))),
      );
    // `promote` appends `#<anchor>` for decision-log entries; the anchor is irrelevant to whether the file is covered.
    const viaPromoted =
      repoRef !== undefined && typeof pf === "string" && (pf === repoRef || pf.startsWith(`${repoRef}#`));
    if (viaRefs || viaPromoted) ids.push(id);
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
    sourceRefPrefix?: string;
  },
): Entry[] {
  const { cwd, bank, onError, onSkip, sourceRefPrefix } = opts;
  const aliases = aliasesOf(bank);
  const toRel = (abs: string) => relative(cwd, abs).split(sep).join("/");
  // The remote ref is relative to the synced folder, which is lost once the walk flattens to paths.
  const files: { abs: string; base: string }[] = [];

  const walk = (dir: string, base: string): void => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      onSkip(toRel(dir), firstLine((e as Error).message ?? "") || "unreadable");
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
        if (d.name !== "node_modules") walk(p, base);
      } else if (d.isFile()) files.push({ abs: p, base });
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
    else if (st.isDirectory()) walk(abs, abs);
    else if (st.isFile()) files.push({ abs, base: dirname(abs) });
  }

  const records = bank ? listRecords(bank, onSkip) : null;
  const repoRoots = new Map<string, string | null>();
  const slugs = new Map<string, string | null>();
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const { abs, base } of files) {
    const rel = toRel(abs);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const isBinaryDoc = BINARY_DOC.has(extname(abs).toLowerCase());
    let bytes: number;
    let text = "";
    try {
      bytes = lstatSync(abs).size;
      if (!isBinaryDoc) {
        if (bytes > MAX_BYTES) throw new Error("over 1 MiB");
        text = readFileSync(abs, "utf8");
      }
    } catch (e) {
      onSkip(rel, firstLine((e as Error).message ?? "") || "unreadable");
      continue;
    }
    const root = repoRootOf(dirname(abs), repoRoots);
    const repoRel = root === null ? null : relative(root, abs).split(sep).join("/");
    // The folder rule must see the same directories whether `ltm discover` runs from the repo root or
    // from inside `adr/`. Absolute segments are off the table: a checkout under `~/decisions/` would
    // turn every file into an ADR. Without a repo, the cwd-relative path is all there is.
    const kind: Kind | null = isBinaryDoc ? "binary-doc" : classify(repoRel ?? rel, text, aliases);
    if (kind === null) continue;
    const remoteRef =
      sourceRefPrefix === undefined ? undefined : sourceRefPrefix + relative(base, abs).split(sep).join("/");
    let slug: string | null = null;
    if (records && root !== null) {
      if (!slugs.has(root)) {
        const remote = repoIdentity(root).remote;
        slugs.set(root, remote ? `${remote.org}/${remote.repo}` : null);
      }
      slug = slugs.get(root)!;
    }
    const repoRef = slug && repoRel !== null ? `${slug}:${repoRel}` : undefined;
    const cited = records ? citedBy(rel, repoRel, records, remoteRef, repoRef) : null;
    const title = isBinaryDoc ? basename(rel, extname(rel)) : titleOf(rel, kind, text);
    entries.push({ path: rel, kind, title, bytes, cited_by: cited });
  }
  entries.sort((a, b) => byCodeUnit(a.path, b.path));
  return entries;
}
