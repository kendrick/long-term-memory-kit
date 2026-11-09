import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/core/bank.ts";
import { amendRecord, type AmendInput } from "../../src/core/propose.ts";
import { git, IDENTITY, snapshot, withGitBank } from "../helpers/git-bank.ts";

// Each test spawns many git processes; bun's 5s default flakes under load.
const GIT_TEST_TIMEOUT = 30_000;
const ID = "cR7mT2vKb5";
const PATH = `_memory/decisions/cursor-pagination-for-list-endpoints-${ID}.md`;

// A file-path bare origin picks the fallback adapter, so nothing touches the network.
const amend = (clone: string, input: AmendInput) => amendRecord(input, { config: loadConfig(clone), env: {} });

const amendBranches = (bare: string) => git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/amend/");

// Commits a change to bare's main from a second clone, leaving `clone` behind origin.
function commitOnOrigin(bare: string, change: (dir: string) => void): void {
  const other = mkdtempSync(join(tmpdir(), "ltm-other-"));
  try {
    git(other, "clone", "--quiet", bare, ".");
    change(other);
    git(other, "add", "-A");
    git(other, ...IDENTITY, "commit", "--quiet", "-m", "change on origin");
    git(other, "push", "--quiet", "origin", "main");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}

test(
  "set last_confirmed: one ltm/amend branch whose diff is one frontmatter line",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      const r = await amend(clone, { id: ID, set: { last_confirmed: "2026-11-07" } });
      if ("refusal" in r) throw new Error(`refused: ${r.refusal}`);
      expect(r.branch).toMatch(/^ltm\/amend\/cR7mT2vKb5-[0-9a-f]{8}$/);
      expect(r.path).toBe(PATH);
      expect(r.warnings).toEqual([]);
      const diff = git(bare, "diff", "main", r.branch, "--unified=0", "--", PATH).split("\n");
      expect(diff.filter((l) => /^\+(?!\+\+)/.test(l))).toEqual(["+last_confirmed: 2026-11-07"]);
      expect(diff.filter((l) => /^-(?!--)/.test(l))).toEqual([]);
      expect(git(bare, "diff", "--name-only", "main", r.branch).trim()).toBe(PATH);
      expect(git(bare, "log", "-1", "--format=%s", r.branch).trim()).toBe("Amend Decision: Cursor pagination for list endpoints");
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "refuses id, schema, and memory_type, naming the key, and pushes nothing",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      const before = git(bare, "for-each-ref");
      for (const key of ["id", "schema", "memory_type"]) {
        expect(await amend(clone, { id: ID, set: { [key]: "x" } })).toEqual({ refusal: `amend can't change ${key}` });
        expect(await amend(clone, { id: ID, unset: [key] })).toEqual({ refusal: `amend can't change ${key}` });
      }
      expect(git(bare, "for-each-ref")).toBe(before);
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "refuses an unknown status and pushes nothing",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      const r = await amend(clone, { id: ID, set: { status: "paused" } });
      expect("refusal" in r && r.refusal).toContain("schema: status");
      expect(amendBranches(bare)).toBe("");
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "refuses an unknown id and pushes nothing",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      expect(await amend(clone, { id: "nope", set: { last_confirmed: "2026-11-07" } })).toEqual({ refusal: "'nope' matches no Record on main" });
      expect(amendBranches(bare)).toBe("");
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "finds the Record on origin, not the stale clone",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      commitOnOrigin(bare, (dir) => rmSync(join(dir, PATH)));
      expect(readFileSync(join(clone, PATH), "utf8")).toContain(`id: ${ID}`);
      expect(await amend(clone, { id: ID, set: { last_confirmed: "2026-11-07" } })).toEqual({ refusal: `'${ID}' matches no Record on main` });
      expect(amendBranches(bare)).toBe("");
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "refuses nothing-to-amend and set/unset overlap",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      expect(await amend(clone, { id: ID })).toEqual({ refusal: "nothing to amend" });
      expect(await amend(clone, { id: ID, set: {}, unset: [] })).toEqual({ refusal: "nothing to amend" });
      expect(await amend(clone, { id: ID, set: { tags: ["a"] }, unset: ["tags"] })).toEqual({ refusal: "tags is in both set and unset" });
      expect(amendBranches(bare)).toBe("");
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "refuses an amendment that changes nothing",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      expect(await amend(clone, { id: ID, set: { status: "accepted" } })).toEqual({ refusal: `the amendment changes nothing in ${PATH}` });
      expect(amendBranches(bare)).toBe("");
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "refuses a Record whose frontmatter holds a comment, with fmt's reason",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      commitOnOrigin(bare, (dir) => {
        const abs = join(dir, PATH);
        writeFileSync(abs, readFileSync(abs, "utf8").replace("status: accepted\n", "status: accepted # reviewed\n"));
      });
      expect(await amend(clone, { id: ID, set: { last_confirmed: "2026-11-07" } })).toEqual({
        refusal: "frontmatter holds a YAML comment, which fmt can't keep",
      });
      expect(amendBranches(bare)).toBe("");
    });
  },
  GIT_TEST_TIMEOUT,
);

test(
  "leaves the caller's clone untouched",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      const before = snapshot(bare, clone);
      const r = await amend(clone, { id: ID, set: { last_confirmed: "2026-11-07" } });
      if ("refusal" in r) throw new Error(`refused: ${r.refusal}`);
      const after = snapshot(bare, clone);
      expect({ ...after, bareRefs: "" }).toEqual({ ...before, bareRefs: "" });
      expect(readFileSync(join(clone, PATH), "utf8")).not.toContain("last_confirmed");
    });
  },
  GIT_TEST_TIMEOUT,
);
