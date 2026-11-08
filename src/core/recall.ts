import type { ParsedRecord } from "./record.ts";
import { byCodeUnit } from "./text.ts";

export type Hit = { record: ParsedRecord; score: number };

export type SearchOptions = { body?: boolean };

// `ltm doctor` and `ltm query --text` read `recall:` and plug qmd in through `src/core/qmd.ts`; without it they use `lexical`.
export interface RecallBackend {
  search(records: ParsedRecord[], text: string, opts?: SearchOptions): Hit[];
  // A backend whose matching differs from qmd search's AND-every-word picks its own query; null skips the Record.
  queryText?(record: ParsedRecord): string | null;
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

// Title and summary sit in the header, which closes early for a cheap read. The body is opt-in per query, and only as a second tier, so a passing mention can't outrank a Record that's about the topic.
function haystack(record: ParsedRecord): string {
  const { title, summary } = record.frontmatter;
  return [title, summary]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

export const lexical: RecallBackend = {
  search(records, text, opts) {
    const tokens = tokenize(text);
    // No tokens means no constraint, so callers can pass `--text ""` through untouched.
    if (tokens.length === 0) return records.map((record) => ({ record, score: 0 }));
    const scoreOf = (hay: string): number | null => {
      let score = 0;
      for (const t of tokens) {
        const n = countOccurrences(hay, t);
        if (n === 0) return null;
        score += n;
      }
      return score;
    };
    const hits: Hit[] = [];
    const bodyHits: Hit[] = [];
    for (const record of records) {
      const hay = haystack(record);
      const score = scoreOf(hay);
      if (score !== null) hits.push({ record, score });
      else if (opts?.body) {
        // Tokens may split across header and body, so the second pass sees both.
        const s = scoreOf(`${hay} ${(record.body ?? "").toLowerCase()}`);
        if (s !== null) bodyHits.push({ record, score: s });
      }
    }
    // Code-unit path compare on ties, not localeCompare, so order doesn't vary by locale.
    const byScore = (a: Hit, b: Hit) => b.score - a.score || byCodeUnit(a.record.path, b.record.path);
    // Each tier sorts alone and the body tier goes last, so a body hit never outranks a header hit.
    return [...hits.sort(byScore), ...bodyHits.sort(byScore)];
  },
};

export function search(
  records: ParsedRecord[],
  text: string,
  backend: RecallBackend = lexical,
  opts?: SearchOptions,
): Hit[] {
  return backend.search(records, text, opts);
}
