import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/cli/run.ts";
import { git, snapshot, withGitBank } from "../helpers/git-bank.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const env = { LTM_TODAY: "2026-10-09" };
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env });
const TITLE = "Use Postgres for new services";
const refs = (bare: string) => git(bare, "for-each-ref");

describe("ltm propose", () => {
  test("a remote that matches no forge prints path, branch, and the open-a-change-request hint", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const r = await ltm(clone, "propose", "--type", "Decision", "--title", TITLE);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      const branch = lines[1]!.replace("branch: ", "");
      expect(branch).toMatch(/^ltm\/propose\/.+/);
      expect(lines[0]).toMatch(/^path: .*\.md$/);
      expect(lines[2]).toBe(`review: open a change request for ${branch} on ${git(clone, "config", "--get", "remote.origin.url").trim()}`);
      expect(git(clone, "config", "--get", "remote.origin.url").trim()).toBe(bare);
    });
  });

  test("a GitLab origin prints the fallback merge-request URL as json", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const gitlab = "https://gitlab.example.com/acme/bank.git";
      git(clone, "config", "remote.origin.url", gitlab);
      git(clone, "config", `url.${bare}.insteadOf`, gitlab);
      // The rewrite is what keeps this test off the network.
      expect(git(clone, "config", "--get", `url.${bare}.insteadOf`).trim()).toBe(gitlab);
      expect(git(clone, "ls-remote", "--get-url", "origin").trim()).toBe(bare);
      const r = await ltm(clone, "propose", "--type", "Decision", "--title", TITLE, "--json");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(Object.keys(out)).toEqual(["id", "path", "branch", "url", "adapter"]);
      expect(out.adapter).toBe("fallback");
      expect(out.url).toBe(`https://gitlab.example.com/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/${out.id}`);
    });
  });

  test("an empty --title exits 1 and the bare repo gains no ref", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const before = refs(bare);
      const r = await ltm(clone, "propose", "--type", "Decision", "--title", "");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/^ltm propose: .*error /m);
      expect(refs(bare)).toBe(before);
    });
  });

  test("--dry-run prints a Record that validates once saved, and the bare repo gains no ref", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const before = refs(bare);
      const r = await ltm(clone, "propose", "--type", "Decision", "--title", TITLE, "--dry-run");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toStartWith("---\n");
      expect(r.stdout).toContain("status: proposed");
      expect(r.stdout).toContain("date: 2026-10-09");
      expect(refs(bare)).toBe(before);
      const dir = join(clone, "_memory", "decisions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "dry-run-record.md"), r.stdout);
      const v = await ltm(clone, "validate");
      expect(v.stderr).toBe("");
      expect(v.exitCode).toBe(0);
    });
  });

  test("with no origin it exits 1 on the no-origin line and writes nothing", async () => {
    await withGitBank(async ({ bare, clone }) => {
      git(clone, "remote", "remove", "origin");
      const before = snapshot(bare, clone);
      const r = await ltm(clone, "propose", "--type", "Decision", "--title", TITLE);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("ltm propose: no origin remote; ltm propose pushes a branch there for review\n");
      expect(snapshot(bare, clone)).toEqual(before);
    });
  });

  test("--body-file with --body-stdin exits 2; --body-stdin on bin.ts writes stdin as the body", async () => {
    await withGitBank(async ({ clone }) => {
      const both = await ltm(clone, "propose", "--type", "Decision", "--title", TITLE, "--body-file", "x.md", "--body-stdin");
      expect(both.exitCode).toBe(2);
      const body = "## Context\n\nx\n";
      const spawned = spawnSync(process.execPath, [join(repoRoot, "src/cli/bin.ts"), "propose", "--type", "Context", "--title", TITLE, "--dry-run", "--body-stdin"], {
        encoding: "utf8",
        cwd: clone,
        input: body,
        env: { ...process.env, LTM_TODAY: "2026-10-09" },
      });
      expect(spawned.status).toBe(0);
      expect(spawned.stdout.endsWith(`---\n${body}`)).toBe(true);
    });
  });

  test("propose is no longer a hidden stub", async () => {
    const r = await run({ argv: ["--help"], cwd: "/", env: {} });
    expect(r.stdout).toMatch(/^  propose  /m);
  });
});
