import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const demo = `${root}fixtures/demo-bank`;
const fixture = `${root}test/fixtures/issue-form-body.md`;
const ISSUE = "https://github.com/o/r/issues/7";
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: { LTM_TODAY: "2026-10-09" } });

describe("ltm propose --from-issue-form", () => {
  test("--dry-run prints the Record the form describes", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "propose", "--from-issue-form", fixture, "--source-ref", ISSUE, "--dry-run");
      // The blank optional Consequences is the fixture's point, so the validator's warning about it is expected.
      expect(r.stderr).toMatch(/^ltm propose: .*warning body-sections: -: Decision body has no Consequences heading\n$/);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("memory_type: Decision\n");
      expect(r.stdout).toContain("title: Use Postgres for new services\n");
      expect(r.stdout).toContain("summary: New services start on Postgres unless a Decision says otherwise.\n");
      expect(r.stdout).toContain("\napplies_to: [domain:commerce, system:data-platform]\n");
      expect(r.stdout).toContain("\nsource_refs: [https://example.com/design-review, https://github.com/o/r/issues/7]\n");
      expect(r.stdout).toContain("\n## Context\n\nThree teams ran three databases");
      expect(r.stdout).toContain("\n## Decision\n\nNew services use Postgres.\n");
      expect(r.stdout).not.toContain("## Consequences");
    });
  });

  test("a bad form exits 1 with the file and the reason", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "propose", "--from-issue-form", `${root}README.md`, "--dry-run");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/^ltm propose: .*README\.md: /);
    });
  });

  for (const flag of ["--type", "--title", "--summary", "--applies-to", "--body-file", "--body-stdin"]) {
    test(`${flag} conflicts with --from-issue-form (exit 2)`, async () => {
      const r = await ltm("/", "propose", "--from-issue-form", fixture, flag, ...(flag === "--body-stdin" ? [] : ["x"]));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`--from-issue-form and ${flag} can't be used together`);
    });
  }
});
