import { describe, expect, test } from "bun:test";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, checkRecordText, checkUniqueIds, validateBank, type Finding } from "../../src/core/validate.ts";
import { parseDocument } from "yaml";
import { withScratch } from "../helpers/scratch.ts";

const valid = readFileSync(
  new URL("../../fixtures/demo-bank/_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md", import.meta.url),
  "utf8",
);
const rel = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const demoPrefixes = ["service", "domain", "system", "team", "platform"];

// Found from the text rather than hard-coded, so a fixture gaining a key doesn't shift every assertion.
function lineOf(text: string, prefix: string): number {
  const i = text.split("\n").findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error(`no line starting '${prefix}'`);
  return i + 1;
}

function replaceLine(text: string, prefix: string, replacement: string | null): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error(`no line starting '${prefix}'`);
  if (replacement === null) lines.splice(i, 1);
  else lines[i] = replacement;
  const out = lines.join("\n");
  expect(out).not.toBe(text);
  return out;
}

const check = (text: string, prefixes: string[] | null = demoPrefixes, folder: "Decision" | "Context" = "Decision") =>
  checkRecordText(rel, folder, text, prefixes).findings;

const rules = (fs: Finding[]) => fs.map((f) => f.rule);

const blockTags = (text: string) => replaceLine(text, "tags:", "tags:\n  - database\n  - postgres");

