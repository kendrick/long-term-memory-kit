import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withConsumerRepo } from "../helpers/consumer-repo.ts";
import { git, IDENTITY, withGitBank } from "../helpers/git-bank.ts";

// Each test spawns many git processes; bun's 5s default flakes under load.
const GIT_TEST_TIMEOUT = 30_000;
const env = { LTM_TODAY: "2026-10-09" };
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env });
const ADR = "docs/adr/0003-use-ioredis.md";

// path -> sha256 for every file outside .git, so "changes nothing" compares full contents.
function hashes(root: string, dir = root): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, hashes(root, p));
    else out[p.slice(root.length + 1)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}
const refs = (bare: string) => git(bare, "for-each-ref");

describe("ltm promote", () => {
  test("the falsifier, success: only the ADR is modified, nothing staged, HEAD unchanged", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ clone }) => {
        const head = git(repo, "rev-parse", "HEAD");
        const r = await ltm(repo, "promote", ADR, "--bank", clone);
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        expect(git(repo, "status", "--porcelain")).toBe(` M ${ADR}\n`);
        expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
        expect(git(repo, "rev-parse", "HEAD")).toBe(head);
        expect(r.stdout).toEndWith(`stamped: ${ADR}:2\n`);
        expect(readFileSync(join(repo, ADR), "utf8")).toStartWith("---\npromoted_to: acme:");
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("the falsifier, forced failure: a refused Proposal leaves the repo and the Bank untouched", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ bare, clone }) => {
        writeFileSync(join(repo, "docs/adr/0009-untitled.md"), "No frontmatter and no heading.\n");
        git(repo, "add", "-A");
        git(repo, ...IDENTITY, "commit", "--quiet", "-m", "untitled");
        const before = hashes(repo);
        const bareBefore = refs(bare);
        const r = await ltm(repo, "promote", "docs/adr/0009-untitled.md", "--bank", clone, "--title", "");
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toStartWith("ltm promote: ");
        expect(hashes(repo)).toEqual(before);
        expect(git(repo, "status", "--porcelain")).toBe("");
        expect(refs(bare)).toBe(bareBefore);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("the falsifier, dry run: prints the Proposal and changes nothing", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ bare, clone }) => {
        const before = hashes(repo);
        const bareBefore = refs(bare);
        const r = await ltm(repo, "promote", ADR, "--bank", clone, "--dry-run");
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain(`promoted_from: acme/order-service:${ADR}`);
        expect(r.stdout).toContain("applies_to: [service:order-service, domain:commerce]");
        expect(hashes(repo)).toEqual(before);
        expect(refs(bare)).toBe(bareBefore);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("a second promote of the same ADR exits 1 and changes nothing", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ bare, clone }) => {
        expect((await ltm(repo, "promote", ADR, "--bank", clone)).exitCode).toBe(0);
        const before = hashes(repo);
        const bareBefore = refs(bare);
        const r = await ltm(repo, "promote", ADR, "--bank", clone);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("already has promoted_to");
        expect(hashes(repo)).toEqual(before);
        expect(refs(bare)).toBe(bareBefore);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("--entry with no such heading exits 1 and changes nothing", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ bare, clone }) => {
        const before = hashes(repo);
        const bareBefore = refs(bare);
        const r = await ltm(repo, "promote", "_working-memory/decisionLog.md", "--entry", "No such heading", "--bank", clone);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("has no '## No such heading' heading");
        expect(hashes(repo)).toEqual(before);
        expect(refs(bare)).toBe(bareBefore);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("--json carries the propose fields plus stamped.path and stamped.line", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ clone }) => {
        const r = await ltm(repo, "promote", "_working-memory/decisionLog.md", "--entry", "Cap retries at three per request", "--bank", clone, "--json");
        // A one-paragraph entry lacks the Decision sections, so the schema warning is expected.
        expect(r.stderr).toMatch(/^(ltm promote: .*warning body-sections.*\n)?$/);
        expect(r.exitCode).toBe(0);
        const out = JSON.parse(r.stdout);
        expect(Object.keys(out)).toEqual(["id", "path", "branch", "url", "adapter", "stamped"]);
        expect(out.stamped.path).toBe("_working-memory/decisionLog.md");
        expect(typeof out.stamped.line).toBe("number");
        const lines = readFileSync(join(repo, "_working-memory/decisionLog.md"), "utf8").split("\n");
        expect(lines[out.stamped.line - 1]).toStartWith("promoted_to: acme:");
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("outside a git work tree, or with no origin, exits 1 and leaves the file alone", async () => {
    await withGitBank(async ({ clone }) => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ltm-nogit-")));
      try {
        mkdirSync(join(scratch, "docs"));
        writeFileSync(join(scratch, "docs/a.md"), "# A\n");
        const r = await ltm(scratch, "promote", "docs/a.md", "--bank", clone);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("is not inside a git work tree");
        expect(readFileSync(join(scratch, "docs/a.md"), "utf8")).toBe("# A\n");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ clone }) => {
        git(repo, "remote", "remove", "origin");
        const before = hashes(repo);
        const r = await ltm(repo, "promote", ADR, "--bank", clone);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("no usable origin remote");
        expect(hashes(repo)).toEqual(before);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("a missing --bank exits 2, and so does --dry-run with --json", async () => {
    const missing = await ltm("/", "promote", ADR);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("missing required option --bank");
    const both = await ltm("/", "promote", ADR, "--bank", "/x", "--dry-run", "--json");
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain("--dry-run and --json can't be used together");
  });
});
