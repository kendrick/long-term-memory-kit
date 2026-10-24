import { parse } from "yaml";
import { isMapping } from "./bank.ts";
import { splitFrontmatter } from "./record.ts";
import { firstLine } from "./text.ts";

export type PromoteSource =
  | { kind: "adr"; title: string | null; body: string; existing: string | null; stamp(line: string): { text: string; line: number } }
  | { kind: "entry"; slug: string; title: string; body: string; existing: string | null; stamp(line: string): { text: string; line: number } };

type Line = { content: string; start: number; next: number; newline: boolean };

// Offsets into the original text, so every slice taken from them comes back byte for
// byte; `content` drops the terminator and a trailing \r for matching only.
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

// Drops ``` fence lines and everything between them, so a heading-shaped line in a code
// sample never matches.
function outsideFences(lines: Line[]): Line[] {
  const out: Line[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^ {0,3}```/.test(line.content)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
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
    frontmatter = parse(split.frontmatterLines.join("\n"));
  } catch (e) {
    return { refusal: `${rel}: frontmatter isn't valid YAML: ${firstLine((e as Error).message)}` };
  }
  if (!isMapping(frontmatter)) return { refusal: `${rel}: frontmatter is not a mapping` };
  const title = typeof frontmatter.title === "string" && frontmatter.title !== "" ? frontmatter.title : headingTitle(split.body);
  const existing = Object.hasOwn(frontmatter, "promoted_to") ? render(frontmatter.promoted_to) : null;
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

function headingTitle(body: string): string | null {
  for (const line of outsideFences(scanLines(body))) {
    const m = /^# (.+?)\s*$/.exec(line.content);
    if (m) return m[1]!;
  }
  return null;
}

export function readEntry(rel: string, text: string, heading: string): PromoteSource | { refusal: string } {
  const lines = scanLines(text);
  const headings = outsideFences(lines).filter((l) => l.content.startsWith("## "));
  const matches = headings.filter((l) => l.content.slice(3) === heading);
  if (matches.length === 0) return { refusal: `${rel} has no '## ${heading}' heading` };
  if (matches.length > 1) return { refusal: `${rel} has ${matches.length} '## ${heading}' headings` };
  const match = matches[0]!;
  const end = headings.find((l) => l.start > match.start)?.start ?? text.length;
  const body = text.slice(match.next, end);
  const stamped = scanLines(body).find((l) => l.content.startsWith("promoted_to:"));
  const eol = eolOf(text);
  const lineNo = lines.indexOf(match) + 2;
  return {
    kind: "entry",
    slug: entrySlug(heading),
    title: heading,
    body,
    existing: stamped ? stamped.content.slice("promoted_to:".length).trim() : null,
    // A heading on the last line has no terminator to insert after, so the stamp brings its
    // own leading one and the file keeps its missing final newline.
    stamp: (line) => ({
      text: match.newline ? text.slice(0, match.next) + line + eol + text.slice(match.next) : text + eol + line,
      line: lineNo,
    }),
  };
}

// No length cap, unlike slugify: a slug here is an anchor in promoted_from, and truncation
// would let two long headings in one log collide.
export function entrySlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