describe("checkRecordText", () => {
  test("the demo Record gives no findings and reports its id", () => {
    const out = checkRecordText(rel, "Decision", valid, demoPrefixes);
    expect(out.findings).toEqual([]);
    expect(out.id).toBe("kQ7vN2xLp4");
  });

  test("a missing status is one schema finding on line 1", () => {
    const fs = check(replaceLine(valid, "status:", null));
    expect(fs).toEqual([
      {
        file: rel,
        line: 1,
        rule: "schema",
        severity: "error",
        key: "status",
        message: "must have required property 'status'",
      },
    ]);
  });

  test("a missing id says ltm fmt will add it", () => {
    const fs = check(replaceLine(valid, "id:", null));
    expect(fs).toHaveLength(1);
    expect(fs[0]!.key).toBe("id");
    expect(fs[0]!.message.endsWith("; `ltm fmt` will add it")).toBe(true);
  });

  test("a present but invalid key is reported on its own line", () => {
    const text = replaceLine(valid, "status:", "status: maybe");
    const fs = check(text);
    expect(fs).toHaveLength(1);
    expect(fs[0]!).toMatchObject({ rule: "schema", key: "status", line: lineOf(text, "status:") });
  });

  test("block-style tags fail canonical-list on the tags line", () => {
    const text = blockTags(valid);
    const fs = check(text);
    expect(fs).toHaveLength(1);
    expect(fs[0]!).toMatchObject({ rule: "canonical-list", key: "tags", line: lineOf(text, "tags:") });
    expect(fs[0]!.message).toContain("single-line");
    expect(fs[0]!.message).toContain("`tags: [database, postgres]`");
  });

  test("single-line flow lists pass, including an empty one", () => {
    expect(check(replaceLine(valid, "tags:", "tags: [a, b]"))).toEqual([]);
    expect(check(replaceLine(valid, "tags:", "tags: []"))).toEqual([]);
  });

  test("a flow list split over two lines fails canonical-list", () => {
    const text = replaceLine(valid, "tags:", "tags: [a,\n  b]");
    const fs = check(text);
    expect(rules(fs)).toEqual(["canonical-list"]);
    expect(fs[0]!.line).toBe(lineOf(text, "tags:"));
  });

  describe("line-budget", () => {
    const closing = (text: string) => text.split("\n").indexOf("---", 1) + 1;
    const pad = (text: string, n: number) => {
      const lines = text.split("\n");
      const at = lines.indexOf("---", 1);
      const extra = Array.from({ length: n }, (_, i) => `x${String(i + 1).padStart(2, "0")}: v`);
      lines.splice(at, 0, ...extra);
      return lines.join("\n");
    };
    const atTwenty = pad(valid, 20 - closing(valid));

    test("a closing fence on line 20 passes", () => {
      expect(closing(atTwenty)).toBe(20);
      expect(check(atTwenty)).toEqual([]);
    });

    test("a closing fence on line 21 fails on line 21", () => {
      const text = pad(valid, 21 - closing(valid));
      expect(closing(text)).toBe(21);
      const fs = check(text);
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "line-budget", line: 21, key: null });
      expect(fs[0]!.message).toBe("frontmatter closes on line 21; the budget is 20");
    });

    test("body lines never count", () => {
      const text = atTwenty + Array.from({ length: 30 }, (_, i) => `body ${i}`).join("\n") + "\n";
      expect(text.split("\n").length).toBeGreaterThan(50);
      expect(check(text)).toEqual([]);
    });
  });

  describe("folder-type", () => {
    const asContext = replaceLine(valid, "memory_type:", "memory_type: Context");

    test("memory_type Context in the Decision folder fails", () => {
      const fs = check(asContext, demoPrefixes, "Decision");
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "folder-type", key: "memory_type", line: lineOf(asContext, "memory_type:") });
      expect(fs[0]!.message).toContain("'Context'");
      expect(fs[0]!.message).toContain("Decision folder");
    });

    test("the same text in the Context folder passes", () => {
      expect(check(asContext, demoPrefixes, "Context")).toEqual([]);
    });

    test("memory_type Decision in Decision passes whatever rel says", () => {
      expect(checkRecordText("_memory/context/elsewhere.md", "Decision", valid, demoPrefixes).findings).toEqual([]);
    });
  });

  describe("facet-prefix", () => {
    const withFacet = (entry: string) =>
      replaceLine(replaceLine(valid, "owners:", null), "applies_to:", `applies_to: [${entry}]`);

    test("an unlisted prefix fails on the applies_to line", () => {
      const text = withFacet("serivce:order-service");
      const fs = check(text, ["service"]);
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "facet-prefix", key: "applies_to", line: lineOf(text, "applies_to:") });
      expect(fs[0]!.message).toBe("'serivce:order-service' uses prefix 'serivce', which facet_prefixes doesn't list");
    });

    test("a listed prefix passes", () => {
      expect(check(withFacet("service:order-service"), ["service"])).toEqual([]);
    });

    test("listing the misspelling makes it pass, so the check reads the prefixes it is given", () => {
      expect(check(withFacet("serivce:order-service"), ["service", "serivce"])).toEqual([]);
    });

    test("owners is checked too, one finding per bad entry", () => {
      const fs = check(valid, ["domain", "system"]);
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "facet-prefix", key: "owners" });
    });

    test("null prefixes skip the check", () => {
      expect(check(withFacet("serivce:order-service"), null)).toEqual([]);
    });
  });

  test("three defects in one Record give three findings", () => {
    let text = replaceLine(valid, "status:", null);
    text = blockTags(text);
    text = replaceLine(text, "applies_to:", "applies_to: [serivce:x]");
    expect(rules(check(text)).sort()).toEqual(["canonical-list", "facet-prefix", "schema"]);
  });

  describe("frontmatter", () => {
    test("no opening fence", () => {
      const fs = check(valid.slice(valid.indexOf("\n") + 1));
      expect(fs).toEqual([
        {
          file: rel,
          line: 1,
          rule: "frontmatter",
          severity: "error",
          key: null,
          message: "no frontmatter block (expected --- on line 1 and a closing ---)",
        },
      ]);
    });

    test("no closing fence", () => {
      const lines = valid.split("\n");
      lines.splice(lines.indexOf("---", 1), 1);
      expect(lines.indexOf("---", 1)).toBe(-1);
      const fs = check(lines.join("\n"));
      expect(rules(fs)).toEqual(["frontmatter"]);
      expect(fs[0]!.line).toBe(1);
    });

    test("YAML that won't parse points at the bad line", () => {
      // Line 1 is the fence, line 2 `schema: 1`, line 3 the unclosed list.
      const text = "---\nschema: 1\ntitle: [unclosed\n---\nbody\n";
      const fs = check(text);
      expect(rules(fs)).toEqual(["frontmatter"]);
      expect(fs[0]!.line).toBe(3);
      expect(fs[0]!.key).toBeNull();
      expect(fs[0]!.message).not.toContain("\n");
    });

    test("a non-mapping frontmatter", () => {
      const fs = check("---\n- a\n- b\n---\n");
      expect(fs).toEqual([
        { file: rel, line: 1, rule: "frontmatter", severity: "error", key: null, message: "frontmatter is not a YAML mapping" },
      ]);
    });
  });
});

