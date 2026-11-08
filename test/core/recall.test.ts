import { describe, expect, test } from "bun:test";
import type { ParsedRecord } from "../../src/core/record.ts";
import { lexical, search, tokenize } from "../../src/core/recall.ts";

const rec = (path: string, frontmatter: Record<string, unknown>, body?: string): ParsedRecord => ({
  path,
  memoryType: "Decision",
  frontmatter,
  ...(body === undefined ? {} : { body }),
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

describe("body search", () => {
  const paths = (hits: { record: ParsedRecord }[]) => hits.map((h) => h.record.path);

  test("body off: a body-only word doesn't match", () => {
    expect(search([rec("a.md", { title: "Queues" }, "We chose kafka.")], "kafka")).toEqual([]);
  });

  test("body on: a body-only word matches", () => {
    const r = rec("a.md", { title: "Queues" }, "We chose kafka.");
    expect(search([r], "kafka", lexical, { body: true }).map((h) => h.record)).toEqual([r]);
  });

  test("body on: a word inside a fenced code block still matches", () => {
    const r = rec("a.md", { title: "Queues" }, "```\nkafka\n```\n");
    expect(search([r], "kafka", lexical, { body: true })).toHaveLength(1);
  });

  test("body on: a header match ranks above a body-only match with more hits", () => {
    const head = rec("z.md", { title: "Kafka" }, "");
    const body = rec("a.md", { title: "Queues" }, "kafka ".repeat(10));
    expect(paths(search([body, head], "kafka", lexical, { body: true }))).toEqual(["z.md", "a.md"]);
  });

  test("body on: tokens split across title and body match in the body tier", () => {
    const split = rec("a.md", { title: "Kafka" }, "for orders");
    const whole = rec("b.md", { title: "Kafka orders" }, "");
    expect(paths(search([split, whole], "kafka orders", lexical, { body: true }))).toEqual(["b.md", "a.md"]);
    expect(paths(search([split, whole], "kafka orders"))).toEqual(["b.md"]);
  });

  test("body on: header-tier scores and order equal body off", () => {
    const records = [
      rec("c.md", { title: "kafka" }, "unrelated"),
      rec("a.md", { title: "Kafka kafka" }, "unrelated"),
      rec("b.md", { title: "kafka" }, "unrelated"),
    ];
    expect(search(records, "kafka", lexical, { body: true })).toEqual(search(records, "kafka"));
  });

  test("body on, empty text: every Record, same as body off", () => {
    const records = [rec("z.md", { title: "a" }, "x"), rec("a.md", { title: "b" })];
    expect(search(records, "", lexical, { body: true })).toEqual(search(records, ""));
    expect(search(records, "", lexical, { body: true })).toHaveLength(2);
  });
});
