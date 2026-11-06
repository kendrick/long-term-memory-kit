import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallError, type QmdBackend } from "../../src/core/qmd.ts";
import type { Hit } from "../../src/core/recall.ts";
import type { ParsedRecord } from "../../src/core/record.ts";
import { rankStage0 } from "../../src/core/stage0.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "stage0-")));
const rec = (path: string, title = "redis"): ParsedRecord => ({
  path,
  memoryType: "Decision",
  frontmatter: { title, summary: "x" },
});
const collectionOf = (r: ParsedRecord) => (r.path.startsWith("d/") ? "decisions" : r.path.startsWith("c/") ? "contexts" : undefined);

type Opts = {
  scores?: Record<string, number>;
  preflight?: string | null;
  indexed?: Record<string, string[]>;
  throwIn?: string;
  extra?: Hit[];
};
function stub(o: Opts = {}) {
  const prefetched: { collection: string; text: string }[][] = [];
  const backend: QmdBackend = {
    preflight: () => o.preflight ?? null,
    collectionOf,
    search(records) {
      if (o.throwIn && collectionOf(records[0]!) === o.throwIn) throw new RecallError("qmd search failed: boom");
      const hits = records.flatMap((record) => (o.scores?.[record.path] !== undefined ? [{ record, score: o.scores[record.path]! }] : []));
      return [...hits, ...(o.extra ?? [])];
    },
    indexed: (c) => new Set((o.indexed?.[c] ?? []).map((p) => join(root, p))),
    prefetchQueries: (q) => void prefetched.push(q),
  };
  return { backend, prefetched };
}
const allIndexed = { decisions: ["d/a.md", "d/b.md", "d/c.md"], contexts: ["c/a.md"] };

describe("rankStage0", () => {
  test("ranks by score across collections, path breaks ties, uncollected lexical rows come last", () => {
    const kept = [rec("d/b.md"), rec("c/a.md"), rec("d/a.md"), rec("x/z.md", "redis redis redis")];
    const { backend } = stub({ scores: { "d/a.md": 0.4, "d/b.md": 0.4, "c/a.md": 0.9 }, indexed: allIndexed });
    const notes: string[] = [];
    const rows = rankStage0(kept, "redis", backend, "search", undefined, root, notes);
    expect(rows.map((r) => [r.record.path, r.rankedBy])).toEqual([
      ["c/a.md", "qmd search"],
      ["d/a.md", "qmd search"],
      ["d/b.md", "qmd search"],
      ["x/z.md", "lexical"],
    ]);
    expect(rows[0]!.score).toBe(0.9);
    expect(notes).toEqual([]);
  });

  test("minScore is inclusive", () => {
    const kept = [rec("d/a.md"), rec("d/b.md")];
    const { backend } = stub({ scores: { "d/a.md": 0.49, "d/b.md": 0.5 }, indexed: allIndexed });
    const rows = rankStage0(kept, "redis", backend, "search", 0.5, root, []);
    expect(rows.map((r) => r.record.path)).toEqual(["d/b.md"]);
  });

  test("a preflight problem ranks everything with lexical and says so", () => {
    const kept = [rec("d/a.md"), rec("c/a.md", "redis redis")];
    const { backend } = stub({ preflight: "qmd not found on PATH" });
    const notes: string[] = [];
    const rows = rankStage0(kept, "redis", backend, "search", undefined, root, notes);
    expect(rows.map((r) => [r.record.path, r.rankedBy])).toEqual([
      ["c/a.md", "lexical"],
      ["d/a.md", "lexical"],
    ]);
    expect(notes).toEqual(["recall: qmd not found on PATH; ranked by lexical"]);
  });

  test("a RecallError from a later collection discards every qmd row", () => {
    const kept = [rec("d/a.md"), rec("c/a.md")];
    const { backend } = stub({ scores: { "d/a.md": 0.9, "c/a.md": 0.8 }, indexed: allIndexed, throwIn: "contexts" });
    const notes: string[] = [];
    const rows = rankStage0(kept, "redis", backend, "search", undefined, root, notes);
    expect(rows.every((r) => r.rankedBy === "lexical")).toBe(true);
    expect(rows).toHaveLength(2);
    expect(notes).toEqual(["recall: qmd search failed: boom; ranked by lexical"]);
  });

  test("a non-RecallError propagates", () => {
    const { backend } = stub();
    backend.search = () => {
      throw new TypeError("bug");
    };
    expect(() => rankStage0([rec("d/a.md")], "redis", backend, "search", undefined, root, [])).toThrow("bug");
  });

  test("a Record missing from the index gets a singular note, several get a plural one", () => {
    const { backend } = stub({ scores: { "d/a.md": 0.9 }, indexed: { decisions: ["d/a.md"] } });
    const one: string[] = [];
    rankStage0([rec("d/a.md"), rec("d/b.md")], "redis", backend, "search", undefined, root, one);
    expect(one).toEqual(["1 Record is not in qmd collection 'decisions'; run qmd update"]);
    const two: string[] = [];
    rankStage0([rec("d/a.md"), rec("d/b.md"), rec("d/c.md")], "redis", backend, "search", undefined, root, two);
    expect(two).toEqual(["2 Records are not in qmd collection 'decisions'; run qmd update"]);
  });

  test("under vector the missing hint adds qmd embed", () => {
    const { backend } = stub({ indexed: { decisions: [] } });
    const notes: string[] = [];
    rankStage0([rec("d/a.md")], "redis", backend, "vector", undefined, root, notes);
    expect(notes).toEqual(["1 Record is not in qmd collection 'decisions'; run qmd update, then qmd embed"]);
  });

  test("a hit for a Record outside the group is ignored", () => {
    const { backend } = stub({ scores: { "d/a.md": 0.5 }, indexed: allIndexed, extra: [{ record: rec("d/stranger.md"), score: 0.99 }] });
    const rows = rankStage0([rec("d/a.md")], "redis", backend, "search", undefined, root, []);
    expect(rows.map((r) => r.record.path)).toEqual(["d/a.md"]);
  });

  test("vector prefetches one query per collection, once, and tags rows qmd vector", () => {
    const { backend, prefetched } = stub({ scores: { "d/a.md": 0.7, "c/a.md": 0.6 }, indexed: allIndexed });
    const rows = rankStage0([rec("d/a.md"), rec("d/b.md"), rec("c/a.md")], "free words", backend, "vector", undefined, root, []);
    expect(prefetched).toHaveLength(1);
    expect(prefetched[0]!.map((q) => q.collection).sort()).toEqual(["contexts", "decisions"]);
    expect(prefetched[0]!.every((q) => q.text === "free words")).toBe(true);
    expect(rows.map((r) => r.rankedBy)).toEqual(["qmd vector", "qmd vector"]);
  });

  test("search mode never prefetches", () => {
    const { backend, prefetched } = stub({ indexed: allIndexed });
    rankStage0([rec("d/a.md")], "redis", backend, "search", undefined, root, []);
    expect(prefetched).toEqual([]);
  });
});
