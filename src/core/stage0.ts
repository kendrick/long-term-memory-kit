import { realpathSync } from "node:fs";
import { join } from "node:path";
import { RecallError, type QmdBackend } from "./qmd.ts";
import { lexical, search, type SearchOptions } from "./recall.ts";
import type { ParsedRecord } from "./record.ts";
import { byCodeUnit } from "./text.ts";

export type RankedBy = "qmd search" | "qmd vector" | "lexical";
export type RankedRow = { record: ParsedRecord; score: number; rankedBy: RankedBy };

const plural = (n: number) => (n === 1 ? "1 Record is" : `${n} Records are`);

function lexicalAll(kept: ParsedRecord[], text: string, opts?: SearchOptions): RankedRow[] {
  return search(kept, text, lexical, opts).map((h) => ({ record: h.record, score: h.score, rankedBy: "lexical" }));
}

// `notes` is the array the caller's backend `warn` also pushes onto, so warnings and Stage 0 notes share one list.
export function rankStage0(
  kept: ParsedRecord[],
  text: string,
  backend: QmdBackend,
  mode: "search" | "vector",
  minScore: number | undefined,
  bankRoot: string,
  notes: string[],
  opts?: SearchOptions,
): RankedRow[] {
  const fallback = (why: string) => {
    notes.push(`recall: ${why}; ranked by lexical`);
    return lexicalAll(kept, text, opts);
  };
  const problem = backend.preflight();
  if (problem) return fallback(problem);

  const groups = new Map<string, ParsedRecord[]>();
  const uncollected: ParsedRecord[] = [];
  for (const r of kept) {
    const c = backend.collectionOf(r);
    if (c === undefined) uncollected.push(r);
    else groups.set(c, [...(groups.get(c) ?? []), r]);
  }

  const rankedBy: RankedBy = mode === "vector" ? "qmd vector" : "qmd search";
  const ranked: RankedRow[] = [];
  const missingNotes: string[] = [];
  try {
    if (mode === "vector") {
      backend.prefetchQueries?.([...groups.keys()].map((collection) => ({ collection, text })));
    }
    const root = realpathSync(bankRoot);
    for (const [collection, group] of groups) {
      const members = new Set(group.map((r) => r.path));
      for (const h of backend.search(group, text)) {
        if (!members.has(h.record.path)) continue;
        if (minScore !== undefined && h.score < minScore) continue;
        ranked.push({ record: h.record, score: h.score, rankedBy });
      }
      const files = backend.indexed(collection);
      const missing = group.filter((r) => !files.has(join(root, r.path))).length;
      if (missing > 0) {
        const hint = mode === "vector" ? "run qmd update, then qmd embed" : "run qmd update";
        missingNotes.push(`${plural(missing)} not in qmd collection '${collection}'; ${hint}`);
      }
    }
  } catch (e) {
    if (e instanceof RecallError) return fallback(e.message);
    throw e;
  }

  notes.push(...missingNotes);
  ranked.sort((a, b) => b.score - a.score || byCodeUnit(a.record.path, b.record.path));
  return [...ranked, ...lexicalAll(uncollected, text, opts)];
}
