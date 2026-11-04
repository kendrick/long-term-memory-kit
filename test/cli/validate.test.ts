import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const invalid = new URL("../../fixtures/invalid", import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });
const lines = (stdout: string) => stdout.split("\n").filter((l) => l !== "");

const PG = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const NOT_A_RECORD = "not a Record file under any configured type folder";

// Lines are found from the text, never hard-coded: other lanes add keys to the demo Records.
function lineOf(text: string, prefix: string): number {
  const i = text.split("\n").findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error(`no line starting '${prefix}'`);
  return i + 1;
}

function replaceLine(text: string, prefix: string, replacement: string | null): string {
  const ls = text.split("\n");
  const i = ls.findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error(`no line starting '${prefix}'`);
  if (replacement === null) ls.splice(i, 1);
  else ls[i] = replacement;
  return ls.join("\n");
}

// Writes, then reads back, so a replacement that matched nothing fails here and not as a false green later.
function edit(file: string, fn: (text: string) => string): string {
  const before = readFileSync(file, "utf8");
  writeFileSync(file, fn(before));
  const after = readFileSync(file, "utf8");
  expect(after).not.toBe(before);
  return after;
}

const blockTags = (text: string) => {
  const items = /^tags: \[(.*)\]$/m.exec(text)![1]!.split(", ");
  return replaceLine(text, "tags:", ["tags:", ...items.map((t) => `  - ${t}`)].join("\n"));
};

const threeDefects = (text: string) =>
  replaceLine(blockTags(replaceLine(text, "status:", null)), "applies_to:", "applies_to: [domain:commerce, serivce:x]");

// A second Record built from the demo one, so it stays schema-valid as the fixture evolves.
// It drops `supersedes`: the older Record points at the original, so a copy keeping it is a half-declared Supersession.
const freshRecord = (pg: string, id: string) => replaceLine(replaceLine(pg, "id:", `id: ${id}`), "supersedes:", null);

