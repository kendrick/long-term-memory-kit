import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
  replaceLine(blockTags(replaceLine(text, "status:", null)), "applies_to:", "applies_to: [serivce:x]");

// A second Record built from the demo one, so it stays schema-valid as the fixture evolves.
const freshRecord = (pg: string, id: string) => replaceLine(pg, "id:", `id: ${id}`);

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
        const atTwenty = pad(freshRecord(pg, "pP0aD0dE01"), 20 - closingLine(pg));
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
      const misspelled = edit(join(dir, PG), (t) => replaceLine(t, "applies_to:", "applies_to: [serivce:order-service]"));
      const r = await ltm(dir, "validate");
      expect(r.exitCode).toBe(1);
      expect(lines(r.stdout)).toEqual([
        `${PG}:${lineOf(misspelled, "applies_to:")}: error facet-prefix: applies_to: 'serivce:order-service' uses prefix 'serivce', which facet_prefixes doesn't list`,
      ]);

      edit(join(dir, PG), (t) => replaceLine(t, "applies_to:", "applies_to: [service:order-service]"));
      expect(await ltm(dir, "validate")).toMatchObject({ exitCode: 0, stdout: "" });

      edit(join(dir, PG), (t) => replaceLine(t, "applies_to:", "applies_to: [serivce:order-service]"));
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
});