describe("checkUniqueIds", () => {
  test("two entries sharing an id give one finding on the first path", () => {
    const fs = checkUniqueIds(
      [
        { file: "_memory/decisions/b.md", line: 3, id: "dup0000000" },
        { file: "_memory/context/a.md", line: 4, id: "dup0000000" },
        { file: "_memory/context/c.md", line: 3, id: "solo000000" },
      ],
      null,
    );
    expect(fs).toEqual([
      {
        file: "_memory/context/a.md",
        line: 4,
        rule: "unique-id",
        severity: "error",
        key: "id",
        message: "id 'dup0000000' is also used by _memory/decisions/b.md",
      },
    ]);
  });

  test("with named paths, a group is reported only when one of its files was named", () => {
    const ids = [
      { file: "a.md", line: 3, id: "dup0000000" },
      { file: "b.md", line: 3, id: "dup0000000" },
    ];
    expect(checkUniqueIds(ids, new Set(["c.md"]))).toEqual([]);
    expect(checkUniqueIds(ids, new Set(["b.md"]))).toHaveLength(1);
  });
});

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));
const invalidDir = fileURLToPath(new URL("../../fixtures/invalid", import.meta.url));

test("every invalid fixture Record gives at least one finding naming it", () => {
  const cases = readdirSync(invalidDir).filter((f) => f.endsWith(".md"));
  expect(cases.length).toBeGreaterThan(0);
  for (const name of cases) {
    const file = `_memory/decisions/${name}`;
    const fs = checkRecordText(file, "Decision", readFileSync(join(invalidDir, name), "utf8"), demoPrefixes).findings;
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.every((f) => f.file === file)).toBe(true);
  }
});

describe("validateBank", () => {
  test("the demo Bank is clean", () => {
    expect(validateBank(demoBank, null, demoBank)).toEqual([]);
  });

  test("a duplicate id across the Bank is one unique-id finding naming both paths", async () => {
    await withScratch(demoBank, async (dir) => {
      const copy = "_memory/context/copy-of-postgres.md";
      writeFileSync(join(dir, copy), replaceLine(valid, "memory_type:", "memory_type: Context"));
      const fs = validateBank(dir, null, dir);
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "unique-id", key: "id", file: copy });
      expect(fs[0]!.message).toContain(rel);
    });
  });

  test("named paths limit per-Record findings and flag a non-Record path", async () => {
    await withScratch(demoBank, async (dir) => {
      writeFileSync(join(dir, rel), replaceLine(valid, "status:", null));
      const other = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";
      expect(validateBank(dir, [other], dir)).toEqual([]);
      const fs = validateBank(dir, [rel, "README.md"], dir);
      expect(fs.map((f) => [f.file, f.rule])).toEqual([
        ["README.md", "walk"],
        [rel, "schema"],
      ]);
    });
  });

  test("findings come back sorted by file, then line", async () => {
    await withScratch(demoBank, async (dir) => {
      // line-budget is computed before facet-prefix but sits on a later line, so emit order alone would be wrong.
      const lines = replaceLine(valid, "applies_to:", "applies_to: [serivce:x]").split("\n");
      const at = lines.indexOf("---", 1);
      lines.splice(at, 0, ...Array.from({ length: 21 - (at + 1) }, (_, i) => `x${i}: v`));
      writeFileSync(join(dir, rel), lines.join("\n"));
      const fs = validateBank(dir, null, dir);
      expect(fs.map((f) => f.rule)).toEqual(["facet-prefix", "line-budget"]);
    });
  });
});

