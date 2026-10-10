import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecordFile, RecordError, splitFrontmatter } from "../../src/core/record.ts";

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
});
