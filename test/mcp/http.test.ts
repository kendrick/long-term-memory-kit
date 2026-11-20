import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isLoopback, parseListen } from "../../src/cli/mcp.ts";
import { run } from "../../src/cli/run.ts";
import { git, IDENTITY, withGitBank } from "../helpers/git-bank.ts";
import { withConsumerRepo } from "../helpers/consumer-repo.ts";
import { withDemoGitBank, withMcp } from "../helpers/mcp.ts";

// Same budget as server.test.ts: each test boots a real server and runs the CLI per call.
const MCP_TEST_TIMEOUT = 60_000;
const bin = new URL("../../src/cli/bin.ts", import.meta.url).pathname;

type Env = Record<string, string | undefined>;
type Called = Awaited<ReturnType<Client["callTool"]>>;

const NOT_LOOPBACK = (spec: string) =>
  `ltm mcp: --http ${spec} is not a loopback host; put a front door that authenticates callers in front of it, then pass --trust-proxy-auth\n`;
const NO_BANK = "ltm mcp: --http needs LTM_BANK_URL or LTM_BANK_PATH; one HTTP server serves one Bank\n";

const textOf = (r: Called): string => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
const resultsOf = (r: Called): unknown[] => (r.structuredContent as { results: unknown[] }).results;

// Spawns the real `ltm mcp --http`, the same choice test/helpers/mcp.ts makes for stdio, so the suite covers Bun.serve and the transport as well as the handlers.
async function withHttpMcp<T>(env: Env, args: string[], fn: (client: Client, url: string) => Promise<T>, cwd = tmpdir()): Promise<T> {
  const defined = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  const proc = Bun.spawn([process.execPath, bin, "mcp", "--http", ...args], { env: defined, cwd, stdout: "ignore", stderr: "pipe" });
  let seen = "";
  // Keeps draining after the match, so a chatty server can't block on a full pipe.
  const served = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      seen += decoder.decode(chunk);
      const m = /^ltm mcp: serving (http:\/\/\S+)$/m.exec(seen);
      if (m) return m[1] as string;
    }
    return undefined;
  })();
  const timeout = new Promise<undefined>((done) => setTimeout(done, 15_000));
  let client: Client | undefined;
  try {
    const url = await Promise.race([served, timeout]);
    if (url === undefined) throw new Error(`ltm mcp --http never served; stderr so far:\n${seen}`);
    client = new Client({ name: "ltm-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return await fn(client, url);
  } finally {
    await client?.close();
    proc.kill();
    await proc.exited;
  }
}

const bankEnv = (root: string): Env => ({ ...process.env, LTM_BANK_PATH: root, LTM_BANK_URL: undefined });

function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ltm-http-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function rawStatus(port: number, method: string, path: string, host: string, body?: string): Promise<number> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { Host: host, "content-type": "application/json", accept: "application/json, text/event-stream" } },
      (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

describe("ltm mcp --http", () => {
  test(
    "tools/list over HTTP is exactly the read tools, without bank",
    () =>
      withDemoGitBank((root) =>
        withHttpMcp(bankEnv(root), ["0"], async (client) => {
          const { tools } = await client.listTools();
          expect(tools.map((t) => t.name).sort()).toEqual(["facets", "head", "query", "read"]);
          for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain("bank");
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "write tools are unknown over HTTP",
    () =>
      withDemoGitBank((root) =>
        withHttpMcp(bankEnv(root), ["0"], async (client) => {
          // "not found" rules out the nearest wrong builds: a .disable()d tool says "disabled", and a handler refusal resolves with isError.
          await expect(client.callTool({ name: "propose", arguments: { type: "decision", title: "x" } })).rejects.toThrow("Tool propose not found");
          await expect(client.callTool({ name: "validate", arguments: {} })).rejects.toThrow("Tool validate not found");
          await expect(client.callTool({ name: "amend", arguments: { id: "x", set: { status: "accepted" } } })).rejects.toThrow("Tool amend not found");
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "query returns the CLI's rows",
    () =>
      // From a consumer repo, so query's repo mapping picks Facets that "postgres" matches. Outside any repo it shows org-wide Records only.
      withDemoGitBank((root) =>
        withConsumerRepo((consumer) => {
          const env = bankEnv(root);
          return withHttpMcp(env, ["0"], async (client) => {
            const byText = await client.callTool({ name: "query", arguments: { text: "postgres" } });
            expect(byText.isError).toBeFalsy();
            const cliText = JSON.parse((await run({ argv: ["query", "--json", `--bank=${root}`, "--text=postgres"], cwd: consumer, env })).stdout).results;
            expect(resultsOf(byText).length).toBeGreaterThan(0);
            expect(resultsOf(byText)).toEqual(cliText);

            const byFilter = await client.callTool({ name: "query", arguments: { filters: { status: "accepted" } } });
            expect(byFilter.isError).toBeFalsy();
            const cliFilter = JSON.parse((await run({ argv: ["query", "--json", `--bank=${root}`, "--", "status=accepted"], cwd: consumer, env })).stdout).results;
            expect(resultsOf(byFilter).length).toBeGreaterThan(0);
            expect(resultsOf(byFilter)).toEqual(cliFilter);
          }, consumer);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "a stray bank input is ignored",
    () =>
      withDemoGitBank((root) =>
        withConsumerRepo((consumer) =>
          withHttpMcp(bankEnv(root), ["0"], async (client) => {
            const plain = await client.callTool({ name: "query", arguments: { text: "postgres" } });
            const stray = await client.callTool({ name: "query", arguments: { text: "postgres", bank: "/nonexistent" } });
            expect(stray.isError).toBeFalsy();
            expect(resultsOf(plain).length).toBeGreaterThan(0);
            expect(resultsOf(stray)).toEqual(resultsOf(plain));
          }, consumer),
        ),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "plain ltm mcp is unchanged",
    () =>
      withDemoGitBank((root) =>
        withMcp(bankEnv(root), root, async (client) => {
          const { tools } = await client.listTools();
          expect(tools.map((t) => t.name).sort()).toEqual(["amend", "facets", "head", "propose", "query", "read", "validate"]);
          expect(Object.keys(tools.find((t) => t.name === "query")?.inputSchema.properties ?? {})).toContain("bank");
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "refusals happen before binding",
    () =>
      withDemoGitBank(async (root) => {
        // Held ports turn a bind attempted before a check into "can't listen", not the refusal under test.
        const any = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response() });
        const loop = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        try {
          const held = any.port;
          const env = bankEnv(root);
          const mcp = (argv: string[], e: Env) => run({ argv: ["mcp", ...argv], cwd: root, env: e });

          let r = await mcp(["--http", `0.0.0.0:${held}`], env);
          expect(r.exitCode).toBe(1);
          expect(r.stderr).toBe(NOT_LOOPBACK(`0.0.0.0:${held}`));

          r = await mcp(["--http", `[::]:${held}`], env);
          expect(r.exitCode).toBe(1);
          expect(r.stderr).toBe(NOT_LOOPBACK(`[::]:${held}`));

          // Control: with --trust-proxy-auth the bind runs and hits the held port. If it didn't, the two refusals above would prove nothing.
          r = await mcp(["--http", `0.0.0.0:${held}`, "--trust-proxy-auth"], env);
          expect(r.exitCode).toBe(1);
          expect(r.stderr.startsWith(`ltm mcp: can't listen on 0.0.0.0:${held}`)).toBe(true);

          for (const e of [{}, { LTM_BANK_PATH: "", LTM_BANK_URL: "" }]) {
            r = await mcp(["--http", String(loop.port)], e);
            expect(r.exitCode).toBe(1);
            expect(r.stderr).toBe(NO_BANK);
          }

          r = await mcp(["--http", String(loop.port)], { ...env, LTM_BANK_TTL: "abc" });
          expect(r.exitCode).toBe(1);
          expect(r.stderr).toContain("LTM_BANK_TTL");
        } finally {
          any.stop(true);
          loop.stop(true);
        }
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "a malformed LTM_CONSUMER_REPO refuses to start",
    () =>
      withDemoGitBank(async (root) => {
        // A held port turns a bind attempted before the check into "can't listen", not the refusal under test.
        const loop = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        try {
          // The newline is what a shell-built `--env-vars` leaves behind; it must be refused, not trimmed into a match.
          for (const value of ["not-a-repo", "acme/order-service\n", "acme/order service", "/acme/x", "acme/x/", "acme//x", "acme/.git"]) {
            const r = await run({ argv: ["mcp", "--http", String(loop.port)], cwd: root, env: { ...bankEnv(root), LTM_CONSUMER_REPO: value } });
            expect(r.exitCode).toBe(1);
            expect(r.stderr).toBe(`ltm mcp: LTM_CONSUMER_REPO must be <org>/<repo>, got '${value}'\n`);
          }
        } finally {
          loop.stop(true);
        }
      }),
    MCP_TEST_TIMEOUT,
  );

  // Each test compares against the `results` array `ltm query --json` prints, so a count or a key computed from the mapping can't pass by itself.
  type Row = { frontmatter: { applies_to?: string[] } };
  const cliResults = async (root: string, cwd: string, ...extra: string[]): Promise<Row[]> =>
    JSON.parse((await run({ argv: ["query", "--json", `--bank=${root}`, ...extra], cwd, env: bankEnv(root) })).stdout).results;
  const appliesTo = (r: Row) => r.frontmatter.applies_to ?? [];
  const OBSERVABILITY = "system:observability";

  test(
    "LTM_CONSUMER_REPO maps a query from a non-repo cwd",
    () =>
      withDemoGitBank((root) =>
        withConsumerRepo(async (consumer) => {
          const env = { ...bankEnv(root), LTM_CONSUMER_REPO: "acme/order-service" };
          const mapped = await cliResults(root, consumer);
          const orgWide = await cliResults(root, tmpdir());
          expect(mapped.length).toBeGreaterThan(orgWide.length);
          await withHttpMcp(env, ["0"], async (client) => {
            expect(resultsOf(await client.callTool({ name: "query", arguments: {} }))).toEqual(mapped);
          });
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "LTM_CONSUMER_REPO strips a trailing .git",
    () =>
      withDemoGitBank((root) =>
        withConsumerRepo(async (consumer) => {
          const env = { ...bankEnv(root), LTM_CONSUMER_REPO: "acme/order-service.git" };
          const expected = await cliResults(root, consumer);
          expect(expected.length).toBeGreaterThan((await cliResults(root, tmpdir())).length);
          await withHttpMcp(env, ["0"], async (client) => {
            expect(resultsOf(await client.callTool({ name: "query", arguments: {} }))).toEqual(expected);
          });
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "LTM_CONSUMER_REPO keeps other dotted suffixes",
    () =>
      withDemoGitBank((root) =>
        withConsumerRepo(async (consumer) => {
          const env = { ...bankEnv(root), LTM_CONSUMER_REPO: "acme/order-service.github" };
          const expected = await cliResults(root, tmpdir());
          await withHttpMcp(env, ["0"], async (client) => {
            expect(resultsOf(await client.callTool({ name: "query", arguments: {} }))).toEqual(expected);
          });
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "LTM_CONSUMER_REPO maps text queries and ignores case",
    () =>
      withDemoGitBank((root) =>
        withConsumerRepo(async (consumer) => {
          const env = { ...bankEnv(root), LTM_CONSUMER_REPO: "ACME/Order-Service" };
          const mapped = await cliResults(root, consumer, "--text=postgres");
          expect(mapped.length).toBeGreaterThan(0);
          await withHttpMcp(env, ["0"], async (client) => {
            expect(resultsOf(await client.callTool({ name: "query", arguments: { text: "postgres" } }))).toEqual(mapped);
          });
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "without LTM_CONSUMER_REPO a non-repo cwd gets Org-wide Records only",
    () =>
      withDemoGitBank(async (root) => {
        const orgWide = await cliResults(root, tmpdir());
        expect(orgWide.length).toBeGreaterThan(0);
        for (const value of [undefined, ""]) {
          await withHttpMcp({ ...bankEnv(root), LTM_CONSUMER_REPO: value }, ["0"], async (client) => {
            const rows = resultsOf(await client.callTool({ name: "query", arguments: {} })) as Row[];
            for (const row of rows) expect(appliesTo(row)).toEqual([]);
            expect(rows).toEqual(orgWide);
          });
        }
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "LTM_CONSUMER_REPO accepts a nested group path",
    () =>
      withDemoGitBank(async (root) => {
        // A GitLab subgroup key that `ltm query` could build from a checkout; the demo Bank doesn't map it, so it falls back to Org-wide.
        const orgWide = await cliResults(root, tmpdir());
        await withHttpMcp({ ...bankEnv(root), LTM_CONSUMER_REPO: "group/sub/repo" }, ["0"], async (client) => {
          expect(resultsOf(await client.callTool({ name: "query", arguments: {} }))).toEqual(orgWide);
        });
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "explicit facets override LTM_CONSUMER_REPO",
    () =>
      withDemoGitBank(async (root) => {
        const expected = await cliResults(root, tmpdir(), `--facet=${OBSERVABILITY}`);
        // The Facet's two tagged Records, plus the Org-wide ones that every Facet query also returns.
        const tagged = expected.filter((r) => appliesTo(r).length > 0);
        expect(tagged.length).toBe(2);
        for (const row of tagged) expect(appliesTo(row)).toContain(OBSERVABILITY);
        await withHttpMcp({ ...bankEnv(root), LTM_CONSUMER_REPO: "acme/order-service" }, ["0"], async (client) => {
          expect(resultsOf(await client.callTool({ name: "query", arguments: { facets: [OBSERVABILITY] } }))).toEqual(expected);
        });
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "LTM_CONSUMER_REPO wins over the cwd's origin",
    () =>
      withDemoGitBank((root) =>
        withConsumerRepo(async (consumer) => {
          const mapped = await cliResults(root, consumer);
          const orgWide = await cliResults(root, tmpdir());
          git(consumer, "remote", "set-url", "origin", "https://github.com/acme/other-service.git");
          await withHttpMcp({ ...bankEnv(root), LTM_CONSUMER_REPO: "acme/order-service" }, ["0"], async (client) => {
            expect(resultsOf(await client.callTool({ name: "query", arguments: {} }))).toEqual(mapped);
          }, consumer);
          // Falsifier: without the variable the same cwd is an unmapped repo, so the answer must differ from the mapped one.
          await withHttpMcp({ ...bankEnv(root), LTM_CONSUMER_REPO: undefined }, ["0"], async (client) => {
            const rows = resultsOf(await client.callTool({ name: "query", arguments: {} }));
            expect(rows).toEqual(orgWide);
            expect(rows).not.toEqual(mapped);
          }, consumer);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test("bad flags are usage errors", async () => {
    for (const argv of [["--http", "8080x"], ["--http", "host:"], ["--http", "70000"], ["--trust-proxy-auth"]]) {
      expect((await run({ argv: ["mcp", ...argv], cwd: tmpdir(), env: {} })).exitCode).toBe(2);
    }
    expect(parseListen("8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
    expect(parseListen("[::1]:9")).toEqual({ hostname: "::1", port: 9 });
    for (const h of ["localhost", "127.0.0.2", "::1"]) expect(isLoopback(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "10.0.0.1"]) expect(isLoopback(h)).toBe(false);
  });

  test(
    "a bare port binds loopback",
    () =>
      withDemoGitBank((root) =>
        withHttpMcp(bankEnv(root), ["0"], async (client, url) => {
          expect(new URL(url).hostname).toBe("127.0.0.1");
          expect((await client.listTools()).tools.length).toBe(4);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "loopback refuses a foreign Host",
    () =>
      withDemoGitBank((root) =>
        withHttpMcp(bankEnv(root), ["0"], async (_client, url) => {
          const port = Number(new URL(url).port);
          const init = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "evil", version: "0" } },
          });
          expect(await rawStatus(port, "POST", "/mcp", `evil.example:${port}`, init)).toBe(403);
          expect(await rawStatus(port, "GET", "/other", `127.0.0.1:${port}`)).toBe(404);
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "a slow first clone still answers",
    () =>
      withGitBank(({ bare }) =>
        withScratch(async (dir) => {
          const binDir = join(dir, "bin");
          const dataDir = join(dir, "data");
          for (const d of [binDir, dataDir]) mkdirSync(d);
          // Only the clone sleeps: the server also runs git rev-parse on every read. 12s is past Bun's 10s default idleTimeout.
          writeFileSync(join(binDir, "git"), `#!/bin/sh\n[ "$1" = clone ] && sleep 12\nexec ${Bun.which("git")} "$@"\n`);
          chmodSync(join(binDir, "git"), 0o755);
          const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, LTM_BANK_URL: bare, LTM_DATA_DIR: dataDir, LTM_BANK_PATH: undefined };
          await withHttpMcp(env, ["0"], async (client) => {
            const r = await client.callTool({ name: "query", arguments: {} });
            expect(r.isError).toBeFalsy();
            expect(resultsOf(r).length).toBeGreaterThan(0);
          });
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "a credentialed LTM_BANK_URL stays redacted",
    () =>
      withScratch(async (dataDir) => {
        const env = { ...process.env, LTM_BANK_URL: "https://user:s3cret@127.0.0.1:1/bank.git", LTM_DATA_DIR: dataDir, LTM_BANK_PATH: undefined };
        await withHttpMcp(env, ["0"], async (client) => {
          const r = await client.callTool({ name: "query", arguments: {} });
          expect(r.isError).toBe(true);
          expect(textOf(r)).not.toContain("s3cret");
          expect(JSON.stringify(r)).not.toContain("s3cret");
        });
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "one locator per process",
    () =>
      withGitBank(({ bare, clone }) =>
        withScratch(async (dataDir) => {
          const env = { ...process.env, LTM_BANK_URL: bare, LTM_DATA_DIR: dataDir, LTM_BANK_PATH: undefined, LTM_BANK_TTL: "300" };
          const commits = (r: Called) => Object.values((r.structuredContent as { bank_commits: Record<string, string> }).bank_commits);
          let a: string[] = [];
          await withHttpMcp(env, ["0"], async (client) => {
            a = commits(await client.callTool({ name: "query", arguments: {} }));
            writeFileSync(join(clone, "later.txt"), "later\n");
            git(clone, "add", "-A");
            git(clone, ...IDENTITY, "commit", "--quiet", "-m", "later");
            git(clone, "push", "--quiet", "origin", "main");
            // A per-request locator would fetch here and report the new HEAD.
            expect(commits(await client.callTool({ name: "query", arguments: {} }))).toEqual(a);
          });
          const fresh = git(clone, "rev-parse", "HEAD").trim();
          expect(a).not.toEqual([fresh]);
          await withHttpMcp({ ...env, LTM_BANK_TTL: "0" }, ["0"], async (client) => {
            expect(commits(await client.callTool({ name: "query", arguments: {} }))).toEqual([fresh]);
          });
        }),
      ),
    MCP_TEST_TIMEOUT,
  );
});
