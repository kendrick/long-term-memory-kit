import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { splitFrontmatter } from "../../src/core/record.ts";
import { run } from "../../src/cli/run.ts";
import { git, IDENTITY } from "../helpers/git-bank.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const TODAY = "2026-10-09";
const A = "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md";
const B = "_memory/exceptions/search-service-plaintext-logs-bU2pR8aXf7.md";

const accept = (cwd: string, ...args: string[]) =>
  run({ argv: ["accept", ...args], cwd, env: { LTM_TODAY: TODAY } });
const status = (dir: string, rel: string) =>
  parse(splitFrontmatter(readFileSync(join(dir, rel), "utf8"))!.frontmatterLines.join("\n")).status;
const commit = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, ...IDENTITY, "commit", "--quiet", "-m", msg);
};
const touch = (dir: string, rel: string) => appendFileSync(join(dir, rel), "\nA new line.\n");

// Both Proposals are committed under the tag, so only the diff can tell them apart.
async function withRepo(fn: (dir: string) => Promise<void>) {
  await withScratch(demo, async (dir) => {
    git(dir, "init", "--quiet", "--initial-branch=main");
    commit(dir, "seed");
    git(dir, "tag", "base");
    await fn(dir);
  });
}

describe("ltm accept --changed-since", () => {
  test("accepts only the Proposal the diff touched, then the second once it is touched too", async () => {
    await withRepo(async (dir) => {
      touch(dir, A);
      commit(dir, "touch A");
      const r = await accept(dir, "--changed-since", "base");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${A}\n`);
      expect(r.stderr).toBe("ltm accept: accepted pL2sG4nVq0\n");
      expect(status(dir, A)).toBe("accepted");
      expect(status(dir, B)).toBe("proposed");

      touch(dir, B);
      commit(dir, "accept A, touch B");
      const r2 = await accept(dir, "--changed-since", "base");
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toBe(`${B}\n`);
      expect(r2.stderr).toBe("ltm accept: accepted bU2pR8aXf7\n");
      expect(status(dir, A)).toBe("accepted");
      expect(status(dir, B)).toBe("accepted");
    });
  });

  test("a Proposal that sorts first but supersedes a later one is accepted after it", async () => {
    await withRepo(async (dir) => {
      // A sorts before B by path; making A the successor is what path order alone gets wrong.
      const abs = join(dir, A);
      writeFileSync(
        abs,
        readFileSync(abs, "utf8")
          .replace("applies_to: [platform:kubernetes, system:observability]", "applies_to: [platform:kubernetes, service:search-service]\nsupersedes: [bU2pR8aXf7]")
          + "\nA new line.\n",
      );
      touch(dir, B);
      commit(dir, "A supersedes B");
      const r = await accept(dir, "--changed-since", "base");
      expect(r.stderr).toBe("ltm accept: accepted bU2pR8aXf7\nltm accept: accepted pL2sG4nVq0\n");
      expect(r.exitCode).toBe(0);
      expect(status(dir, A)).toBe("accepted");
      expect(status(dir, B)).toBe("superseded");
      expect(readFileSync(join(dir, B), "utf8")).toContain("superseded_by: pL2sG4nVq0");
    });
  });

  test("a renamed Proposal counts as modified", async () => {
    await withRepo(async (dir) => {
      const moved = A.replace("opentelemetry-tracing", "otel-tracing");
      git(dir, "mv", A, moved);
      commit(dir, "rename A");
      const r = await accept(dir, "--changed-since", "base");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${moved}\n`);
      expect(status(dir, moved)).toBe("accepted");
      expect(status(dir, B)).toBe("proposed");
    });
  });

  test("a non-ASCII path that git would C-quote is still matched", async () => {
    await withRepo(async (dir) => {
      const moved = A.replace("opentelemetry-tracing", "café-tracing");
      git(dir, "mv", A, moved);
      commit(dir, "rename A to non-ASCII");
      const r = await accept(dir, "--changed-since", "base");
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("ltm accept: accepted pL2sG4nVq0\n");
      expect(status(dir, moved)).toBe("accepted");
      expect(status(dir, B)).toBe("proposed");
    });
  });

  test("an already-accepted Record changed in the diff is skipped", async () => {
    await withRepo(async (dir) => {
      const accepted = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
      touch(dir, accepted);
      commit(dir, "touch accepted");
      const r = await accept(dir, "--changed-since", "base");
      expect(r).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
      expect(status(dir, A)).toBe("proposed");
    });
  });

  test("a Bank in a repo subdirectory still matches the diff's paths", async () => {
    await withScratch(demo, async (repo) => {
      mkdirSync(join(repo, "bank"));
      for (const e of readdirSync(repo)) if (e !== "bank") renameSync(join(repo, e), join(repo, "bank", e));
      git(repo, "init", "--quiet", "--initial-branch=main");
      commit(repo, "seed");
      git(repo, "tag", "base");
      touch(join(repo, "bank"), A);
      commit(repo, "touch A");
      const r = await accept(join(repo, "bank"), "--changed-since", "base");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${A}\n`);
    });
  });

  test("a bad ref exits 1 with git's first line", async () => {
    await withRepo(async (dir) => {
      const r = await accept(dir, "--changed-since", "no-such-ref");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^ltm accept: fatal: .*no-such-ref.*\n$/);
    });
  });

  test("<id> with --changed-since, or neither, exits 2", async () => {
    await withRepo(async (dir) => {
      expect((await accept(dir, "pL2sG4nVq0", "--changed-since", "base")).exitCode).toBe(2);
      expect((await accept(dir)).exitCode).toBe(2);
      expect(status(dir, A)).toBe("proposed");
    });
  });
});
