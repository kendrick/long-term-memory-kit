import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { isMapping, type MemoryType } from "./bank.ts";
import { isCalendarDate } from "./clock.ts";
import { fenceTracker } from "./markdown.ts";
import { proposeRecord, type ProposalInput, type ProposeDeps, type ProposeDryRun, type ProposeRefusal, type Proposed } from "./propose.ts";
import { splitFrontmatter } from "./record.ts";
import { firstLine } from "./text.ts";

export type PromoteSource =
  | { kind: "adr"; title: string | null; body: string; existing: string | null; stamp(line: string): { text: string; line: number } }
  | { kind: "entry"; slug: string; title: string; body: string; existing: string | null; stamp(line: string): { text: string; line: number } };

type Line = { content: string; start: number; next: number; newline: boolean };

// Offsets into the original text, so every slice taken from them comes back byte for byte; `content` drops the terminator and a trailing \r for matching only.
function scanLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(start, end);
    out.push({ content: raw.endsWith("\r") ? raw.slice(0, -1) : raw, start, next: nl === -1 ? text.length : nl + 1, newline: nl !== -1 });
    start = nl === -1 ? text.length : nl + 1;
  }
  return out;
}

function outsideFences(lines: Line[]): Line[] {
  const out: Line[] = [];
  const step = fenceTracker();
  for (const line of lines) {
    if (step(line.content) !== "text") continue;
    out.push(line);
  }
  return out;
}

const eolOf = (text: string): string => (firstLine(text).endsWith("\r") ? "\r\n" : "\n");

const render = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)));

export function readAdr(rel: string, text: string): PromoteSource | { refusal: string } {
  const eol = eolOf(text);
  const split = splitFrontmatter(text);
  if (!split) {
    return {
      kind: "adr",
      title: headingTitle(text),
      body: text,
      existing: null,
      stamp: (line) => ({ text: `---${eol}${line}${eol}---${eol}${text}`, line: 2 }),
    };
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(split.frontmatterLines.join("\n"), { logLevel: "error" });
  } catch (e) {
    return { refusal: `${rel}: frontmatter isn't valid YAML: ${firstLine((e as Error).message)}` };
  }
  if (!isMapping(frontmatter)) return { refusal: `${rel}: frontmatter is not a mapping` };
  const title = typeof frontmatter.title === "string" && frontmatter.title !== "" ? frontmatter.title : headingTitle(split.body);
  const existing = Object.hasOwn(frontmatter, "promoted_to") ? render(frontmatter.promoted_to) : null;
  if (existing === null && !stampsCleanly(frontmatter, split.frontmatterLines)) {
    return { refusal: `${rel}: ltm promote can't add promoted_to to this frontmatter safely; add it by hand` };
  }
  // splitFrontmatter only finds a closing fence that has a line before it, so this index exists.
  const fence = scanLines(text)[split.closingLine]!.start;
  return {
    kind: "adr",
    title,
    body: split.body,
    existing,
    stamp: (line) => ({ text: text.slice(0, fence) + line + eol + text.slice(fence), line: split.closingLine + 1 }),
  };
}

// The stamp is a plain line appended to the block, which only keeps the YAML valid for block-style mappings; a flow mapping like {title: x} would break, so parse a trial stamp and compare.
function stampsCleanly(original: Record<string, unknown>, frontmatterLines: string[]): boolean {
  const marker = "x:placeholder";
  let trial: unknown;
  try {
    trial = parse([...frontmatterLines, `promoted_to: ${marker}`].join("\n"), { logLevel: "error" });
  } catch {
    return false;
  }
  if (!isMapping(trial) || trial.promoted_to !== marker) return false;
  const { promoted_to: _stamp, ...rest } = trial;
  return isDeepStrictEqual(rest, original);
}

function headingTitle(body: string): string | null {
  for (const line of outsideFences(scanLines(body))) {
    const m = /^# (.+?)\s*$/.exec(line.content);
    if (m) return m[1]!;
  }
  return null;
}

// working-memory-kit logs write `## YYYY-MM-DD: Title`; only a real calendar date counts as that prefix.
function datedTitle(text: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}): (.+)$/.exec(text);
  return m && isCalendarDate(m[1]!) ? m[2]! : null;
}

