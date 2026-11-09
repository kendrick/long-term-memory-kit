import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { git, snapshot, withGitBank } from "../helpers/git-bank.ts";
import { withMcp } from "../helpers/mcp.ts";

// Same budget as test/mcp/propose.test.ts: each test boots a bun server over stdio and spawns many git processes.
const MCP_TEST_TIMEOUT = 60_000;
const ID = "cR7mT2vKb5";
const PATH = `_memory/decisions/cursor-pagination-for-list-endpoints-${ID}.md`;
// The server's clone has no repo-level identity, so the amend commit takes it from here rather than the machine's config.
const BASE = {
  LTM_TODAY: "2026-11-08",
  GIT_AUTHOR_NAME: "ltm test",
  GIT_AUTHOR_EMAIL: "ltm@example.invalid",
  GIT_COMMITTER_NAME: "ltm test",
  GIT_COMMITTER_EMAIL: "ltm@example.invalid",
};

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Called): string => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("");
function ok(r: Called): Record<string, unknown> {
  if (r.isError) throw new Error(`tool error: ${textOf(r)}`);
  return r.structuredContent as Record<string, unknown>;
}

const amendRefs = (bare: string): string[] =>
  git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/amend/").split("\n").filter((l) => l !== "");

// The server clones LTM_BANK_URL into $LTM_DATA_DIR/banks/<sha1(url)>; `clone` is that path, so tests can snapshot the server's own clone.
async function withUrlServer<T>(bare: string, cwd: string, fn: (client: Client, clone: string) => Promise<T>, override: Record<string, string> = {}): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), "ltm-mcp-data-"));
  try {
    const env = { ...process.env, ...BASE, ...override, LTM_BANK_URL: bare, LTM_DATA_DIR: dataDir };
    const clone = join(dataDir, "banks", createHash("sha1").update(bare).digest("hex"));
    return await withMcp(env, cwd, (client) => fn(client, clone));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("ltm mcp, amend", () => {
  // amend stamps no date of its own, so a bad LTM_TODAY must not reach it.
  test(
    "amend ignores a malformed LTM_TODAY",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(
          bare,
          tmpdir(),
          async (client) => {
            ok(await client.callTool({ name: "amend", arguments: { id: ID, set: { last_confirmed: "2026-11-07" } } }));
            expect(amendRefs(bare)).toHaveLength(1);
          },
          { LTM_TODAY: "2026-13-45" },
        ),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "amend sets last_confirmed on one ltm/amend branch",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(bare, tmpdir(), async (client, clone) => {
          // Any request makes the server clone, so there is a clone to snapshot before amend runs.
          ok(await client.callTool({ name: "facets", arguments: {} }));
          const before = snapshot(bare, clone);
          const sc = ok(await client.callTool({ name: "amend", arguments: { id: ID, set: { last_confirmed: "2026-11-07" } } }));
          expect(Object.keys(sc).sort()).toEqual(["adapter", "bank_commits", "branch", "id", "path", "url", "warnings"]);
          expect(sc.id).toBe(ID);
          expect(sc.path).toBe(PATH);
          expect(amendRefs(bare)).toEqual([`refs/heads/${sc.branch}`]);
          const diff = git(bare, "diff", "main", sc.branch as string, "--unified=0").split("\n");
          expect(diff.filter((l) => /^\+(?!\+\+)/.test(l))).toEqual(["+last_confirmed: 2026-11-07"]);
          expect(diff.filter((l) => /^-(?!--)/.test(l))).toEqual([]);
          expect(git(bare, "diff", "--name-only", "main", sc.branch as string).trim()).toBe(PATH);
          const after = snapshot(bare, clone);
          expect(after.status).toBe("");
          expect(after.head).toBe(before.head);
          expect(after.branch).toBe(before.branch);
          expect(after.worktrees).toBe(before.worktrees);
          expect(after.cloneRefs).toBe(before.cloneRefs);
          expect(Object.values(sc.bank_commits as object)).toEqual([before.head]);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "amend refuses memory_type, naming it",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(bare, tmpdir(), async (client) => {
          const r = await client.callTool({ name: "amend", arguments: { id: ID, set: { memory_type: "Rule" } } });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toBe("amend can't change memory_type");
          expect(amendRefs(bare)).toEqual([]);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "amend refuses an unknown status",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(bare, tmpdir(), async (client) => {
          const r = await client.callTool({ name: "amend", arguments: { id: ID, set: { status: "paused" } } });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toContain("schema: status");
          expect(amendRefs(bare)).toEqual([]);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "amend on an unknown id is a not-found error",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(bare, tmpdir(), async (client) => {
          const r = await client.callTool({ name: "amend", arguments: { id: "nope", set: { last_confirmed: "2026-11-07" } } });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toContain("matches no Record");
          expect(amendRefs(bare)).toEqual([]);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );
});
