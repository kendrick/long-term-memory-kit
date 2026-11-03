import type { ParsedRecord } from "./record.ts";
import { byCodeUnit } from "./text.ts";

export type Hit = { record: ParsedRecord; score: number };

// `ltm doctor` reads `recall:` and plugs qmd in through `src/core/qmd.ts`; `ltm query` still uses `lexical` only.
export interface RecallBackend {
  search(records: ParsedRecord[], text: string): Hit[];
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

function countOccurrences(haystack: string, token: string): number {
  let n = 0;
  for (let i = haystack.indexOf(token); i !== -1; i = haystack.indexOf(token, i + token.length)) n++;
  return n;
}

// Title and summary sit in the header, which closes early for a cheap read. Searching the
// body too would let a passing mention outrank a Record that's about the topic.
function haystack(record: ParsedRecord): string {
  const { title, summary } = record.frontmatter;
  return [title, summary]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

export const lexical: RecallBackend = {
  search(records, text) {
    const tokens = tokenize(text);
    // No tokens means no constraint, so callers can pass `--text ""` through untouched.
    if (tokens.length === 0) return records.map((record) => ({ record, score: 0 }));
    const hits: Hit[] = [];
    for (const record of records) {
      const hay = haystack(record);
      let score = 0;
      let all = true;
      for (const t of tokens) {
        const n = countOccurrences(hay, t);
        if (n === 0) {
          all = false;
          break;
        }
        score += n;
      }
      if (all) hits.push({ record, score });
    }
    // Code-unit path compare on ties, not localeCompare, so order doesn't vary by locale.
    hits.sort(
      (a, b) =>
        b.score - a.score || byCodeUnit(a.record.path, b.record.path),
    );
    return hits;
  },
};

export function search(records: ParsedRecord[], text: string, backend: RecallBackend = lexical): Hit[] {
  return backend.search(records, text);
}