describe("checkConfig", () => {
  const invalidDir = fileURLToPath(new URL("../../fixtures/invalid", import.meta.url));

  test("the demo config gives no findings and loads", () => {
    const { findings, config } = checkConfig(demoBank);
    expect(findings).toEqual([]);
    expect(config).not.toBeNull();
  });

  test("an unknown top-level key is one config-schema finding on that key's line", async () => {
    await withScratch(demoBank, async (dir) => {
      const path = join(dir, "memory-bank.yaml");
      const before = readFileSync(path, "utf8");
      writeFileSync(path, `${before.trimEnd()}\ncolour: blue\n`);
      const { findings, config } = checkConfig(dir);
      expect(config).not.toBeNull();
      expect(findings).toEqual([
        {
          file: "memory-bank.yaml",
          line: before.trimEnd().split("\n").length + 1,
          rule: "config-schema",
          severity: "error",
          key: "colour",
          message: expect.any(String),
        },
      ]);
    });
  });

  test("a missing required key is named, at line 1 since the file has no such line", async () => {
    await withScratch(demoBank, async (dir) => {
      writeFileSync(join(dir, "memory-bank.yaml"), "schema: 1\nname: acme\n");
      const { findings } = checkConfig(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]!).toMatchObject({ rule: "config-schema", key: "facet_prefixes", line: 1 });
    });
  });

  test("a nested error is reported against its top-level key's line", async () => {
    await withScratch(demoBank, async (dir) => {
      writeFileSync(
        join(dir, "memory-bank.yaml"),
        "schema: 1\nname: acme\nfacet_prefixes: [service]\ndoctor:\n  stale_confirmed_days: 0\n",
      );
      const { findings } = checkConfig(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]!).toMatchObject({ rule: "config-schema", key: "doctor", line: 4 });
    });
  });

  test("unparseable YAML is one config-schema finding and no config", async () => {
    await withScratch(demoBank, async (dir) => {
      writeFileSync(join(dir, "memory-bank.yaml"), "name: [unclosed\n");
      const { findings, config } = checkConfig(dir);
      expect(config).toBeNull();
      expect(findings).toHaveLength(1);
      expect(findings[0]!).toMatchObject({ file: "memory-bank.yaml", rule: "config-schema", key: null });
    });
  });

  test("each invalid config fixture fails config-schema", async () => {
    for (const name of ["config-extra-key", "consumers-key-newline"]) {
      await withScratch(demoBank, async (dir) => {
        copyFileSync(join(invalidDir, name, "memory-bank.yaml"), join(dir, "memory-bank.yaml"));
        const { findings } = checkConfig(dir);
        expect(findings.length).toBeGreaterThanOrEqual(1);
        expect(findings.every((f) => f.rule === "config-schema" && f.file === "memory-bank.yaml")).toBe(true);
      });
    }
  });

  test("schema findings from a config that loads don't stop Record checks", async () => {
    await withScratch(demoBank, async (dir) => {
      const path = join(dir, "memory-bank.yaml");
      writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\ncolour: blue\n`);
      writeFileSync(join(dir, rel), replaceLine(valid, "status:", null));
      expect(validateBank(dir, null, dir).map((f) => f.rule)).toEqual(["schema", "config-schema"]);
    });
  });

  test("a config that won't load stops Record checks", async () => {
    await withScratch(demoBank, async (dir) => {
      writeFileSync(join(dir, "memory-bank.yaml"), "name: [unclosed\n");
      writeFileSync(join(dir, rel), replaceLine(valid, "status:", null));
      expect(validateBank(dir, null, dir).map((f) => f.rule)).toEqual(["config-schema"]);
    });
  });
});

// Each level multiplies by nine, so the expanded size blows past yaml's alias limit
// while the source stays a few lines long and parses without error.
function aliasBomb(): string {
  const lines = ["a: &a [x, x, x, x, x, x, x, x, x]"];
  for (const [from, to] of [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]]) {
    lines.push(`${to}: &${to} [${Array(9).fill(`*${from}`).join(", ")}]`);
  }
  return lines.join("\n");
}

describe("alias bombs", () => {
  test("the bomb parses cleanly but throws from toJS", () => {
    const doc = parseDocument(aliasBomb());
    expect(doc.errors).toEqual([]);
    expect(() => doc.toJS()).toThrow(/alias/);
  });

  test("in a Record, it is one frontmatter finding at line 1", () => {
    const fs = check(`---\n${aliasBomb()}\n---\nbody\n`);
    expect(fs).toEqual([
      { file: rel, line: 1, rule: "frontmatter", severity: "error", key: null, message: expect.any(String) },
    ]);
    expect(fs[0]!.message).toContain("alias");
    expect(fs[0]!.message).not.toContain("\n");
  });

  test("in memory-bank.yaml, it is one config-schema finding and no config", async () => {
    await withScratch(demoBank, async (dir) => {
      writeFileSync(join(dir, "memory-bank.yaml"), `schema: 1\nname: acme\nfacet_prefixes: [service]\n${aliasBomb()}\n`);
      const { findings, config } = checkConfig(dir);
      expect(config).toBeNull();
      expect(findings).toEqual([
        { file: "memory-bank.yaml", line: 1, rule: "config-schema", severity: "error", key: null, message: expect.any(String) },
      ]);
      expect(findings[0]!.message).toContain("alias");
      expect(validateBank(dir, null, dir)).toEqual(findings);
    });
  });
});

describe("unique-id under named paths", () => {
  const ids = [
    { file: "a.md", line: 3, id: "dup0000000" },
    { file: "b.md", line: 4, id: "dup0000000" },
    { file: "c.md", line: 5, id: "dup0000000" },
  ];

  test("naming only a later member puts the finding on it and lists the rest", () => {
    expect(checkUniqueIds(ids, new Set(["c.md"]))).toEqual([
      { file: "c.md", line: 5, rule: "unique-id", severity: "error", key: "id", message: "id 'dup0000000' is also used by a.md, b.md" },
    ]);
  });

  test("with several named members, the first named in sort order carries it", () => {
    expect(checkUniqueIds(ids, new Set(["c.md", "b.md"]))).toEqual([
      { file: "b.md", line: 4, rule: "unique-id", severity: "error", key: "id", message: "id 'dup0000000' is also used by a.md, c.md" },
    ]);
  });

  test("with no named paths, the first path still carries it", () => {
    expect(checkUniqueIds(ids, null)).toEqual([
      { file: "a.md", line: 3, rule: "unique-id", severity: "error", key: "id", message: "id 'dup0000000' is also used by b.md, c.md" },
    ]);
  });

  test("validateBank naming only the later duplicate reports on that file", async () => {
    await withScratch(demoBank, async (dir) => {
      const copy = "_memory/decisions/zz-copy.md";
      expect(copy > rel).toBe(true);
      writeFileSync(join(dir, copy), valid);
      expect(validateBank(dir, [copy], dir)).toEqual([
        { file: copy, line: lineOf(valid, "id:"), rule: "unique-id", severity: "error", key: "id", message: `id '${/^id: (.*)$/m.exec(valid)![1]}' is also used by ${rel}` },
      ]);
    });
  });
});
