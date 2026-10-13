import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfig } from "../../src/core/bank.ts";
import {
  canonicalFrontmatter,
  canonicalScalar,
  SCHEMA_KEY_ORDER,
} from "../../src/core/canonical.ts";
import { listRecordFiles } from "../../src/core/query.ts";
import { splitFrontmatter } from "../../src/core/record.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

// Same call record.ts makes, so these tests read YAML the way every Record reader does.
const fm = (yaml: string): Record<string, unknown> => parse(yaml) as Record<string, unknown>;
const canon = (yaml: string): unknown => canonicalFrontmatter(fm(yaml), SCHEMA_KEY_ORDER, "\n");

describe("SCHEMA_KEY_ORDER", () => {
  test("is the record schema's property order", () => {
    expect(SCHEMA_KEY_ORDER).toEqual([
      "schema",
      "id",
      "memory_type",
      "title",
      "status",
      "date",
      "effective_from",
      "effective_to",
      "last_confirmed",
      "review_by",
      "summary",
      "superseded_by",
      "supersedes",
      "promoted_from",
      "promoted_to",
      "subject",
      "applies_to",
      "owners",
      "tags",
      "source_refs",
      "related",
    ]);
  });
});

describe("canonicalFrontmatter key order", () => {
  test("shuffled keys come out in schema order, extra keys after every schema key", () => {
    const shuffled = [
      "deciders: [alice, bob]",
      "tags: [messaging, events]",
      "summary: Publish order events.",
      "date: 2026-04-22",
      "title: Adopt a message queue",
      "memory_type: Decision",
      "status: accepted",
      "id: hT5cY8dUa6",
      "schema: 1",
      "owners: [team:commerce-architecture]",
      "last_confirmed: 2026-05-01",
    ].join("\n");
    expect(canon(shuffled)).toBe(
      "schema: 1\n" +
        "id: hT5cY8dUa6\n" +
        "memory_type: Decision\n" +
        "title: Adopt a message queue\n" +
        "status: accepted\n" +
        "date: 2026-04-22\n" +
        "last_confirmed: 2026-05-01\n" +
        "summary: Publish order events.\n" +
        "owners: [team:commerce-architecture]\n" +
        "tags: [messaging, events]\n" +
        "deciders: [alice, bob]\n",
    );
  });

  test("non-schema keys keep their original relative order", () => {
    expect(canon("zeta: 1\nid: x\nalpha: 2")).toBe("id: x\nzeta: 1\nalpha: 2\n");
  });

  test("CRLF ends every line in CRLF", () => {
    expect(canonicalFrontmatter(fm("tags: [a]\nschema: 1"), SCHEMA_KEY_ORDER, "\r\n")).toBe(
      "schema: 1\r\ntags: [a]\r\n",
    );
  });

  test("an empty mapping gives no lines", () => {
    expect(canonicalFrontmatter({}, SCHEMA_KEY_ORDER, "\n")).toBe("");
  });
});

describe("canonicalFrontmatter scalars", () => {
  test("a plain string with an apostrophe stays plain", () => {
    expect(canon("summary: Order-service may read inventory-service's Redis")).toBe(
      "summary: Order-service may read inventory-service's Redis\n",
    );
  });

  test("a string that would parse as a mapping comes back double-quoted", () => {
    expect(canon('title: "a: b"')).toBe('title: "a: b"\n');
  });

  test("a numeric-looking string stays quoted", () => {
    expect(canon('x: "123"')).toBe('x: "123"\n');
  });

  test("a single-quoted string that needs no quotes comes back plain", () => {
    expect(canon("title: 'Adopt Postgres'")).toBe("title: Adopt Postgres\n");
  });

  test("a date stays bare", () => {
    expect(canon("date: 2026-02-10")).toBe("date: 2026-02-10\n");
  });

  test("numbers, booleans, and null", () => {
    expect(canon("schema: 1\ndraft: false\nsupersedes: null\nratio: 0.5\nempty:")).toBe(
      "schema: 1\nsupersedes: null\ndraft: false\nratio: 0.5\nempty: null\n",
    );
  });

  test("strings that would parse as other types, or lose bytes, are quoted", () => {
    expect(canon('a: "true"\nb: "null"\nc: ""\nd: " padded "\ne: "x # y"\nf: "two\\nlines"')).toBe(
      'a: "true"\nb: "null"\nc: ""\nd: " padded "\ne: "x # y"\nf: "two\\nlines"\n',
    );
  });
});

