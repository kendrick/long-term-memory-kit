import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecordFile, RecordError, splitFrontmatter, unrepresentable } from "../../src/core/record.ts";

describe("splitFrontmatter", () => {
  test("canonical input", () => {
    expect(splitFrontmatter("---\na: 1\nb: x\n---\nbody\n")).toEqual({
      frontmatterLines: ["a: 1", "b: x"],
      closingLine: 3,
      body: "body\n",
    });
  });

  test("CRLF input", () => {
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\nbody\r\n")).toEqual({
      frontmatterLines: ["a: 1"],
      closingLine: 2,
      body: "body\r\n",
    });
  });

  test("stops at the first closing fence when the body has a --- line", () => {
    expect(splitFrontmatter("---\na: 1\n---\none\n---\ntwo\n")).toEqual({
      frontmatterLines: ["a: 1"],
      closingLine: 2,
      body: "one\n---\ntwo\n",
    });
  });

  test("no opening fence gives null", () => {
    expect(splitFrontmatter("a: 1\n---\nbody\n")).toBeNull();
    expect(splitFrontmatter("")).toBeNull();
  });

  test("an opening fence with no closing fence gives null", () => {
    expect(splitFrontmatter("---\na: 1\nbody\n")).toBeNull();
  });

  test("body comes back byte for byte", () => {
    const split = splitFrontmatter("---\nk: v\n---\n\n  indented\ttab\r\nmixed\n\n");
    expect(split?.body).toBe("\n  indented\ttab\r\nmixed\n\n");
  });
});

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ltm-record-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseRecordFile", () => {
  test("block and flow tags lists parse to the same array", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "flow.md"), "---\ntags: [messaging, events]\n---\n");
      await writeFile(join(dir, "block.md"), "---\ntags:\n  - messaging\n  - events\n---\n");
      const flow = parseRecordFile(join(dir, "flow.md"), "flow.md", "Decision");
      const block = parseRecordFile(join(dir, "block.md"), "block.md", "Decision");
      expect(flow.frontmatter.tags).toEqual(["messaging", "events"]);
      expect(block.frontmatter.tags).toEqual(["messaging", "events"]);
    });
  });

  test("a date stays a string under YAML 1.2", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "r.md"), "---\ndate: 2026-03-31\nschema: 1\n---\n");
      const r = parseRecordFile(join(dir, "r.md"), "x/r.md", "Context");
      expect(r.frontmatter.date).toBe("2026-03-31");
      expect(r.frontmatter.schema).toBe(1);
      expect(r.path).toBe("x/r.md");
      expect(r.memoryType).toBe("Context");
    });
  });

  test("YAML that won't parse throws RecordError", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "bad.md"), "---\ntags: [unclosed\n---\n");
      expect(() => parseRecordFile(join(dir, "bad.md"), "bad.md", "Decision")).toThrow(RecordError);
    });
  });

  test("no frontmatter throws RecordError naming the relative path", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "plain.md"), "just a body\n");
      let caught: unknown;
      try {
        parseRecordFile(join(dir, "plain.md"), "sub/plain.md", "Decision");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RecordError);
      expect((caught as RecordError).path).toBe("sub/plain.md");
    });
  });

  test("a recursive alias throws RecordError: frontmatter can't be serialized (#37)", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "cyc.md"), "---\ntitle: T\nextra: &x { self: *x }\n---\nbody\n");
      let caught: unknown;
      try {
        parseRecordFile(join(dir, "cyc.md"), "d/cyc.md", "Decision");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RecordError);
      expect((caught as RecordError).path).toBe("d/cyc.md");
      expect((caught as RecordError).message.startsWith("frontmatter can't be serialized")).toBe(true);
      expect((caught as RecordError).message).not.toContain("\n");
    });
  });

  test("a non-recursive alias parses and resolves", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "alias.md"), "---\na: &x 1\nb: *x\n---\n");
      const r = parseRecordFile(join(dir, "alias.md"), "alias.md", "Decision");
      expect(r.frontmatter.a).toBe(1);
      expect(r.frontmatter.b).toBe(1);
    });
  });
});

