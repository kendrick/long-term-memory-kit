import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { parse } from "yaml";
import { run } from "../../src/cli/run.ts";
import { splitFrontmatter } from "../../src/core/record.ts";
import { withConsumerRepo } from "../helpers/consumer-repo.ts";
import { git, snapshot, withGitBank } from "../helpers/git-bank.ts";
import { withMcp } from "../helpers/mcp.ts";

// Twice the 30s git-test budget, because each test also boots a bun server over stdio and runs the CLI per call. bun's 5s default flakes under load.
const MCP_TEST_TIMEOUT = 60_000;
const TITLE = "Use Postgres for new services";
const ADR = "docs/adr/0003-use-ioredis.md";
// The server's clone has no repo-level identity, so the Proposal commit takes it from here rather than the machine's config.
const BASE = {
  LTM_TODAY: "2026-10-09",
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

const proposeRefs = (bare: string): string[] =>
  git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/propose/").split("\n").filter((l) => l !== "");

function pushedFile(bare: string, branch: string, path: string) {
  const split = splitFrontmatter(git(bare, "show", `${branch}:${path}`));
  if (split === null) throw new Error(`${path} on ${branch} has no frontmatter`);
  return { frontmatter: parse(split.frontmatterLines.join("\n")) as Record<string, unknown>, body: split.body };
}

// The server clones LTM_BANK_URL into $LTM_DATA_DIR/banks/<sha1(url)>; `clone` is that path, so tests can snapshot the server's own clone.
async function withUrlServer<T>(bare: string, cwd: string, fn: (client: Client, clone: string) => Promise<T>): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), "ltm-mcp-data-"));
  try {
    const env = { ...process.env, ...BASE, LTM_BANK_URL: bare, LTM_DATA_DIR: dataDir };
    const clone = join(dataDir, "banks", createHash("sha1").update(bare).digest("hex"));
    return await withMcp(env, cwd, (client) => fn(client, clone));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("ltm mcp, propose", () => {
  test(
    "pushes exactly one ltm/propose branch to the bare origin and leaves the server's clone untouched",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(bare, tmpdir(), async (client, clone) => {
          // Any request makes the server clone, so there is a clone to snapshot before propose runs.
          ok(await client.callTool({ name: "facets", arguments: {} }));
          const before = snapshot(bare, clone);
          const refsBefore = proposeRefs(bare);
          const sc = ok(await client.callTool({ name: "propose", arguments: { type: "Decision", title: TITLE } }));
          const after = snapshot(bare, clone);
          expect(refsBefore).toEqual([]);
          expect(proposeRefs(bare)).toEqual([`refs/heads/${sc.branch}`]);
          expect(after.status).toBe("");
          expect(after.head).toBe(before.head);
          expect(after.branch).toBe(before.branch);
          expect(after.worktrees).toBe(before.worktrees);
          expect(Object.values(sc.bank_commits as object)).toEqual([before.head]);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "body reaches the pushed Proposal byte for byte",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(bare, tmpdir(), async (client) => {
          const body = "## Context\n\nOrders need `--strict` joins.\n\n## Decision\n\n- Postgres.\n";
          const sc = ok(await client.callTool({ name: "propose", arguments: { type: "Decision", title: TITLE, body } }));
          expect(pushedFile(bare, sc.branch as string, sc.path as string).body).toBe(body);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "from produces the same Proposal frontmatter as ltm promote, id aside",
    async () => {
      const viaMcp = await withConsumerRepo((repo) =>
        withGitBank(({ bare }) =>
          withUrlServer(bare, repo, async (client) => {
            const sc = ok(await client.callTool({ name: "propose", arguments: { type: "Decision", from: ADR } }));
            return pushedFile(bare, sc.branch as string, sc.path as string).frontmatter;
          }),
        ),
      );
      const viaCli = await withConsumerRepo((repo) =>
        withGitBank(async ({ bare, clone }) => {
          const r = await run({ argv: ["promote", ADR, "--bank", clone, "--json"], cwd: repo, env: { ...process.env, ...BASE } });
          expect(r.stderr).toBe("");
          expect(r.exitCode).toBe(0);
          const out = JSON.parse(r.stdout) as { branch: string; path: string };
          return pushedFile(bare, out.branch, out.path).frontmatter;
        }),
      );
      const { id: a, ...mcpRest } = viaMcp;
      const { id: b, ...cliRest } = viaCli;
      expect(typeof a).toBe("string");
      expect(typeof b).toBe("string");
      expect(mcpRest).toEqual(cliRest);
      expect(mcpRest.promoted_from).toBe(`acme/order-service:${ADR}`);
    },
    MCP_TEST_TIMEOUT * 2,
  );

  test(
    "from combined with owners is an error naming owners, and pushes nothing",
    () =>
      withGitBank(({ bare }) =>
        withUrlServer(bare, tmpdir(), async (client) => {
          const r = await client.callTool({ name: "propose", arguments: { type: "Decision", from: ADR, owners: ["team:commerce"] } });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toBe("from can't be combined with owners");
          expect(proposeRefs(bare)).toEqual([]);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "LTM_BANK_PATH at a subdirectory of a Bank is an error and pushes nothing to the parent's origin",
    () =>
      withGitBank(({ bare, clone }) =>
        withMcp({ ...process.env, ...BASE, LTM_BANK_PATH: join(clone, "_memory") }, tmpdir(), async (client) => {
          const before = git(bare, "for-each-ref");
          const r = await client.callTool({ name: "propose", arguments: { type: "Decision", title: TITLE } });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toContain("has no memory-bank.yaml");
          expect(git(bare, "for-each-ref")).toBe(before);
          expect(git(clone, "status", "--porcelain")).toBe("");
        }),
      ),
    MCP_TEST_TIMEOUT,
  );
});
