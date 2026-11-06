import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BankConfig } from "./bank.ts";
import { relatedId } from "./doctor.ts";
import { facetsOf, selectRecords } from "./query.ts";
import { type ParsedRecord, splitFrontmatter } from "./record.ts";
import { byCodeUnit } from "./text.ts";

export type DigestFile = { name: string; content: string };

export const PLACEHOLDER_MARK = "<!-- ltm digest placeholder -->";
export const SIZE_LIMIT = 1_500_000;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idOf = (r: ParsedRecord): string => str(r.frontmatter.id);

const ruleIdsOf = (r: ParsedRecord): string[] => {
  const related = Array.isArray(r.frontmatter.related) ? r.frontmatter.related : [];
  const entries = related.filter((x): x is string => typeof x === "string" && x.startsWith("constrained_by::"));
  return [...new Set(entries.map(relatedId))];
};

export function digestRecords(records: ParsedRecord[], today: string): ParsedRecord[] {
  const accepted = selectRecords(records, { filters: [], statuses: ["accepted"], facets: [], all: false });
  // String compare is right for YYYY-MM-DD; any other shape keeps the Exception for `ltm validate` to flag.
  return accepted.filter((r) => {
    const to = r.frontmatter.effective_to;
    return !(r.memoryType === "Exception" && typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to) && to < today);
  });
}

export function bankHeader(config: BankConfig): { name: string; commit: string } {
  const name = str(config.raw.name) || basename(config.root);
  let commit = "Bank commit: none (not a git repository).";
  try {
    const out = execFileSync("git", ["-C", config.root, "log", "-1", "--format=%H%x09%cs"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [sha, date] = out.split("\t");
    if (sha && date) commit = `Bank commit ${sha} (${date}).`;
  } catch {}
  return { name, commit };
}

// A body table would put markdown table syntax in the Digest, and pandoc turns it into a Word table; each table becomes a text block. Leading-pipe rows and GFM delimiter-row tables both count.
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

function fenceTables(body: string): string {
  const lines = body.split("\n");
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    let fenced = fence !== null;
    if (mark && (fence === null || (mark[0] === fence[0] && mark.length >= fence.length))) {
      fence = fence === null ? mark : null;
      fenced = true;
    }
    inFence.push(fenced);
  }
  const isTable = lines.map((l, i) => !inFence[i] && l.trimStart().startsWith("|"));
  lines.forEach((l, i) => {
    if (inFence[i] || i === 0 || inFence[i - 1] || !DELIMITER_ROW.test(l) || !lines[i - 1]!.includes("|")) return;
    isTable[i - 1] = true;
    for (let j = i; j < lines.length && !inFence[j] && lines[j]!.includes("|"); j++) isTable[j] = true;
  });
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (isTable[i] && !isTable[i - 1]) out.push("```text");
    out.push(l);
    if (isTable[i] && !isTable[i + 1]) out.push("```");
  });
  return out.join("\n");
}

const SECTIONS = ["PolicyRule", "Exception", "Decision", "Context"] as const;

const facetsText = (r: ParsedRecord): string => {
  const f = facetsOf(r);
  return f === "org-wide" ? "org-wide" : f === null ? "none" : f.join(", ");
};

