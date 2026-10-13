import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citedBy, classify, discover, titleOf, type Aliases, type Entry } from "../../src/core/discover.ts";
import { MEMORY_TYPES, type BankConfig } from "../../src/core/bank.ts";
import type { ParsedRecord } from "../../src/core/record.ts";

const none: Aliases = { Context: [], Decision: [] };

const rec = (id: string, fm: Record<string, unknown>): ParsedRecord => ({
  path: `_memory/decisions/${id}.md`,
  memoryType: "Decision",
  frontmatter: { id, ...fm },
});

describe("headings", () => {
  test("a Context heading inside a code fence does not count", () => {
    const text = "# T\n\n```\n## Context\n## Decision\n```\n";
    expect(classify("x/misc/a.md", text, none)).toBe("document");
  });
  test("a ~~~ fence hides headings", () => {
    const text = "# T\n\n~~~\n## Context\n## Decision\n~~~\n";
    expect(classify("x/misc/a.md", text, none)).toBe("document");
  });
  test("an inner ``` line does not close a ```` fence", () => {
    const text = "# T\n\n````\n```\n## Context\n## Decision\n```\n````\n";
    expect(classify("x/misc/a.md", text, none)).toBe("document");
  });
  test("a ~~~ line does not close a backtick fence", () => {
    const text = "# T\n\n```\n~~~\n## Context\n## Decision\n```\n";
    expect(classify("x/misc/a.md", text, none)).toBe("document");
  });
  test("headings after a fence closes count again", () => {
    const text = "# T\n\n~~~\nx\n~~~\n## Context\n## Decision\n";
    expect(classify("x/misc/a.md", text, none)).toBe("adr");
  });
  test("an unclosed fence runs to end of file", () => {
    const text = "# T\n\n```\n## Context\n## Decision\n";
    expect(classify("x/misc/a.md", text, none)).toBe("document");
  });
  test("frontmatter comments are not headings", () => {
    const text = "---\n# Context\n# Decision\n---\nbody\n";
    expect(classify("x/misc/a.md", text, none)).toBe("document");
  });
});

describe("adr", () => {
  test("by folder, with no headings", () => {
    expect(classify("x/adr/a.md", "just text\n", none)).toBe("adr");
  });
  test("by headings", () => {
    expect(classify("x/misc/a.md", "## Context\n\n## Decision\n", none)).toBe("adr");
  });
  test("Background is document without an alias", () => {
    expect(classify("x/misc/a.md", "## Background\n\n## Decision\n", none)).toBe("document");
  });
  test("Background is adr with the alias", () => {
    const aliases = { Context: ["Background"], Decision: [] };
    expect(classify("x/misc/a.md", "## Background\n\n## Decision\n", aliases)).toBe("adr");
  });
  test("a heading counts by word prefix", () => {
    const text = "## Context and Problem Statement\n\n## Decision Outcome\n";
    expect(classify("x/misc/a.md", text, none)).toBe("adr");
  });
});

describe("pr", () => {
  test("object with number, title, body", () => {
    expect(classify("p.json", '{"number":1,"title":"t","body":"b"}', none)).toBe("pr");
  });
  test("missing body", () => {
    expect(classify("p.json", '{"number":1,"title":"t"}', none)).toBeNull();
  });
  test("array", () => {
    expect(classify("p.json", "[1]", none)).toBeNull();
  });
  test("invalid JSON", () => {
    expect(classify("p.json", "{nope", none)).toBeNull();
  });
});

describe("transcript", () => {
  test(".vtt and .srt with any text", () => {
    expect(classify("a.vtt", "hello", none)).toBe("transcript");
    expect(classify("a.srt", "", none)).toBe("transcript");
  });
  test(".txt with four speaker lines is document", () => {
    const four = "Alice: hi\nBob: yo\nAlice: ok\nBob: bye\n";
    expect(classify("a.txt", four, none)).toBe("document");
  });
  test(".txt with five speaker lines is transcript", () => {
    const five = "Alice: hi\nBob: yo\nAlice: ok\nBob: bye\nAlice: ciao\n";
    expect(classify("a.txt", five, none)).toBe("transcript");
  });
});

describe("prd", () => {
  test("PRD in the H1", () => {
    expect(classify("a.md", "# PRD: x\n", none)).toBe("prd");
  });
  test("product requirements in the H1, any case", () => {
    expect(classify("a.md", "# Product requirements for x\n", none)).toBe("prd");
  });
  test("Problem plus Requirements headings", () => {
    expect(classify("a.md", "## Problem\n\n## Requirements\n", none)).toBe("prd");
  });
  test("adr wins by rule order", () => {
    expect(classify("a.md", "# PRD\n## Context\n## Decision\n", none)).toBe("adr");
  });
  test("other files and extensions", () => {
    expect(classify("a.md", "# Notes\n", none)).toBe("document");
    expect(classify("a.png", "x", none)).toBeNull();
  });
});

