import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isMapping, type MemoryType } from "./bank.ts";

export type Split = { frontmatterLines: string[]; closingLine: number; body: string };

const isFence = (line: string): boolean => line === "---" || line === "---\r";

// Scans line by line instead of splitting on "\n" so `body` can be sliced from the
// original text and come back byte for byte, terminators and all.
export function splitFrontmatter(text: string): Split | null {
  const frontmatterLines: string[] = [];
  let start = 0;
  let index = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end);
    if (index === 0) {
      if (!isFence(line)) return null;
    } else if (isFence(line)) {
      return { frontmatterLines, closingLine: index, body: nl === -1 ? "" : text.slice(nl + 1) };
    } else {
      frontmatterLines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (nl === -1) return null;
    start = nl + 1;
    index++;
  }
  return null;
}

export type ParsedRecord = {
  path: string;
  memoryType: MemoryType;
  frontmatter: Record<string, unknown>;
};

export class RecordError extends Error {
  constructor(
    public path: string,
    message: string,
  ) {
    super(message);
    this.name = "RecordError";
  }
}

// `memoryType` comes from the caller (the folder), never from the frontmatter:
// the folder is the source of truth and a mismatch is #9's to report.
export function parseRecordFile(absPath: string, relPath: string, memoryType: MemoryType): ParsedRecord {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    throw new RecordError(relPath, (e as Error).message);
  }
  const split = splitFrontmatter(text);
  if (!split) throw new RecordError(relPath, "no frontmatter");
  let frontmatter: unknown;
  try {
    frontmatter = parse(split.frontmatterLines.join("\n"));
  } catch (e) {
    throw new RecordError(relPath, (e as Error).message.split("\n")[0] ?? "invalid YAML");
  }
  if (!isMapping(frontmatter)) throw new RecordError(relPath, "frontmatter is not a YAML mapping");
  return { path: relPath, memoryType, frontmatter };
}