export function renderDigest(opts: {
  config: BankConfig;
  all: ParsedRecord[];
  picked: ParsedRecord[];
  entries?: ParsedRecord[];
  scope: string;
  header?: { name: string; commit: string };
}): string {
  // `picked` is the whole Digest set so a PolicyRule's Exception lines survive a split into files.
  const { config, all, picked, scope } = opts;
  const rendered = opts.entries ?? picked;
  const { name, commit } = opts.header ?? bankHeader(config);
  const byId = new Map(all.map((r) => [idOf(r), r]));
  const inForce = (id: string): boolean => {
    const r = byId.get(id);
    return r?.memoryType === "PolicyRule" && r.frontmatter.status === "accepted";
  };
  const lines = [`# ${name} Digest`, "", commit, `Scope: ${scope}.`];
  for (const section of SECTIONS) {
    const entries = rendered.filter((r) => r.memoryType === section).sort((a, b) => byCodeUnit(idOf(a), idOf(b)));
    if (entries.length === 0) continue;
    lines.push("", `## ${section}`);
    for (const r of entries) {
      const fm = r.frontmatter;
      lines.push("", `### ${str(fm.title)} (${idOf(r)})`, "", `- memory_type: ${r.memoryType}`);
      lines.push(`- Facets: ${facetsText(r)}`, `- Path: ${r.path}`);
      if (section === "Exception") {
        if (fm.effective_from != null) lines.push(`- effective_from: ${String(fm.effective_from)}`);
        if (fm.effective_to != null) lines.push(`- effective_to: ${String(fm.effective_to)}`);
        for (const id of ruleIdsOf(r)) {
          const rule = byId.get(id);
          const title = rule ? str(rule.frontmatter.title) : id;
          lines.push(
            inForce(id)
              ? `- Departs from PolicyRule: ${title} (${id}). ${str(rule!.frontmatter.summary)}`
              : `- Departs from PolicyRule: ${title} (${id}). That PolicyRule is no longer in force.`,
          );
        }
      }
      if (section === "PolicyRule") {
        const id = idOf(r);
        for (const ex of picked.filter((e) => e.memoryType === "Exception" && ruleIdsOf(e).includes(id))) {
          lines.push(
            `- Exception: ${str(ex.frontmatter.title)} (${idOf(ex)}); Facets: ${facetsText(ex)}; effective_to: ${
              ex.frontmatter.effective_to != null ? String(ex.frontmatter.effective_to) : "none"
            }`,
          );
        }
      }
      const body = splitFrontmatter(readFileSync(join(config.root, r.path), "utf8"))!.body.trim();
      lines.push("", fenceTables(body));
    }
  }
  return `${lines.join("\n")}\n`;
}

// Every non-[a-z0-9-] byte escapes, `_` and uppercase included, so the map is one-to-one even on SharePoint's case-insensitive names.
export function facetFileName(facet: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(facet)) {
    const c = String.fromCharCode(b);
    out += /[a-z0-9-]/.test(c) ? c : `_${b.toString(16).padStart(2, "0")}`;
  }
  return `${out}.md`;
}

export function digestFiles(opts: {
  config: BankConfig;
  all: ParsedRecord[];
  today: string;
  split: boolean;
}): DigestFile[] {
  const { config, all, split } = opts;
  const picked = digestRecords(all, opts.today);
  const header = bankHeader(config);
  if (!split) {
    return [{ name: "accepted.md", content: renderDigest({ config, all, picked, scope: "all accepted Records", header }) }];
  }
  const groups = new Map<string, ParsedRecord[]>([["org-wide", []]]);
  const add = (key: string, r: ParsedRecord) => groups.set(key, [...(groups.get(key) ?? []), r]);
  for (const r of picked) {
    const f = facetsOf(r);
    if (f === "org-wide") add("org-wide", r);
    else if (f !== null) for (const facet of new Set(f)) add(facet, r);
  }
  return [...groups]
    .map(([key, recs]) => ({
      name: key === "org-wide" ? "org-wide.md" : facetFileName(key),
      content: renderDigest({ config, all, picked, entries: recs, scope: key, header }),
    }))
    .sort((a, b) => byCodeUnit(a.name, b.name));
}

export function writeDigest(dir: string, files: DigestFile[], split: boolean, today: string): void {
  mkdirSync(dir, { recursive: true });
  const names = new Set(files.map((f) => f.name));
  for (const f of files) writeFileSync(join(dir, f.name), f.content);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || names.has(name)) continue;
    const path = join(dir, name);
    const lines = readFileSync(path, "utf8").split("\n");
    // Only a file this command wrote is ours to replace; `--out .` must not eat a Bank's README.
    if (lines[0] === PLACEHOLDER_MARK || !lines[2]?.startsWith("Bank commit")) continue;
    const text = !split
      ? `This Digest moved to accepted.md in this folder as of ${today}; nothing here is current.`
      : name === "accepted.md"
        ? `This Digest moved to the per-Facet files in this folder as of ${today}; nothing here is current.`
        : `This Facet has no accepted Records as of ${today}; nothing here is current. The other files in this folder hold the current Digest.`;
    writeFileSync(path, `${PLACEHOLDER_MARK}\n\n${text}\n`);
  }
}

export function sizeWarnings(files: DigestFile[]): string[] {
  return files
    .filter((f) => f.content.length > SIZE_LIMIT)
    .map(
      (f) =>
        `ltm digest: ${f.name} is ${f.content.length} characters; Microsoft Search stops reading a file after 2,000,000. Use --split facet to write one file per Facet.`,
    );
}