describe("unrepresentable", () => {
  const safe = "integer outside the safe range";
  const nonFinite = "not a finite number";
  const rounded = "number rounded on parse";
  test.each([
    ["n: 3\nf: 1.5\ne: 1e300\nok: 9007199254740991", []],
    ["big: 9007199254740993", [{ key: "big", reason: safe }]],
    ["neg: -9007199254740993", [{ key: "neg", reason: safe }]],
    ["w: .nan", [{ key: "w", reason: nonFinite }]],
    ["w: .inf", [{ key: "w", reason: nonFinite }]],
    ["w: -.inf", [{ key: "w", reason: nonFinite }]],
    ["b: !!binary aGVsbG8=", [{ key: "b", reason: "binary value" }]],
    ["s: !!set { a, b }", [{ key: "s", reason: "set" }]],
    ["o: !!omap [ { a: 1 } ]", [{ key: "o", reason: "ordered map" }]],
    ["when: !!timestamp 2001-12-14", [{ key: "when", reason: "timestamp" }]],
    ["z: -0.0", [{ key: "z", reason: "negative zero" }]],
    ["z: -0\nzf: 0.0", []],
    ["nested: { deep: [1, 9007199254740993] }", [{ key: "nested", reason: safe }]],
    ["a: 1\nz: .nan\nm: 9007199254740993", [{ key: "z", reason: nonFinite }, { key: "m", reason: safe }]],
    ["s: plain\nb: true\nn: null\nl: [x, { y: 2 }]", []],
    ["big: 9007199254740993.0", [{ key: "big", reason: rounded }]],
    ["big: 9.007199254740993e15", [{ key: "big", reason: rounded }]],
    ["f: 3.0000000000000001", [{ key: "f", reason: rounded }]],
    ["t: 1e-400", [{ key: "t", reason: rounded }]],
    ["l: [1.5, 9007199254740993.0]", [{ key: "l", reason: rounded }]],
    ["m: {a: 9007199254740993.0}", [{ key: "m", reason: rounded }]],
    ["f: 0.1", []],
    ["f: 1.50", []],
    ["f: +1.5", []],
    ["f: 1e2", []],
    ["f: .5", []],
    ["f: 5.", []],
    ["f: 9007199254740992.0", []],
    ["f: 1.0e21", []],
    ["s: '9007199254740993.0'", []],
    ["x: 1e400", [{ key: "x", reason: nonFinite }]],
    ["big: 9007199254740994", [{ key: "big", reason: safe }]],
    ["!!set\n? a\n? b", [{ key: null, reason: "set" }]],
    ["!!omap\n- a: 1\n- b: 2", [{ key: null, reason: "ordered map" }]],
    ["!!binary aGVsbG8=", [{ key: null, reason: "binary value" }]],
    ["!!timestamp 2001-12-14", [{ key: null, reason: "timestamp" }]],
    ["a: 1", []],
    ["!!merge <<: {x: 9007199254740993.0}\nb: 2", [{ key: "<<", reason: rounded }]],
    ["!!merge <<: {x: [9007199254740993.0]}", [{ key: "<<", reason: rounded }]],
    ["!!merge <<: {x: 1.5}\nb: 2", []],
    ["? &n 9007199254740993.0\n: marker\nx: *n", [{ key: "x", reason: rounded }]],
    ["a: &v 9007199254740993.0\nb: *v", [{ key: "a", reason: rounded }, { key: "b", reason: rounded }]],
    ["a: &v 1.5\nb: *v", []],
    ["a: &a [1, *a]", []],
    ["k: &k foo\n*k : 9007199254740993.0", [{ key: "*k", reason: rounded }]],
    ["k: &k foo\n*k : [9007199254740993.0]", [{ key: "*k", reason: rounded }]],
    ["~: 9007199254740993.0", [{ key: "~", reason: rounded }]],
    ["? [a]\n: 9007199254740993.0", [{ key: '["a"]', reason: rounded }]],
    ["k: &k foo\n*k : 1.5", []],
  ] as const)("%p", (src, expected) => {
    expect(unrepresentable(src)).toEqual([...expected]);
  });

  test("a recursive alias doesn't hang the walk", () => {
    expect(unrepresentable("extra: &x { self: *x, big: 9007199254740993 }")).toEqual([{ key: "extra", reason: safe }]);
  });
});

describe("parseRecordFile and unrepresentable values (#44)", () => {
  test("an integer past the safe range throws RecordError naming the key", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "big.md"), "---\ntitle: T\nbig: 9007199254740993\n---\nbody\n");
      let caught: unknown;
      try {
        parseRecordFile(join(dir, "big.md"), "d/big.md", "Decision");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RecordError);
      expect((caught as RecordError).path).toBe("d/big.md");
      expect((caught as RecordError).message).toBe(
        "frontmatter value big can't be represented in JSON: integer outside the safe range",
      );
    });
  });

  test("the value parse still hands callers a number for an integer", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "n.md"), "---\nn: 3\nf: 1.5\n---\n");
      const r = parseRecordFile(join(dir, "n.md"), "n.md", "Decision");
      expect(r.frontmatter.n).toBe(3);
      expect(r.frontmatter.f).toBe(1.5);
    });
  });
});
