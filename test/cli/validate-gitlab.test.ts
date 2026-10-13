import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });

const PG = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const NEW_ID = "nW4pQ8sYd2";
const NEW = `_memory/decisions/dangling-supersession-${NEW_ID}.md`;

type Row = { check_name: string; fingerprint: string; location: { path: string; lines: { begin: number } } };

// Built from the demo Record so it stays schema-valid as the fixture evolves.
function writeDangling(dir: string, supersedes: string): void {
  const pg = readFileSync(join(dir, PG), "utf8");
  const text = pg
    .split("\n")
    .map((l) => (l.startsWith("id:") ? `id: ${NEW_ID}` : l.startsWith("supersedes:") ? `supersedes: ${supersedes}` : l))
    .join("\n");
  writeFileSync(join(dir, NEW), text);
}

const gitlab = async (dir: string): Promise<{ stdout: string; rows: Row[] }> => {
  const r = await ltm(dir, "validate", "--format", "gitlab");
  expect(r.exitCode).toBe(1);
  return { stdout: r.stdout, rows: JSON.parse(r.stdout) as Row[] };
};

describe("ltm validate --format gitlab fingerprints", () => {
  test("two missing supersedes targets in one Record get different fingerprints", async () => {
    await withScratch(demo, async (dir) => {
      writeDangling(dir, "[zZ9zZ9zZ9z, yY8yY8yY8y]");
      const { rows } = await gitlab(dir);
      const missing = rows.filter((r) => r.check_name === "supersession-missing-target" && r.location.path === NEW);
      expect(missing).toHaveLength(2);
      expect(missing[0]!.fingerprint).not.toBe(missing[1]!.fingerprint);
      expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(rows.length);
    });
  });

  test("blank lines added inside the body leave a lone finding's fingerprint unchanged", async () => {
    await withScratch(demo, async (dir) => {
      writeDangling(dir, "[zZ9zZ9zZ9z]");
      const before = (await gitlab(dir)).rows;
      expect(before).toHaveLength(1);
      const pg = readFileSync(join(dir, NEW), "utf8");
      writeFileSync(join(dir, NEW), pg.replace("## Decision\n", "\n\n\n## Decision\n"));
      expect(readFileSync(join(dir, NEW), "utf8")).not.toBe(pg);
      const after = (await gitlab(dir)).rows;
      expect(after.map((r) => r.fingerprint)).toEqual(before.map((r) => r.fingerprint));
    });
  });

  test("blank lines above the finding's key move its line but not its fingerprint", async () => {
    await withScratch(demo, async (dir) => {
      writeDangling(dir, "[zZ9zZ9zZ9z]");
      const before = (await gitlab(dir)).rows;
      const text = readFileSync(join(dir, NEW), "utf8");
      writeFileSync(join(dir, NEW), text.replace("\nsupersedes:", "\n\n\nsupersedes:"));
      expect(readFileSync(join(dir, NEW), "utf8")).not.toBe(text);
      const after = (await gitlab(dir)).rows;
      expect(after).toHaveLength(1);
      expect(after[0]!.location.lines.begin).toBe(before[0]!.location.lines.begin + 2);
      expect(after[0]!.fingerprint).toBe(before[0]!.fingerprint);
    });
  });

  test("two runs on the same Bank give byte-identical stdout", async () => {
    await withScratch(demo, async (dir) => {
      writeDangling(dir, "[zZ9zZ9zZ9z, yY8yY8yY8y]");
      const a = await gitlab(dir);
      const b = await gitlab(dir);
      expect(b.stdout).toBe(a.stdout);
    });
  });
});
