import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const PG = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";

// #44: an integer past Number.MAX_SAFE_INTEGER can't survive JSON, so `ltm validate` has to name it. Asserts what the CLI prints, not the core finding.
test("an unsafe integer makes ltm validate exit 1 and name the path, line, schema, and big", async () => {
  await withScratch(demo, async (dir) => {
    const file = join(dir, PG);
    const ls = readFileSync(file, "utf8").split("\n");
    ls.splice(ls.indexOf("---", 1), 0, "big: 9007199254740993");
    writeFileSync(file, ls.join("\n"));
    const line = ls.findIndex((l) => l.startsWith("big:")) + 1;

    const r = await run({ argv: ["validate"], cwd: dir, env: {} });
    expect(r.exitCode).toBe(1);
    const hit = r.stdout.split("\n").filter((l) => l.startsWith(`${PG}:${line}: error schema: big: `));
    expect(hit).toHaveLength(1);
  });
});

// #74: a map key past 2^53 gets rounded by JSON, so validate names it.
test("an unsafe integer map key makes ltm validate exit 1 with one schema error naming it", async () => {
  await withScratch(demo, async (dir) => {
    const file = join(dir, PG);
    const ls = readFileSync(file, "utf8").split("\n");
    ls.splice(ls.indexOf("---", 1), 0, "9007199254740993: y");
    writeFileSync(file, ls.join("\n"));
    const line = ls.findIndex((l) => l.startsWith("9007199254740993:")) + 1;

    const r = await run({ argv: ["validate"], cwd: dir, env: {} });
    expect(r.exitCode).toBe(1);
    const hit = r.stdout.split("\n").filter((l) => l.includes("error schema") && l.includes("9007199254740993"));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toStartWith(`${PG}:${line}: `);
  });
});