describe("titleOf", () => {
  test("frontmatter title wins over H1", () => {
    expect(titleOf("a.md", "document", "---\ntitle: FM\n---\n# H1\n")).toBe("FM");
  });
  test("H1 wins over the basename", () => {
    expect(titleOf("dir/a.md", "document", "# H1\n")).toBe("H1");
  });
  test("basename is the last resort", () => {
    expect(titleOf("dir/a.md", "document", "plain\n")).toBe("a.md");
  });
  test("pr uses the JSON title", () => {
    expect(titleOf("p.json", "pr", '{"number":1,"title":"Fix it","body":"b"}')).toBe("Fix it");
  });
});

describe("citedBy", () => {
  test("source_refs cites the entry path", () => {
    expect(citedBy("a/b.md", null, [rec("r1", { source_refs: ["a/b.md"] })])).toEqual(["r1"]);
  });
  test("related does not cite", () => {
    expect(citedBy("a/b.md", "a/b.md", [rec("r1", { related: ["a/b.md"] })])).toEqual([]);
  });
  test("a URL ending in /<repo-relative path> cites", () => {
    const r = rec("r1", { source_refs: ["https://example.com/acme/repo/blob/main/a/b.md"] });
    expect(citedBy("x/a/b.md", "a/b.md", [r])).toEqual(["r1"]);
    expect(citedBy("x/a/b.md", null, [r])).toEqual([]);
  });
  test("ids come back sorted", () => {
    const rs = [rec("b", { source_refs: ["a.md"] }), rec("a", { source_refs: ["a.md"] })];
    expect(citedBy("a.md", null, rs)).toEqual(["a", "b"]);
  });
});

describe("discover", () => {
  const scratch = async (fn: (dir: string) => void | Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-discover-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const run = (dir: string, args: string[]) => {
    const errors: string[] = [];
    const skips: string[] = [];
    const entries = discover(args, {
      cwd: dir,
      bank: null,
      onError: (m) => errors.push(m),
      onSkip: (p, r) => skips.push(`${p}: ${r}`),
    });
    return { entries, errors, skips };
  };

  test("walks sorted, skips dot entries, node_modules, symlinks, and big files", async () => {
    await scratch((dir) => {
      mkdirSync(join(dir, "z"));
      mkdirSync(join(dir, ".hid"));
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(join(dir, "z/b.md"), "# B\n");
      writeFileSync(join(dir, "a.md"), "# A\n");
      writeFileSync(join(dir, ".hid/c.md"), "x");
      writeFileSync(join(dir, ".dot.md"), "x");
      writeFileSync(join(dir, "node_modules/d.md"), "x");
      writeFileSync(join(dir, "big.md"), "x".repeat(1_048_577));
      writeFileSync(join(dir, "img.png"), "x");
      symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
      const { entries, skips } = run(dir, ["."]);
      expect(entries.map((e) => [e.path, e.kind, e.title, e.bytes, e.cited_by])).toEqual([
        ["a.md", "document", "A", 4, null],
        ["z/b.md", "document", "B", 4, null],
      ]);
      expect(skips).toContain("link.md: symlink, not followed");
      expect(skips).toContain("big.md: over 1 MiB");
    });
  });

  test("a missing argument is reported and the rest still listed", async () => {
    await scratch((dir) => {
      writeFileSync(join(dir, "a.md"), "x");
      const { entries, errors } = run(dir, ["nope", "a.md"]);
      expect(errors).toEqual(["nope: no such file or directory"]);
      expect(entries.map((e) => e.path)).toEqual(["a.md"]);
    });
  });

  test("skips a name containing a backslash", async () => {
    await scratch((dir) => {
      writeFileSync(join(dir, "a.md"), "# A\n");
      try {
        writeFileSync(join(dir, "b\\c.md"), "# C\n");
      } catch {
        return;
      }
      const { entries, skips } = run(dir, ["."]);
      expect(entries.map((e) => e.path)).toEqual(["a.md"]);
      expect(skips).toContain("b\\c.md: name contains a backslash");
    });
  });

  test("an alias list with a non-string member is ignored whole", async () => {
    await scratch((dir) => {
      mkdirSync(join(dir, "misc"));
      mkdirSync(join(dir, "_memory"));
      writeFileSync(join(dir, "misc/a.md"), "## Background\n\n## Decision\n");
      const withAliases = (list: unknown[]): Entry[] => {
        const bank: BankConfig = {
          root: dir,
          folders: Object.fromEntries(MEMORY_TYPES.map((t) => [t, "_memory"])) as BankConfig["folders"],
          raw: { heading_aliases: { Context: list } },
        };
        return discover(["misc"], { cwd: dir, bank, onError: () => {}, onSkip: () => {} });
      };
      expect(withAliases(["Background"]).map((e) => e.kind)).toEqual(["adr"]);
      expect(withAliases(["Background", 7]).map((e) => e.kind)).toEqual(["document"]);
    });
  });
});