describe("ltm validate", () => {
  test("1: an unmodified demo Bank exits 0 with empty stdout", async () => {
    await withScratch(demo, async (dir) => {
      expect(readFileSync(join(dir, PG), "utf8")).toBe(readFileSync(join(demo, PG), "utf8"));
      const r = await ltm(dir, "validate");
      expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      const j = await ltm(dir, "validate", "--json");
      expect(j).toEqual({ exitCode: 0, stdout: "[]\n", stderr: "" });
    });
  });

  test("2: removing status fails schema on that file and key", async () => {
    await withScratch(demo, async (dir) => {
      const after = edit(join(dir, PG), (t) => replaceLine(t, "status:", null));
      expect(after).not.toMatch(/^status:/m);
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      const hit = lines(r.stdout).filter((l) => l.startsWith(`${PG}:`) && l.includes("error schema: status:"));
      expect(hit).toHaveLength(1);
      expect(hit[0]).toStartWith(`${PG}:1: error schema: status: `);
    });
  });

  test("3: block-style tags fail canonical-list on the tags line", async () => {
    await withScratch(demo, async (dir) => {
      const after = edit(join(dir, PG), blockTags);
      expect(after).toMatch(/^tags:\n {2}- /m);
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      const hit = lines(r.stdout).find((l) => l.startsWith(`${PG}:${lineOf(after, "tags:")}: error canonical-list: tags: `));
      expect(hit).toBeDefined();
      expect(hit).toContain("single-line");
    });
  });

  describe("4: the three falsifiers end to end", () => {
    const pad = (text: string, n: number, key = "x") => {
      const ls = text.split("\n");
      const closing = ls.indexOf("---", 1);
      ls.splice(closing, 0, ...Array.from({ length: n }, (_, i) => `${key}${String(i + 1).padStart(2, "0")}: v`));
      return ls.join("\n");
    };
    const closingLine = (text: string) => text.split("\n").indexOf("---", 1) + 1;

    test("line-budget: fence on 20 passes, on 21 fails, body lines never count", async () => {
      await withScratch(demo, async (dir) => {
        const pg = readFileSync(join(dir, PG), "utf8");
        const file = "_memory/decisions/padded-pP0aD0dE01.md";
        const fresh = freshRecord(pg, "pP0aD0dE01");
        const atTwenty = pad(fresh, 20 - closingLine(fresh));
        expect(closingLine(atTwenty)).toBe(20);

        writeFileSync(join(dir, file), atTwenty + "\nbody\n".repeat(30));
        expect(await ltm(dir, "validate")).toMatchObject({ exitCode: 0, stdout: "" });

        writeFileSync(join(dir, file), pad(atTwenty, 1, "y"));
        const r = await ltm(dir, "validate");
        expect(r.exitCode).toBe(1);
        expect(lines(r.stdout)).toEqual([`${file}:21: error line-budget: -: frontmatter closes on line 21; the budget is 20`]);
      });
    });

    test("folder-type: Context in decisions fails, and passes once moved unedited", async () => {
      await withScratch(demo, async (dir) => {
        const pg = readFileSync(join(dir, PG), "utf8");
        const text = replaceLine(freshRecord(pg, "fF0lD0eR01"), "memory_type:", "memory_type: Context");
        const name = "moved-fF0lD0eR01.md";
        writeFileSync(join(dir, "_memory/decisions", name), text);

        const r = await ltm(dir, "validate");
        expect(r.exitCode).toBe(1);
        expect(lines(r.stdout)).toHaveLength(1);
        expect(lines(r.stdout)[0]).toStartWith(
          `_memory/decisions/${name}:${lineOf(text, "memory_type:")}: error folder-type: memory_type: `,
        );

        renameSync(join(dir, "_memory/decisions", name), join(dir, "_memory/context", name));
        expect(readFileSync(join(dir, "_memory/context", name), "utf8")).toBe(text);
        expect(await ltm(dir, "validate")).toMatchObject({ exitCode: 0, stdout: "" });
      });
    });

    test("canonical-list: block tags fail, flow tags pass", async () => {
      await withScratch(demo, async (dir) => {
        const pg = readFileSync(join(dir, PG), "utf8");
        const file = "_memory/decisions/lists-lI0sT0sA01.md";
        const flow = freshRecord(pg, "lI0sT0sA01");
        const block = blockTags(flow);
        expect(block).not.toBe(flow);

        writeFileSync(join(dir, file), block);
        const r = await ltm(dir, "validate");
        expect(r.exitCode).toBe(1);
        expect(lines(r.stdout)).toHaveLength(1);
        expect(lines(r.stdout)[0]).toStartWith(`${file}:${lineOf(block, "tags:")}: error canonical-list: tags: `);

        writeFileSync(join(dir, file), flow);
        expect(await ltm(dir, "validate")).toMatchObject({ exitCode: 0, stdout: "" });
      });
    });
  });

  test("5: facet-prefix reads facet_prefixes from the scratch config", async () => {
    await withScratch(demo, async (dir) => {
      const misspelled = edit(join(dir, PG), (t) => replaceLine(t, "applies_to:", "applies_to: [domain:commerce, serivce:order-service]"));
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      expect(lines(r.stdout)).toEqual([
        `${PG}:${lineOf(misspelled, "applies_to:")}: error facet-prefix: applies_to: 'serivce:order-service' uses prefix 'serivce', which facet_prefixes doesn't list`,
      ]);

      edit(join(dir, PG), (t) => replaceLine(t, "applies_to:", "applies_to: [domain:commerce, service:order-service]"));
      expect(await ltm(dir, "validate")).toMatchObject({ exitCode: 0, stdout: "" });

      edit(join(dir, PG), (t) => replaceLine(t, "applies_to:", "applies_to: [domain:commerce, serivce:order-service]"));
      const cfg = edit(join(dir, "memory-bank.yaml"), (t) => t.replace(/^facet_prefixes: \[/m, "facet_prefixes: [serivce, "));
      expect(cfg).toMatch(/^facet_prefixes: \[serivce, /m);
      expect(await ltm(dir, "validate")).toMatchObject({ exitCode: 0, stdout: "" });
    });
  });

  test("6: two Records sharing an id give one unique-id line naming both", async () => {
    await withScratch(demo, async (dir) => {
      const copy = "_memory/decisions/postgres-copy.md";
      copyFileSync(join(dir, PG), join(dir, copy));
      expect(readFileSync(join(dir, copy), "utf8")).toBe(readFileSync(join(dir, PG), "utf8"));
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      const hits = lines(r.stdout).filter((l) => l.includes(" error unique-id: "));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(PG);
      expect(hits[0]).toContain(copy);
    });
  });

  test("7: an unknown config key fails config-schema on its line", async () => {
    await withScratch(demo, async (dir) => {
      const cfg = edit(join(dir, "memory-bank.yaml"), (t) => `${t.endsWith("\n") ? t : `${t}\n`}colour: blue\n`);
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      expect(lines(r.stdout).some((l) => l.startsWith(`memory-bank.yaml:${lineOf(cfg, "colour:")}: error config-schema: colour: `))).toBe(true);
    });
  });

  describe("8: every fixtures/invalid case fails, naming its file", () => {
    const entries = readdirSync(invalid, { withFileTypes: true });
    const records = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    const configs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    test("the fixture folder holds both kinds of case", () => {
      expect(records.length).toBeGreaterThan(0);
      expect(configs.length).toBeGreaterThan(0);
    });

    test.each(records)("Record %s", async (name) => {
      await withScratch(demo, async (dir) => {
        copyFileSync(join(invalid, name), join(dir, "_memory/decisions", name));
        const r = await ltm(dir, "validate");
        expect(r.exitCode).toBe(1);
        expect(lines(r.stdout).some((l) => l.startsWith(`_memory/decisions/${name}:`))).toBe(true);
      });
    });

    test.each(configs)("config %s", async (name) => {
      await withScratch(demo, async (dir) => {
        copyFileSync(join(invalid, name, "memory-bank.yaml"), join(dir, "memory-bank.yaml"));
        const r = await ltm(dir, "validate");
        expect(r.exitCode).toBe(1);
        expect(lines(r.stdout).some((l) => l.startsWith("memory-bank.yaml:"))).toBe(true);
      });
    });
  });

  test("9: three defects in one Record give three lines in one run", async () => {
    await withScratch(demo, async (dir) => {
      edit(join(dir, PG), threeDefects);
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      const ls = lines(r.stdout);
      expect(ls).toHaveLength(3);
      expect(ls.every((l) => l.startsWith(`${PG}:`))).toBe(true);
      expect(ls.map((l) => /: error ([a-z-]+): /.exec(l)?.[1]).sort()).toEqual(["canonical-list", "facet-prefix", "schema"]);
    });
  });

  test("10: --json on the three-defect Record prints three six-key objects", async () => {
    await withScratch(demo, async (dir) => {
      edit(join(dir, PG), threeDefects);
      const r = await ltm(dir, "validate", "--json");
      expect(r.exitCode).toBe(1);
      expect(r.stdout.endsWith("]\n")).toBe(true);
      const rows = JSON.parse(r.stdout) as Record<string, unknown>[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(Object.keys(row)).toEqual(["file", "line", "rule", "severity", "key", "message"]);
        expect(row.severity).toBe("error");
        expect(row.file).toBe(PG);
      }
      expect(r.stdout).toBe(`${JSON.stringify(rows, null, 2)}\n`);
    });
  });

  test("11: named paths limit findings, and a stray path gives a walk finding", async () => {
    await withScratch(demo, async (dir) => {
      const other = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";
      edit(join(dir, PG), (t) => replaceLine(t, "status:", null));
      edit(join(dir, other), (t) => replaceLine(t, "status:", null));

      const all = await ltm(dir, "validate");
      expect(lines(all.stdout).some((l) => l.startsWith(`${other}:`))).toBe(true);

      const one = await ltm(dir, "validate", PG);
      expect(one.exitCode).toBe(1);
      expect(lines(one.stdout).length).toBeGreaterThan(0);
      expect(lines(one.stdout).every((l) => l.startsWith(`${PG}:`))).toBe(true);

      writeFileSync(join(dir, "notes.md"), "just notes\n");
      const stray = await ltm(dir, "validate", "notes.md");
      expect(stray.exitCode).toBe(1);
      expect(lines(stray.stdout)).toEqual([`notes.md:1: error walk: -: ${NOT_A_RECORD}`]);
    });
  });

  test("12: a symlinked Record gives a walk finding and exit 1", async () => {
    await withScratch(demo, async (dir) => {
      const outside = mkdtempSync(join(tmpdir(), "ltm-validate-link-"));
      try {
        const target = join(outside, "target.md");
        writeFileSync(target, freshRecord(readFileSync(join(dir, PG), "utf8"), "sY0mL0iN01"));
        const link = "_memory/decisions/linked-sY0mL0iN01.md";
        symlinkSync(target, join(dir, link));
        const r = await ltm(dir, "validate");
        expect(r.exitCode).toBe(1);
        expect(lines(r.stdout).some((l) => l.startsWith(`${link}:1: error walk: -: `))).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("12b: a symlinked memory-bank.yaml exits 1 with the findBank refusal on stderr", async () => {
    await withScratch(demo, async (dir) => {
      const outside = mkdtempSync(join(tmpdir(), "ltm-validate-cfg-"));
      try {
        const real = join(outside, "memory-bank.yaml");
        copyFileSync(join(dir, "memory-bank.yaml"), real);
        rmSync(join(dir, "memory-bank.yaml"));
        symlinkSync(real, join(dir, "memory-bank.yaml"));
        // Without validate's ConfigError catch, run() rejects instead of returning this result.
        const r = await ltm(dir, "validate");
        expect(r).toEqual({
          exitCode: 1,
          stdout: "",
          stderr: `ltm validate: ${join(dir, "memory-bank.yaml")}: memory-bank.yaml is a symlink, not followed\n`,
        });
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("13: outside any Bank, exits 1 and stderr names the dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-validate-nobank-"));
    try {
      const r = await ltm(dir, "validate");
      expect(r).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `ltm validate: no memory-bank.yaml in ${dir} or any parent directory\n`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("14: validate leaves the scratch tree byte-identical", async () => {
    await withScratch(demo, async (dir) => {
      edit(join(dir, PG), threeDefects);
      copyFileSync(join(dir, PG), join(dir, "_memory/decisions/dup.md"));
      const snapshot = () =>
        (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
          .map((e) => {
            const p = join(e.parentPath, e.name);
            const hash = e.isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex") : e.isDirectory() ? "dir" : "other";
            return `${p} ${hash}`;
          })
          .sort();
      const before = snapshot();
      expect(before.length).toBeGreaterThan(10);
      expect((await ltm(dir, "validate")).exitCode).toBe(1);
      expect((await ltm(dir, "validate", "--json")).exitCode).toBe(1);
      expect((await ltm(dir, "validate", PG)).exitCode).toBe(1);
      expect(snapshot()).toEqual(before);
    });
  });

  test("15: an alias bomb in a Record or the config is a finding, not a crash", async () => {
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x]"];
    for (const [from, to] of [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]]) {
      bomb.push(`${to}: &${to} [${Array(9).fill(`*${from}`).join(", ")}]`);
    }
    await withScratch(demo, async (dir) => {
      const rec = "_memory/decisions/bomb.md";
      writeFileSync(join(dir, rec), `---\n${bomb.join("\n")}\n---\nbody\n`);
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("");
      expect(lines(r.stdout).filter((l) => l.startsWith(`${rec}:`))).toEqual([
        expect.stringMatching(new RegExp(`^${rec}:1: error frontmatter: -: .*alias`)),
      ]);
    });
    await withScratch(demo, async (dir) => {
      edit(join(dir, "memory-bank.yaml"), (t) => `${t.endsWith("\n") ? t : `${t}\n`}${bomb.join("\n")}\n`);
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("");
      expect(lines(r.stdout)).toEqual([expect.stringMatching(/^memory-bank\.yaml:1: error config-schema: -: .*alias/)]);
    });
  });

  test("16: naming only the later of two duplicate ids reports on the named file", async () => {
    await withScratch(demo, async (dir) => {
      const copy = "_memory/decisions/zz-copy.md";
      copyFileSync(join(dir, PG), join(dir, copy));
      const r = await ltm(dir, "validate", copy);
      expect(r.exitCode).toBe(1);
      expect(lines(r.stdout)).toHaveLength(1);
      expect(lines(r.stdout)[0]).toStartWith(`${copy}:`);
      expect(lines(r.stdout)[0]).toContain(" error unique-id: ");
      expect(lines(r.stdout)[0]).toContain(PG);
    });
  });
  describe("17: --format picks a CI report", () => {
    const REDIS = "_memory/exceptions/order-service-redis-until-2027-03-wJ3nC7hTy4.md";
    const MYSQL = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";

    // One schema error on PG, and one bright-line warning; the Exception keeps a dangling constrained_by:: link so exception-link doesn't add a third finding.
    const oneOfEach = async (dir: string) => {
      edit(join(dir, PG), (t) => replaceLine(t, "status:", null));
      edit(join(dir, REDIS), (t) => replaceLine(t, "related:", "related: [constrained_by::zZ9zZ9zZ9z]"));
      const human = lines((await ltm(dir, "validate")).stdout);
      expect(human).toHaveLength(2);
      expect(human.some((l) => l.startsWith(`${PG}:`) && l.includes(" error schema: "))).toBe(true);
      expect(human.some((l) => l.startsWith(`${REDIS}:`) && l.includes(" warning bright-line: "))).toBe(true);
    };

    test("github prints one annotation per finding and exits 1", async () => {
      await withScratch(demo, async (dir) => {
        await oneOfEach(dir);
        const r = await ltm(dir, "validate", "--format", "github");
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toBe("");
        expect(r.stdout.endsWith("\n")).toBe(true);
        const ls = r.stdout.slice(0, -1).split("\n");
        expect(ls).toHaveLength(2);
        expect(ls.filter((l) => l.startsWith("::error "))).toEqual([expect.stringContaining("title=schema::")]);
        expect(ls.filter((l) => l.startsWith("::warning "))).toEqual([expect.stringContaining("title=bright-line::")]);
      });
    });

    test("gitlab parses as JSON with two Code Quality elements and stable fingerprints", async () => {
      await withScratch(demo, async (dir) => {
        await oneOfEach(dir);
        const r = await ltm(dir, "validate", "--format", "gitlab");
        expect(r.exitCode).toBe(1);
        const rows = JSON.parse(r.stdout) as Record<string, unknown>[];
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual(["check_name", "description", "fingerprint", "location", "severity"]);
          expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
          expect(row.location).toMatchObject({ path: expect.any(String), lines: { begin: expect.any(Number) } });
        }
        expect(rows.map((row) => row.severity).sort()).toEqual(["major", "minor"]);
        const again = JSON.parse((await ltm(dir, "validate", "--format", "gitlab")).stdout) as { fingerprint: string }[];
        expect(again.map((row) => row.fingerprint)).toEqual(rows.map((row) => String(row.fingerprint)));
        expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(2);
      });
    });

    test("junit parses with xml.etree and puts each failure under its own file", async () => {
      await withScratch(demo, async (dir) => {
        edit(join(dir, PG), (t) => blockTags(replaceLine(t, "status:", null)));
        const human = lines((await ltm(dir, "validate")).stdout);
        expect(human).toHaveLength(2);
        expect(human.every((l) => l.startsWith(`${PG}:`) && l.includes(" error "))).toBe(true);

        const r = await ltm(dir, "validate", "--format", "junit");
        expect(r.exitCode).toBe(1);
        // Prints testcase name and failure count per testcase, so the assertion reads what a JUnit consumer reads.
        const py = [
          "import sys, json, xml.etree.ElementTree as E",
          "root = E.fromstring(sys.stdin.buffer.read())",
          "cases = root.findall('testcase')",
          "by = {tc.get('name'): len(tc.findall('failure')) for tc in cases}",
          "print(json.dumps({'testcases': len(cases), 'failures': len(list(root.iter('failure'))), 'by': by}))",
        ].join("\n");
        const p = spawnSync("python3", ["-c", py], { input: r.stdout, encoding: "utf8" });
        expect(p.stderr).toBe("");
        expect(p.status).toBe(0);
        const parsed = JSON.parse(p.stdout) as { testcases: number; failures: number; by: Record<string, number> };
        expect(parsed.failures).toBe(2);
        expect(parsed.by[PG]).toBe(2);
        expect(parsed.by[MYSQL]).toBe(0);
        expect(parsed.testcases).toBeGreaterThan(2);
        expect(Object.values(parsed.by).reduce((a, b) => a + b, 0)).toBe(2);

        // Naming two files narrows the Record testcases to them; memory-bank.yaml is always judged, so it keeps its own.
        const two = await ltm(dir, "validate", "--format", "junit", PG, MYSQL);
        const q = spawnSync("python3", ["-c", py], { input: two.stdout, encoding: "utf8" });
        expect(q.status).toBe(0);
        const named = JSON.parse(q.stdout) as typeof parsed;
        expect(named.by).toEqual({ [PG]: 2, [MYSQL]: 0, "memory-bank.yaml": 0 });
        expect(named.failures).toBe(2);
      });
    });

    test("--format with --json, or an unknown format, is a usage error", async () => {
      await withScratch(demo, async (dir) => {
        expect(await ltm(dir, "validate", "--format", "github", "--json")).toEqual({
          exitCode: 2,
          stdout: "",
          stderr: "ltm validate: --format and --json can't be combined\n",
        });
        expect(await ltm(dir, "validate", "--format", "text")).toEqual({
          exitCode: 2,
          stdout: "",
          stderr: "ltm validate: unknown format 'text' (expected github, gitlab, or junit)\n",
        });
      });
    });

    test("a clean Bank gives empty github output, an empty gitlab array, and a failure-free junit suite", async () => {
      await withScratch(demo, async (dir) => {
        expect(await ltm(dir, "validate", "--format", "github")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(await ltm(dir, "validate", "--format", "gitlab")).toEqual({ exitCode: 0, stdout: "[]\n", stderr: "" });
        const j = await ltm(dir, "validate", "--format", "junit");
        expect(j.exitCode).toBe(0);
        expect(j.stdout).toContain('failures="0"');
      });
    });
  });
});

describe("ltm validate picks its Bank from the paths", () => {
  const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const demoRel = "fixtures/demo-bank";

  test("1: from outside the Bank, a path inside it validates clean", async () => {
    const r = await ltm(repoRoot, "validate", `${demoRel}/${PG}`);
    expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("2: from inside the demo Bank, a Record in a copy reports the copy's finding", async () => {
    await withScratch(demo, async (copy) => {
      edit(join(copy, PG), (t) => replaceLine(t, "title:", null));
      const r = await ltm(demo, "validate", join(copy, PG));
      expect(r.exitCode).toBe(1);
      expect(r.stdout).not.toContain(NOT_A_RECORD);
      expect(lines(r.stdout).some((l) => l.includes("error schema: title:"))).toBe(true);
    });
  });

  test("3: no paths from the repo root still fails with no memory-bank.yaml", async () => {
    const r = await ltm(repoRoot, "validate");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no memory-bank.yaml");
  });

  test("paths in two Banks are refused, naming both roots", async () => {
    await withScratch(demo, async (copy) => {
      const r = await ltm(repoRoot, "validate", `${demoRel}/${PG}`, join(copy, PG));
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("paths span two Banks");
      expect(r.stderr).toContain(demo);
      expect(r.stderr).toContain(copy);
    });
  });

  test("the Bank root as a path validates the whole Bank", async () => {
    expect(await ltm(repoRoot, "validate", demoRel)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    await withScratch(demo, async (copy) => {
      edit(join(copy, PG), (t) => replaceLine(t, "title:", null));
      const r = await ltm(repoRoot, "validate", copy);
      expect(r.exitCode).toBe(1);
      expect(lines(r.stdout).some((l) => l.startsWith(`${PG}:`) && l.includes("error schema: title:"))).toBe(true);
    });
  });

  test("a Bank root mixed with a Record validates the whole Bank", async () => {
    const other = "_memory/decisions/" + readdirSync(join(demo, "_memory/decisions")).find((f) => !f.startsWith("postgres-"))!;
    expect(await ltm(repoRoot, "validate", `${demoRel}/`, `${demoRel}/${PG}`)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    await withScratch(demo, async (copy) => {
      edit(join(copy, PG), (t) => replaceLine(t, "title:", null));
      const r = await ltm(repoRoot, "validate", join(copy, other), copy);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).not.toContain(NOT_A_RECORD);
      expect(lines(r.stdout).some((l) => l.startsWith(`${PG}:`) && l.includes("error schema: title:"))).toBe(true);
    });
  });

  test("a Bank root mixed with a nonexistent Record path still reports that path", async () => {
    const missing = "_memory/decisions/does-not-exist.md";
    const r = await ltm(repoRoot, "validate", demoRel, `${demoRel}/${missing}`);
    expect(r.exitCode).toBe(1);
    expect(lines(r.stdout).some((l) => l.startsWith(`${missing}:`) && l.includes("error walk:") && l.includes(NOT_A_RECORD))).toBe(true);
  });

  test("a Bank root mixed with missing paths keeps findings in file order and gives each a junit testcase", async () => {
    const z = "_memory/decisions/zz-missing.md";
    const a = "_memory/aa-missing.md";
    const r = await ltm(repoRoot, "validate", `${demoRel}/${z}`, demoRel, `${demoRel}/${a}`);
    expect(r.exitCode).toBe(1);
    expect(lines(r.stdout).map((l) => l.split(":")[0])).toEqual([a, z]);
    const junit = await ltm(repoRoot, "validate", demoRel, `${demoRel}/${z}`, "--format", "junit");
    expect(junit.stdout).toContain(z);
  });

  test("a Bank root mixed with a non-Record file in the Bank still reports that file", async () => {
    await withScratch(demo, async (copy) => {
      writeFileSync(join(copy, "notes.txt"), "x\n");
      const r = await ltm(repoRoot, "validate", copy, join(copy, "notes.txt"));
      expect(r.exitCode).toBe(1);
      expect(lines(r.stdout).some((l) => l.startsWith("notes.txt:") && l.includes("error walk:") && l.includes(NOT_A_RECORD))).toBe(true);
    });
  });

  test("a path outside any Bank names its start dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
    try {
      const r = await ltm(repoRoot, "validate", join(dir, "x.md"));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe(`ltm validate: no memory-bank.yaml in ${dir} or any parent directory\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ltm validate: supersession cycle", () => {
  const record = (id: string, by: string, from: string) =>
    [
      "---",
      "schema: 1",
      `id: ${id}`,
      "memory_type: Decision",
      `title: Rec ${id}`,
      "status: superseded",
      "date: 2026-01-01",
      `summary: Rec ${id}.`,
      `superseded_by: ${by}`,
      `supersedes: [${from}]`,
      "applies_to: [domain:commerce]",
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

  test("a closed cycle exits 1 with one supersession-cycle error on the first path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-cycle-cli-"));
    try {
      writeFileSync(join(dir, "memory-bank.yaml"), "schema: 1\nname: t\nfacet_prefixes: [domain]\n");
      mkdirSync(join(dir, "_memory/decisions"), { recursive: true });
      writeFileSync(join(dir, "_memory/decisions/rec-aaaaaaaaaa.md"), record("aaaaaaaaaa", "bbbbbbbbbb", "bbbbbbbbbb"));
      writeFileSync(join(dir, "_memory/decisions/rec-bbbbbbbbbb.md"), record("bbbbbbbbbb", "aaaaaaaaaa", "aaaaaaaaaa"));
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      const out = lines(r.stdout);
      expect(out).toHaveLength(1);
      expect(out[0]!).toContain("_memory/decisions/rec-aaaaaaaaaa.md:");
      expect(out[0]!).toContain("error supersession-cycle:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("exception-link through the CLI", () => {
  const REDIS = "_memory/exceptions/order-service-redis-until-2027-03-wJ3nC7hTy4.md";

  test("an accepted Exception with related: [] exits 1 with an error on that file", async () => {
    await withScratch(demo, async (dir) => {
      edit(join(dir, REDIS), (t) => replaceLine(t, "related:", "related: []"));
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      expect(lines(r.stdout).filter((l) => l.startsWith(`${REDIS}:`) && l.includes(" error exception-link: "))).toHaveLength(1);
    });
  });

  test("the same Exception at proposed warns and exits 0", async () => {
    await withScratch(demo, async (dir) => {
      edit(join(dir, REDIS), (t) => replaceLine(replaceLine(t, "related:", "related: []"), "status:", "status: proposed"));
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(0);
      const out = lines(r.stdout);
      expect(out.filter((l) => l.includes(" warning exception-link: "))).toHaveLength(1);
      expect(out.some((l) => l.includes(" error "))).toBe(false);
    });
  });

  test("the unmodified demo Bank prints no exception-link finding", async () => {
    await withScratch(demo, async (dir) => {
      expect(lines((await ltm(dir, "validate")).stdout).some((l) => l.includes("exception-link"))).toBe(false);
    });
  });
});