export function readEntry(rel: string, text: string, heading: string): PromoteSource | { refusal: string } {
  const lines = scanLines(text);
  const headings = outsideFences(lines).filter((l) => l.content.startsWith("## "));
  const exact = headings.filter((l) => l.content.slice(3) === heading);
  // An exact heading wins so an undated entry stays reachable beside a dated one with the same bare title.
  const matches = exact.length > 0 ? exact : headings.filter((l) => datedTitle(l.content.slice(3)) === heading);
  if (matches.length === 0) return { refusal: `${rel} has no '## ${heading}' heading` };
  if (matches.length > 1) return { refusal: `${rel} has ${matches.length} '## ${heading}' headings` };
  const match = matches[0]!;
  const end = headings.find((l) => l.start > match.start)?.start ?? text.length;
  const fullHeading = match.content.slice(3);
  const body = text.slice(match.next, end);
  // Fence state comes from the whole file, so a fenced yaml sample in the entry never reads as a stamp.
  const stamped = outsideFences(lines).find((l) => l.start >= match.next && l.start < end && l.content.startsWith("promoted_to:"));
  const eol = eolOf(text);
  const lineNo = lines.indexOf(match) + 2;
  return {
    kind: "entry",
    // Slug and title come from the matched heading, so both spellings stamp the same anchor.
    slug: entrySlug(fullHeading),
    title: datedTitle(fullHeading) ?? fullHeading,
    body,
    existing: stamped ? stamped.content.slice("promoted_to:".length).trim() : null,
    // A heading on the last line has no terminator to insert after, so the stamp brings its own leading one and the file keeps its missing final newline.
    stamp: (line) => ({
      text: match.newline ? text.slice(0, match.next) + line + eol + text.slice(match.next) : text + eol + line,
      line: lineNo,
    }),
  };
}

// No length cap, unlike slugify: a slug here is an anchor in promoted_from, and truncation would let two long headings in one log collide.
export function entrySlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type PromoteRequest = {
  abs: string;
  rel: string;
  repo: string;
  entry?: string;
  type: MemoryType;
  title?: string;
  summary?: string;
  applies_to?: string[];
};
export type PromoteResult = ProposeRefusal | ProposeDryRun | (Proposed & { stamped: { path: string; line: number } });

const consumersOf = (raw: Record<string, unknown>, repo: string): string[] | undefined => {
  const consumers = raw.consumers;
  const list = isMapping(consumers) ? consumers[repo] : undefined;
  return Array.isArray(list) && list.every((x) => typeof x === "string") ? (list as string[]) : undefined;
};

// A name with ': ', ' #' or a leading indicator would corrupt the Consumer's frontmatter, and the stamp is written after the push.
function stampsAsPlainScalar(bank: string): boolean {
  try {
    const parsed: unknown = parse(`promoted_to: ${bank}:x`, { logLevel: "error" });
    return isMapping(parsed) && Object.keys(parsed).length === 1 && parsed.promoted_to === `${bank}:x`;
  } catch {
    return false;
  }
}

export async function promoteSource(req: PromoteRequest, deps: ProposeDeps): Promise<PromoteResult> {
  const { rel } = req;
  let text: string;
  try {
    text = readFileSync(req.abs, "utf8");
  } catch (e) {
    return { refusal: `can't read ${rel}: ${firstLine((e as Error).message)}` };
  }
  const source = req.entry === undefined ? readAdr(rel, text) : readEntry(rel, text, req.entry);
  if ("refusal" in source) return source;
  if (source.existing !== null) return { refusal: `${rel} already has promoted_to '${source.existing}'` };

  const bank = deps.config.raw.name;
  if (typeof bank !== "string") return { refusal: `${deps.config.root}/memory-bank.yaml has no name to stamp promoted_to with` };
  if (!stampsAsPlainScalar(bank)) {
    return { refusal: `${deps.config.root}/memory-bank.yaml name '${bank}' can't be written into a promoted_to line safely` };
  }
  const title = source.title ?? req.title;
  if (title === undefined) return { refusal: `${rel} has no title; pass --title` };

  const appliesTo = req.applies_to ?? consumersOf(deps.config.raw, req.repo);
  const input: ProposalInput = {
    type: req.type,
    title,
    ...(req.summary !== undefined ? { summary: req.summary } : {}),
    body: source.body,
    promoted_from: `${req.repo}:${rel}${source.kind === "entry" ? `#${source.slug}` : ""}`,
    ...(appliesTo ? { applies_to: appliesTo } : {}),
  };
  const result = await proposeRecord(input, deps);
  if ("refusal" in result || result.dryRun) return result;

  // The branch is already pushed, so a failure from here on can't undo it; the caller gets the line to add by hand.
  const stampLine = `promoted_to: ${bank}:${result.id}`;
  const byHand = `add '${stampLine}' to it by hand`;
  try {
    // Re-read: the forge call can take seconds, and an editor save in that window would be overwritten by a stamp built from the old bytes.
    if (readFileSync(req.abs, "utf8") !== text) {
      return { refusal: `pushed ${result.branch}, but ${rel} changed while the Proposal opened; ${byHand}` };
    }
    const stamped = source.stamp(stampLine);
    writeFileSync(req.abs, stamped.text);
    return { ...result, stamped: { path: rel, line: stamped.line } };
  } catch (e) {
    return { refusal: `pushed ${result.branch}, but stamping ${rel} failed: ${firstLine((e as Error).message)}; ${byHand}` };
  }
}