describe("canonicalFrontmatter lists", () => {
  test("a flow list stays one line", () => {
    expect(canon("tags: [a, b]")).toBe("tags: [a, b]\n");
  });

  test("a block list gives the same line", () => {
    expect(canon("tags:\n  - a\n  - b")).toBe("tags: [a, b]\n");
  });

  test("an empty list", () => {
    expect(canon("tags: []")).toBe("tags: []\n");
  });

  test("a typed relation stays plain inside the flow list", () => {
    expect(canon("related: [constrained_by::nR5hB2yTq8]")).toBe("related: [constrained_by::nR5hB2yTq8]\n");
  });

  test("an entry holding a comma comes back quoted", () => {
    expect(canon('tags: ["a, b"]')).toBe('tags: ["a, b"]\n');
  });

  test("entries that are fine in block context but not in flow are quoted", () => {
    expect(canon('tags: ["a]", "{b}", c]')).toBe('tags: ["a]", "{b}", c]\n');
  });

  test("scalar types inside a list", () => {
    expect(canon('xs: [1, true, null, "2"]')).toBe('xs: [1, true, null, "2"]\n');
  });
});

describe("refusals", () => {
  test("a nested mapping is refused", () => {
    const out = canonicalFrontmatter({ nested: { a: 1 } }, SCHEMA_KEY_ORDER, "\n");
    expect(out).toEqual({ reason: expect.stringContaining("nested") });
  });

  test("a list holding a list is refused", () => {
    const out = canonicalFrontmatter({ xs: [[1]] }, SCHEMA_KEY_ORDER, "\n");
    expect(out).toEqual({ reason: expect.stringContaining("xs") });
  });

  test("a list holding a mapping is refused", () => {
    const out = canonicalFrontmatter({ xs: [{ a: 1 }] }, SCHEMA_KEY_ORDER, "\n");
    expect(out).toEqual({ reason: expect.stringContaining("xs") });
  });

  test("canonicalScalar refuses non-scalars", () => {
    expect(canonicalScalar({ a: 1 }, false)).toEqual({ reason: expect.any(String) });
    expect(canonicalScalar([1], true)).toEqual({ reason: expect.any(String) });
    expect(canonicalScalar(undefined, false)).toEqual({ reason: expect.any(String) });
  });
});

describe("canonicalScalar", () => {
  test("block and flow context", () => {
    expect(canonicalScalar("a, b", false)).toBe("a, b");
    expect(canonicalScalar("a, b", true)).toBe('"a, b"');
    expect(canonicalScalar("2026-02-10", false)).toBe("2026-02-10");
    expect(canonicalScalar("123", false)).toBe('"123"');
    expect(canonicalScalar(123, true)).toBe("123");
    expect(canonicalScalar(false, false)).toBe("false");
    expect(canonicalScalar(null, true)).toBe("null");
  });
});

describe("demo-bank round trip", () => {
  const config = loadConfig(demoBank);
  const files = listRecordFiles(config, () => {});

  test("the bank has Records to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Judged by what the parser reads back, not by comparing strings this module
  // produced, so a serializer bug can't agree with itself.
  for (const { abs, rel } of files) {
    test(rel, () => {
      const split = splitFrontmatter(readFileSync(abs, "utf8"));
      expect(split).not.toBeNull();
      const before = parse(split!.frontmatterLines.join("\n"));
      const out = canonicalFrontmatter(before, SCHEMA_KEY_ORDER, "\n");
      expect(typeof out).toBe("string");
      expect(parse(out as string)).toEqual(before);
    });
  }
});
