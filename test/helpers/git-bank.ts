import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;

// Pinned per call so a machine's global signing or identity config can't break the scratch commits.
export const IDENTITY = ["-c", "user.name=ltm test", "-c", "user.email=ltm@example.invalid", "-c", "commit.gpgsign=false"];

// Global and system git config stay out, so a developer's hooks, templates, and URL rewrites can't change the scratch repos. IDENTITY and the clone's own config supply the name and email that global config would have.
export function git(dir: string, ...args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${r.stderr.trim()}`);
  return r.stdout;
}

export type GitBank = { bare: string; clone: string };

// Every dir comes from mkdtemp under the OS temp dir, outside any checkout, so each scratch repo is its own and git never walks up into this worktree's index.
export async function withGitBank<T>(fn: (bank: GitBank) => Promise<T>): Promise<T> {
  const seed = mkdtempSync(join(tmpdir(), "ltm-seed-"));
  const bare = mkdtempSync(join(tmpdir(), "ltm-bare-"));
  const clone = mkdtempSync(join(tmpdir(), "ltm-clone-"));
  try {
    cpSync(demo, seed, { recursive: true });
    git(seed, "init", "--quiet", "--initial-branch=main");
    git(seed, "add", "-A");
    git(seed, ...IDENTITY, "commit", "--quiet", "-m", "seed");
    git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
    git(seed, "push", "--quiet", bare, "main:refs/heads/main");
    git(clone, "clone", "--quiet", bare, ".");
    git(clone, "config", "user.name", "ltm test");
    git(clone, "config", "user.email", "ltm@example.invalid");
    git(clone, "config", "commit.gpgsign", "false");
    return await fn({ bare, clone });
  } finally {
    for (const dir of [seed, bare, clone]) rmSync(dir, { recursive: true, force: true });
  }
}

export type Snapshot = {
  bareRefs: string;
  cloneRefs: string;
  branch: string;
  head: string;
  status: string;
  worktrees: string;
};

export function snapshot(bare: string, clone: string): Snapshot {
  return {
    bareRefs: git(bare, "for-each-ref"),
    cloneRefs: git(clone, "for-each-ref"),
    branch: git(clone, "rev-parse", "--abbrev-ref", "HEAD").trim(),
    head: git(clone, "rev-parse", "HEAD").trim(),
    status: git(clone, "status", "--porcelain"),
    worktrees: git(clone, "worktree", "list", "--porcelain"),
  };
}
