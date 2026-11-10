import { basename } from "node:path";
import agentsTemplate from "../../templates/init/agents-region.md" with { type: "text" };
import { MEMORY_TYPES, type BankConfig } from "./bank.ts";

export const DEFAULT_FACET_PREFIXES: readonly string[] = ["service", "domain", "system", "team", "platform"];

// The version sits in the marker, never in the region, so upgrading ltm alone
// doesn't make `init --check` call every Bank stale.
export const BEGIN = (version: string): string => `<!-- ltm:generated:begin v${version} -->`;
export const END = "<!-- ltm:generated:end -->";

export const CLAUDE_REGION = "@AGENTS.md\n";
export const COPILOT_REGION = "Follow AGENTS.md at the repo root to read and propose Bank memory.\n";

const BEGIN_LINE = /^<!-- ltm:generated:begin v\S+ -->\r?$/;
const END_LINE = /^<!-- ltm:generated:end -->\r?$/;

// Bare when every char is shell-inert, so the common `_memory/...` paths read cleanly.
function shq(s: string): string {
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

// grep's default is BRE: a Facet like `domain:a.b` would otherwise match `domain:aXb`.
const breEscape = (s: string): string => s.replace(/[.[\]*^$\\]/g, "\\$&");

export const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function exampleFacet(raw: Record<string, unknown>, prefixes: string[]): string {
  const consumers = raw.consumers;
  if (typeof consumers === "object" && consumers !== null && !Array.isArray(consumers)) {
    const first = Object.values(consumers)[0];
    const facet = stringList(first)[0];
    if (facet !== undefined) return facet;
  }
  return `${prefixes[0] ?? DEFAULT_FACET_PREFIXES[0]}:example`;
}

const tableCell = (s: string): string => s.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|");

// Padded the way Prettier and oxfmt pad a table. A Bank that formats its Markdown would
// otherwise realign the region on every run, and `init --check` would call it stale.
function alignedTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(3, h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function renderAgentsRegion(
  config: BankConfig,
  schema: { properties: Record<string, { description?: string }>; required: string[] },
): string {
  const { raw, folders } = config;
  const name = typeof raw.name === "string" ? raw.name : basename(config.root);
  const prefixes = stringList(raw.facet_prefixes);
  const allFolders = MEMORY_TYPES.map((t) => shq(folders[t])).join(" ");
  const facetPattern = `applies_to:.*${breEscape(exampleFacet(raw, prefixes))}`;

  // One string for the plain grep and the three pipes, so the read steps can't drift from
  // what the grep printed. The pipes use --null/-0 because folder paths can hold spaces;
  // BSD grep's -Z means something else. xargs -r keeps GNU xargs from running the reader once with
  // no paths when grep matches nothing (`ltm head` with no path exits 2).
  const appliesGrepArgs = `'${facetPattern.replaceAll("'", `'\\''`)}' ${allFolders}`;
  const readFrom = (cmd: string) => `grep -rl --null ${appliesGrepArgs} | xargs -0 -r ${cmd}`;

  const funnel = [
    ...MEMORY_TYPES.map((t) => `ls ${shq(folders[t])}`),
    `grep -rl '^memory_type: PolicyRule$' ${shq(folders.PolicyRule)}`,
    `grep -rl ${appliesGrepArgs}`,
    readFrom("ltm head"),
    readFrom("head -n 20"),
    readFrom("cat"),
  ].join("\n");

  const types = MEMORY_TYPES.map((t) => `${t} (\`${folders[t]}\`)`);
  const fields = alignedTable(
    ["Field", "Required", "Description"],
    Object.entries(schema.properties).map(([key, prop]) => [
      `\`${key}\``,
      schema.required.includes(key) ? "yes" : "",
      tableCell(prop.description ?? ""),
    ]),
  );

  const values: Record<string, string> = {
    name,
    types: `${types.slice(0, -1).join(", ")}, and ${types.at(-1)}`,
    funnel,
    prefixes: prefixes.length ? prefixes.map((p) => `\`${p}\``).join(", ") : "none yet",
    fields,
  };
  return agentsTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`agents-region.md: unknown placeholder {{${key}}}`);
    return value;
  });
}

export type Span =
  | { beginStart: number; beginEnd: number; endStart: number }
  | { beginStart: number; endStart: null }
  | { malformed: string };

// Slices by offset so everything outside the markers comes back byte for byte.
// Scans the whole file: stopping at the first end marker would let a second block, left
// by a merge, survive every rewrite and every --check.
export function findMarkers(text: string, begin: RegExp, end: RegExp, label: string): Span | null {
  const begins: { start: number; end: number }[] = [];
  const ends: number[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const line = text.slice(start, nl === -1 ? text.length : nl);
    if (begin.test(line)) begins.push({ start, end: nl === -1 ? text.length : nl + 1 });
    else if (end.test(line)) ends.push(start);
    if (nl === -1) break;
    start = nl + 1;
  }
  if (begins.length === 0 && ends.length === 0) return null;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (begins.length > 1 || ends.length > 1) {
    return { malformed: `${count(begins.length, `${label} begin marker`)} and ${count(ends.length, "end marker")}; leave one block` };
  }
  const first = begins[0];
  if (first === undefined) return { malformed: `an ${label} end marker with no begin marker` };
  if (ends.length === 0) return { beginStart: first.start, endStart: null };
  if (ends[0]! < first.end) return { malformed: `an ${label} end marker before the begin marker` };
  return { beginStart: first.start, beginEnd: first.end, endStart: ends[0]! };
}

// Prettier and oxfmt both pad the markers with a blank line, and a hand edit can drop it.
// Comparing through this keeps either shape from reading as stale.
export function normalizeRegion(region: string): string {
  const body = region.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
  return body === "" ? "" : `${body}\n`;
}

export function readRegion(fileText: string): string | null {
  const span = findMarkers(fileText, BEGIN_LINE, END_LINE, "ltm:generated");
  if (span === null || "malformed" in span || span.endStart === null) return null;
  return normalizeRegion(fileText.slice(span.beginEnd, span.endStart));
}

// Blank-line separator so an appended region sits one blank line below existing text.
export function appendGap(fileText: string): string {
  return fileText.endsWith("\n\n") ? "" : fileText.endsWith("\n") ? "\n" : "\n\n";
}

export function replaceRegion(fileText: string | null, region: string, version: string): string {
  const body = normalizeRegion(region);
  // Padded the way the formatters pad it, so formatting the file after init changes nothing.
  const inner = body === "" ? "\n" : `\n${body}\n`;
  const block = `${BEGIN(version)}\n${inner}${END}\n`;
  if (fileText === null || fileText === "") return block;
  const span = findMarkers(fileText, BEGIN_LINE, END_LINE, "ltm:generated");
  if (span === null) return `${fileText}${appendGap(fileText)}${block}`;
  if ("malformed" in span) throw new Error(span.malformed);
  // Appending here would leave two begin markers, and readRegion would pair the stray one with the new end.
  if (span.endStart === null) throw new Error("the ltm:generated begin marker has no matching end marker");
  return `${fileText.slice(0, span.beginStart)}${BEGIN(version)}\n${inner}${fileText.slice(span.endStart)}`;
}
