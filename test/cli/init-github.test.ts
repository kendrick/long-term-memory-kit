import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { run } from "../../src/cli/run.ts";

const templates = fileURLToPath(new URL("../../templates/github/", import.meta.url));
const WORKFLOWS = [".github/workflows/ltm-validate.yml", ".github/workflows/ltm-accept.yml", ".github/workflows/ltm-issue-form.yml"];
const FORM = ".github/ISSUE_TEMPLATE/ltm-proposal.yml";
const ALL = [...WORKFLOWS, FORM];

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ltm-init-gh-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const init = () => run({ argv: ["init"], cwd: dir, env: {} });
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
const put = (rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

describe("ltm init and the GitHub files", () => {
  test("an empty dir gets all four, each workflow pinned to this ltm version", async () => {
    const r = await init();
    expect(r.exitCode).toBe(0);
    for (const rel of ALL) expect(r.stdout.split("\n")).toContain(`created ${rel}`);
    for (const rel of WORKFLOWS) {
      const t = read(rel);
      expect(t).toContain(`\n  LTM_VERSION: "${pkg.version}"\n`);
      // `${{ }}` is GitHub's expression syntax; any other `{{` is a template placeholder init left behind.
      expect(t).not.toMatch(/(?<!\$)\{\{/);
    }
    expect(read(FORM)).toBe(readFileSync(`${templates}ISSUE_TEMPLATE/ltm-proposal.yml`, "utf8"));
    // Apart from the version, each workflow is its template byte for byte.
    for (const rel of WORKFLOWS) {
      const tpl = readFileSync(`${templates}workflows/${rel.split("/").pop()}`, "utf8");
      expect(read(rel)).toBe(tpl.replaceAll("{{LTM_VERSION}}", pkg.version));
    }
  });

  test("a second init prints nothing for them and leaves their bytes alone", async () => {
    expect((await init()).exitCode).toBe(0);
    const before = ALL.map(read);
    const r = await init();
    expect(r.exitCode).toBe(0);
    for (const rel of ALL) expect(r.stdout).not.toContain(rel);
    expect(ALL.map(read)).toEqual(before);
  });

  test("an unrelated workflow survives byte-identical", async () => {
    const other = "name: other\non: push\njobs: {}\n";
    put(".github/workflows/other.yml", other);
    expect((await init()).exitCode).toBe(0);
    expect(read(".github/workflows/other.yml")).toBe(other);
    for (const rel of ALL) expect(read(rel).length).toBeGreaterThan(0);
  });

  test("an edited ltm-validate.yml is never overwritten, and the rest still land", async () => {
    put(WORKFLOWS[0]!, "mine\n");
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(WORKFLOWS[0]!);
    expect(read(WORKFLOWS[0]!)).toBe("mine\n");
    for (const rel of ALL.slice(1)) expect(r.stdout.split("\n")).toContain(`created ${rel}`);
  });
});
