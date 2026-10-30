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

  test("promote of 0003 lands a Decision Proposal whose body is the ADR's bytes, and stamps the ADR", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ bare, clone }) => {
        const original = readFileSync(join(repo, ADR), "utf8");
        const r = await ltm(repo, "promote", ADR, "--bank", clone, "--json");
        expect(r.exitCode).toBe(0);
        const out = JSON.parse(r.stdout);
        const record = git(bare, "show", `${out.branch}:${out.path}`);
        const closing = record.indexOf("\n---\n", 4);
        const frontmatter = record.slice(0, closing);
        expect(frontmatter).toContain("\nmemory_type: Decision\n");
        expect(frontmatter).toContain("\nstatus: proposed\n");
        expect(frontmatter).toContain(`\npromoted_from: acme/order-service:${ADR}\n`);
        expect(frontmatter).toContain("\napplies_to: [service:order-service, domain:commerce]");
        expect(record.slice(closing + "\n---\n".length)).toBe(original);
        expect(readFileSync(join(repo, ADR), "utf8")).toBe(`---\npromoted_to: acme:${out.id}\n---\n${original}`);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("--applies-to domain:payments replaces the consumers mapping in the pushed Record", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ bare, clone }) => {
        const r = await ltm(repo, "promote", ADR, "--bank", clone, "--applies-to", "domain:payments", "--json");
        expect(r.exitCode).toBe(0);
        const out = JSON.parse(r.stdout);
        const record = git(bare, "show", `${out.branch}:${out.path}`);
        expect(record).toContain("\napplies_to: [domain:payments]\n");
        expect(record).not.toContain("service:order-service");
        expect(record).not.toContain("domain:commerce");
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("promote of 0004 adds exactly one line to its frontmatter and removes none", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ clone }) => {
        const adr = "docs/adr/0004-retry-budget.md";
        const original = readFileSync(join(repo, adr), "utf8");
        const r = await ltm(repo, "promote", adr, "--bank", clone, "--json");
        expect(r.exitCode).toBe(0);
        const id = JSON.parse(r.stdout).id;
        const updated = readFileSync(join(repo, adr), "utf8");
        const fence = original.indexOf("\n---\n", 4) + 1;
        expect(updated).toBe(`${original.slice(0, fence)}promoted_to: acme:${id}\n${original.slice(fence)}`);
        expect(git(repo, "diff", "--numstat", "--", adr)).toBe(`1\t0\t${adr}\n`);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("--entry stamps directly under its heading, leaves other entries byte-identical, and records the anchor", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ bare, clone }) => {
        const log = "_working-memory/decisionLog.md";
        const original = readFileSync(join(repo, log), "utf8");
        const heading = "## Cap retries at three per request\n";
        const r = await ltm(repo, "promote", log, "--entry", "Cap retries at three per request", "--bank", clone, "--json");
        expect(r.stderr).toMatch(/^(ltm promote: .*warning body-sections.*\n)?$/);
        expect(r.exitCode).toBe(0);
        const out = JSON.parse(r.stdout);
        const record = git(bare, "show", `${out.branch}:${out.path}`);
        expect(record).toContain(`\npromoted_from: acme/order-service:${log}#cap-retries-at-three-per-request\n`);
        const at = original.indexOf(heading) + heading.length;
        expect(readFileSync(join(repo, log), "utf8")).toBe(`${original.slice(0, at)}promoted_to: acme:${out.id}\n${original.slice(at)}`);
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

  test("a dated working-memory-kit heading promotes by either spelling, with the bare title and the full-heading anchor", async () => {
    await withConsumerRepo(async (repo) => {
      await withGitBank(async ({ clone }) => {
        const log = "_working-memory/decisionLog.md";
        for (const entry of ["Batch order events per partition", "2026-10-02: Batch order events per partition"]) {
          const r = await ltm(repo, "promote", log, "--entry", entry, "--bank", clone, "--type", "Decision", "--dry-run");
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toContain("title: Batch order events per partition\n");
          expect(r.stdout).toContain(`promoted_from: acme/order-service:${log}#2026-10-02-batch-order-events-per-partition\n`);
        }
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("the issue's repro: a log with only a dated heading gives the bare title for both spellings", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ltm-dated-")));
    try {
      mkdirSync(join(scratch, "_working-memory"));
      writeFileSync(
        join(scratch, "_working-memory/decisionLog.md"),
        "# Decision Log\n\n## 2026-10-01: Cap retries at three per request\n\n**Context:** x\n\n**Decision:** Retry at most three times.\n",
      );
      git(scratch, "init", "--quiet", "--initial-branch=main");
      git(scratch, "remote", "add", "origin", "https://github.com/acme/order-service.git");
      await withGitBank(async ({ clone }) => {
        for (const entry of ["Cap retries at three per request", "2026-10-01: Cap retries at three per request"]) {
          const r = await ltm(scratch, "promote", "_working-memory/decisionLog.md", "--entry", entry, "--bank", clone, "--type", "Decision", "--dry-run");
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toContain("title: Cap retries at three per request\n");
        }
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT);
});
