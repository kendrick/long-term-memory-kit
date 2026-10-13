import { describe, expect, test } from "bun:test";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, checkRecordText, checkUniqueIds, validateBank, validateBankReport, type Finding } from "../../src/core/validate.ts";
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
      const lines = replaceLine(valid, "applies_to:", "applies_to: [domain:commerce, serivce:x]").split("\n");
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

describe("supersession checks", () => {
  const oldRel = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";
  const newRel = rel;
  const supersession = (fs: Finding[]) => fs.filter((f) => f.rule.startsWith("supersession-"));

  // Every mutation is read back before the run that depends on it, so a no-op edit can't pass as green.
  async function mutate(dir: string, file: string, fn: (text: string) => string): Promise<string> {
    const before = readFileSync(join(dir, file), "utf8");
    const after = fn(before);
    writeFileSync(join(dir, file), after);
    const read = readFileSync(join(dir, file), "utf8");
    expect(read).toBe(after);
    expect(read).not.toBe(before);
    return read;
  }

  test("the fixture's superseded pair passes every supersession check", async () => {
    await withScratch(demoBank, async (dir) => {
      expect(supersession(validateBankReport(dir, null, dir).findings)).toEqual([]);
    });
  });

  test("deleting supersedes from the newer Record is one supersession-incomplete naming both files", async () => {
    await withScratch(demoBank, async (dir) => {
      const text = await mutate(dir, newRel, (t) => replaceLine(t, "supersedes:", null));
      expect(text).not.toContain("supersedes:");
      const fs = validateBankReport(dir, null, dir).findings;
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "supersession-incomplete", severity: "error", file: oldRel, key: "superseded_by" });
      expect(fs[0]!.line).toBe(lineOf(readFileSync(join(dir, oldRel), "utf8"), "superseded_by:"));
      expect(`${fs[0]!.file} ${fs[0]!.message}`).toContain(oldRel);
      expect(`${fs[0]!.file} ${fs[0]!.message}`).toContain(newRel);
    });
  });

  test("deleting superseded_by from the older Record is one supersession-incomplete on the newer Record", async () => {
    await withScratch(demoBank, async (dir) => {
      await mutate(dir, oldRel, (t) => replaceLine(t, "superseded_by:", null));
      const fs = validateBankReport(dir, null, dir).findings;
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "supersession-incomplete", file: newRel, key: "supersedes" });
      expect(fs[0]!.message).toContain(oldRel);
    });
  });

  test("an older Record that is still accepted gives supersession-status on its status line", async () => {
    await withScratch(demoBank, async (dir) => {
      const text = await mutate(dir, oldRel, (t) => replaceLine(t, "status:", "status: accepted"));
      expect(text).toContain("status: accepted");
      expect(text).toContain("superseded_by: kQ7vN2xLp4");
      const fs = validateBankReport(dir, null, dir).findings;
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "supersession-status", file: oldRel, key: "status", line: lineOf(text, "status:") });
    });
  });

  test("supersession-status falls back to the superseded_by line when status is missing", async () => {
    await withScratch(demoBank, async (dir) => {
      const text = await mutate(dir, oldRel, (t) => replaceLine(t, "status:", null));
      const fs = supersession(validateBankReport(dir, null, dir).findings);
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "supersession-status", line: lineOf(text, "superseded_by:") });
    });
  });

  test("a made-up superseded_by id is one supersession-missing-target on that key", async () => {
    await withScratch(demoBank, async (dir) => {
      const text = await mutate(dir, oldRel, (t) => replaceLine(t, "superseded_by:", "superseded_by: zZ9zZ9zZ9z"));
      expect(text).toContain("superseded_by: zZ9zZ9zZ9z");
      const all = supersession(validateBankReport(dir, null, dir).findings);
      // The newer Record still supersedes the older one, which no longer points back: a second, correct finding.
      expect(all.map((f) => f.rule).sort()).toEqual(["supersession-incomplete", "supersession-missing-target"]);
      const fs = all.filter((f) => f.rule === "supersession-missing-target");
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({
        rule: "supersession-missing-target",
        file: oldRel,
        key: "superseded_by",
        line: lineOf(text, "superseded_by:"),
        message: "superseded_by names 'zZ9zZ9zZ9z', which no Record has",
      });
    });
  });

  test("a made-up supersedes entry is one supersession-missing-target on that key", async () => {
    await withScratch(demoBank, async (dir) => {
      await mutate(dir, newRel, (t) => replaceLine(t, "supersedes:", "supersedes: [mB3tR9wZe1, zZ9zZ9zZ9z]"));
      const fs = supersession(validateBankReport(dir, null, dir).findings);
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "supersession-missing-target", file: newRel, key: "supersedes" });
      expect(fs[0]!.message).toContain("'zZ9zZ9zZ9z'");
    });
  });

  describe("supersession-facets", () => {
    // A fresh cross-linked pair, so scope is the only thing that can fail.
    const pair = (oldScope: string | null, newScope: string | null, extra = { old: "", new: "" }) => {
      const record = (id: string, title: string, status: string, link: string, scope: string | null, more: string) =>
        [
          "---",
          "schema: 1",
          `id: ${id}`,
          "memory_type: Decision",
          `title: ${title}`,
          `status: ${status}`,
          "date: 2026-01-01",
          `summary: ${title}.`,
          link,
          ...(scope === null ? [] : [`applies_to: ${scope}`]),
          ...(more ? [more] : []),
          "---",
          "",
          "## Context",
          "c",
          "",
          "## Decision",
          "d",
          "",
          "## Consequences",
          "e",
          "",
        ].join("\n");
      return {
        old: record("aA1aA1aA1a", "Old way", "superseded", "superseded_by: bB2bB2bB2b", oldScope, extra.old),
        new: record("bB2bB2bB2b", "New way", "accepted", "supersedes: [aA1aA1aA1a]", newScope, extra.new),
      };
    };
    const oldFile = "_memory/decisions/old-way-aA1aA1aA1a.md";
    const newFile = "_memory/decisions/new-way-bB2bB2bB2b.md";
    const run = async (p: { old: string; new: string }) =>
      withScratch(demoBank, async (dir) => {
        writeFileSync(join(dir, oldFile), p.old);
        writeFileSync(join(dir, newFile), p.new);
        expect(readFileSync(join(dir, oldFile), "utf8")).toBe(p.old);
        expect(readFileSync(join(dir, newFile), "utf8")).toBe(p.new);
        return validateBankReport(dir, null, dir).findings;
      });

    test("disjoint scopes give exactly one supersession-facets finding naming both paths", async () => {
      const fs = await run(pair("[service:a]", "[service:b]"));
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "supersession-facets", file: oldFile, key: "applies_to" });
      expect(fs[0]!.message).toContain(oldFile);
      expect(fs[0]!.message).toContain(newFile);
    });

    test("a shared entry among several passes", async () => {
      expect(await run(pair("[service:a]", "[service:a, domain:x]"))).toEqual([]);
    });

    test("a newer Record with no applies_to passes", async () => {
      expect(await run(pair("[service:a]", null))).toEqual([]);
    });

    test("an older Record with an empty applies_to passes", async () => {
      expect(await run(pair("[]", "[service:b]"))).toEqual([]);
    });

    test("overlapping only tags or only owners still fails", async () => {
      for (const key of ["tags", "owners"]) {
        const fs = await run(pair("[service:a]", "[service:b]", { old: `${key}: [team:x]`, new: `${key}: [team:x]` }));
        expect(fs.map((f) => f.rule)).toEqual(["supersession-facets"]);
      }
    });
  });

  test("with paths naming only the newer Record, the incomplete finding on the older one still appears", async () => {
    await withScratch(demoBank, async (dir) => {
      await mutate(dir, newRel, (t) => replaceLine(t, "supersedes:", null));
      const fs = validateBankReport(dir, [newRel], dir).findings;
      expect(fs).toHaveLength(1);
      expect(fs[0]!).toMatchObject({ rule: "supersession-incomplete", file: oldRel });
    });
  });

  test("with paths naming an unrelated Record, supersession findings are dropped", async () => {
    await withScratch(demoBank, async (dir) => {
      await mutate(dir, newRel, (t) => replaceLine(t, "supersedes:", null));
      const other = "_memory/decisions/trunk-based-deployment-rX6jK1fWc9.md";
      expect(validateBankReport(dir, [other], dir).findings).toEqual([]);
    });
  });
});
