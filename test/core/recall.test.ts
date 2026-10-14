import { describe, expect, test } from "bun:test";
import type { ParsedRecord } from "../../src/core/record.ts";
import { lexical, search, tokenize } from "../../src/core/recall.ts";

const rec = (path: string, frontmatter: Record<string, unknown>): ParsedRecord => ({
  path,
  memoryType: "Decision",
  frontmatter,
});

describe("tokenize", () => {
  test("lowercases and splits on anything that isn't a letter or digit", () => {
    expect(tokenize("Postgres, MySQL!")).toEqual(["postgres", "mysql"]);
  });

  test("punctuation alone gives no tokens", () => {
    expect(tokenize("--")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("lexical.search", () => {
  test("more occurrences rank first", () => {
    const once = rec("a.md", { title: "Use Redis", summary: "A cache." });
    const thrice = rec("b.md", { title: "Redis, redis", summary: "Pin REDIS 7." });
    const hits = lexical.search([once, thrice], "redis");
    expect(hits.map((h) => h.record.path)).toEqual(["b.md", "a.md"]);
    expect(hits.map((h) => h.score)).toEqual([3, 1]);
  });

  test("equal scores fall back to path order", () => {
    const b = rec("b.md", { title: "redis" });
    const a = rec("a.md", { title: "redis" });
    expect(lexical.search([b, a], "redis").map((h) => h.record.path)).toEqual(["a.md", "b.md"]);
  });

  // Code-unit order puts "B" (0x42) before "a" (0x61); localeCompare reverses them.
  test("equal scores sort by code unit, so an uppercase path precedes a lowercase one", () => {
    const lower = rec("_memory/decisions/a-cache.md", { title: "Use redis", summary: "A cache." });
    const upper = rec("_memory/decisions/B-cache.md", { title: "Use redis", summary: "A cache." });
    const hits = lexical.search([lower, upper], "redis");
    expect(hits[0]?.score).toBe(hits[1]?.score);
    expect(hits.map((h) => h.record.path)).toEqual(["_memory/decisions/B-cache.md", "_memory/decisions/a-cache.md"]);
  });

  test("a token outside title and summary doesn't match", () => {
    const bodyOnly = rec("a.md", { title: "Databases", summary: "Pick one.", body: "postgres", tags: ["postgres"] });
    expect(lexical.search([bodyOnly], "postgres")).toEqual([]);
  });

  test("every token must appear", () => {
    const both = rec("both.md", { title: "Postgres over MySQL", summary: "x" });
    const split = rec("split.md", { title: "Postgres", summary: "not mysql here" });
    const pgOnly = rec("pg.md", { title: "Postgres everywhere", summary: "x" });
    const myOnly = rec("my.md", { title: "MySQL", summary: "x" });
    const hits = lexical.search([both, split, pgOnly, myOnly], "postgres mysql");
    expect(hits.map((h) => h.record.path).sort()).toEqual(["both.md", "split.md"]);
  });

  test("a Record with no title and no summary matches no non-empty query", () => {
    const bare = rec("a.md", { status: "accepted" });
    const nonString = rec("b.md", { title: 7, summary: ["redis"] });
    expect(lexical.search([bare, nonString], "redis")).toEqual([]);
    expect(lexical.search([bare, nonString], "7")).toEqual([]);
  });

  test("a query with no tokens matches every Record at score 0, in input order", () => {
    const records = [rec("z.md", { title: "Z" }), rec("a.md", {}), rec("m.md", { title: "M" })];
    for (const text of ["", "--"]) {
      const hits = lexical.search(records, text);
      expect(hits.map((h) => h.record.path)).toEqual(["z.md", "a.md", "m.md"]);
      expect(hits.every((h) => h.score === 0)).toBe(true);
    }
  });
});

describe("search", () => {
  test("defaults to the lexical backend", () => {
    const records = [rec("a.md", { title: "redis" }), rec("b.md", { title: "kafka" })];
    expect(search(records, "redis")).toEqual(lexical.search(records, "redis"));
  });

  test("uses the backend it is given", () => {
    const records = [rec("a.md", { title: "redis" })];
    const fixed = { search: () => [{ record: records[0]!, score: 42 }] };
    expect(search(records, "anything", fixed)).toEqual([{ record: records[0]!, score: 42 }]);
  });
});
