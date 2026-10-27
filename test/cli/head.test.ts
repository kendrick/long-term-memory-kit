import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run } from "../../src/cli/run.ts";

const root = new URL("../..", import.meta.url).pathname;
const ltm = (...argv: string[]) => run({ argv, cwd: root, env: {} });

const GOOD = "test/fixtures/head-25.md";
const BAD = "test/fixtures/no-frontmatter.md";
const first27 = readFileSync(`${root}${GOOD}`, "utf8").split("\n").slice(0, 27).join("\n") + "\n";

describe("ltm head", () => {
  test("prints the first 27 lines of a 25-line frontmatter block and nothing after", async () => {
    const r = await ltm("head", GOOD);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(first27);
    expect(r.stdout.split("\n")).toHaveLength(28);
    expect(r.stderr).toBe("");
  });

  test("a file with no frontmatter exits 1 and stderr names it", async () => {
    const r = await ltm("head", BAD);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(BAD);
  });

  test("one good path and one bad: good block printed with header, bad named, exit 1", async () => {
    const r = await ltm("head", GOOD, BAD);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe(`==> ${GOOD} <==\n${first27}`);
    expect(r.stderr).toContain(BAD);
  });

  test("two good paths get headers with a blank line between blocks", async () => {
    const r = await ltm("head", GOOD, GOOD);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`==> ${GOOD} <==\n${first27}\n==> ${GOOD} <==\n${first27}`);
  });

  test("a closing fence with no newline after it still prints one", async () => {
    const r = await ltm("head", "test/fixtures/head-no-newline.md");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("---\nk: v\n---\n");
    expect(r.stderr).toBe("");
  });

  test("--help states the newline rule", async () => {
    const r = await ltm("head", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("every line ending in a newline");
  });
});
