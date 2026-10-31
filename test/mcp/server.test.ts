import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { run } from "../../src/cli/run.ts";
import * as query from "../../src/core/query.ts";
import { createServer } from "../../src/mcp/server.ts";
import { withConsumerRepo } from "../helpers/consumer-repo.ts";
import { git, IDENTITY, withGitBank } from "../helpers/git-bank.ts";
import { withDemoGitBank, withMcp } from "../helpers/mcp.ts";

// Twice the 30s git-test budget, because each test also boots a bun server over stdio and runs the CLI per call. bun's 5s default flakes under load.
const MCP_TEST_TIMEOUT = 60_000;
const bin = new URL("../../src/cli/bin.ts", import.meta.url).pathname;
const POSTGRES = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";

type Called = Awaited<ReturnType<Client["callTool"]>>;

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  return client.callTool({ name, arguments: args });
}

function ok(r: Called): Record<string, unknown> {
  if (r.isError) throw new Error(`tool error: ${textOf(r)}`);
  return r.structuredContent as Record<string, unknown>;
}

const textOf = (r: Called): string => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");

function minusCommits(sc: Record<string, unknown>): Record<string, unknown> {
  const { bank_commits: _, ...rest } = sc;
  return rest;
}

const head = (dir: string): string => git(dir, "rev-parse", "HEAD").trim();

// Build the expected side from the CLI as a user types it. Rebuilding it from the handler's argv would only check the handler against itself.
async function cli(argv: string[], cwd: string, env: Record<string, string | undefined>): Promise<string> {
  return (await run({ argv, cwd, env })).stdout;
}

async function withServer<T>(fn: (s: { client: Client; bank: string; consumer: string; env: Record<string, string | undefined> }) => Promise<T>, edit?: (root: string) => void): Promise<T> {
  return withDemoGitBank(
    (bank) =>
      withConsumerRepo(async (consumer) => {
        const env = { ...process.env, LTM_BANK_PATH: bank };
        return withMcp(env, consumer, (client) => fn({ client, bank, consumer, env }));
      }),
    edit,
  );
}

describe("ltm mcp, read-only tools", () => {
  test(
    "lists the six tools, every input described",
    () =>
      withServer(async ({ client }) => {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(["facets", "head", "propose", "query", "read", "validate"]);
        for (const t of tools) {
          const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
          expect(Object.keys(props).length).toBeGreaterThan(0);
          for (const [key, p] of Object.entries(props)) {
            expect({ tool: t.name, key, ok: typeof p.description === "string" && p.description !== "" }).toEqual({ tool: t.name, key, ok: true });
          }
        }
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "query matches `ltm query --bank <bank> --json` for each input set",
    () =>
      withServer(async ({ client, bank, consumer, env }) => {
        // The third set matches no Record in the demo Bank (an explicit --facet drops the org-wide fallback), so the fourth adds a Facet set that does.
        const cases: [Record<string, unknown>, string[], boolean][] = [
          [{}, [], true],
          [{ filters: { status: "accepted" } }, ["status=accepted"], true],
          [{ type: "PolicyRule", facets: ["service:order-service"] }, ["--type", "PolicyRule", "--facet", "service:order-service"], false],
          [{ facets: ["domain:commerce"], status: ["accepted", "superseded"] }, ["--facet", "domain:commerce", "--status", "accepted", "--status", "superseded"], true],
          [{ text: "postgres", all: true }, ["--text", "postgres", "--all"], true],
        ];
        for (const [args, argv, rows] of cases) {
          const r = await call(client, "query", args);
          const sc = ok(r);
          const expected = JSON.parse(await cli(["query", "--bank", bank, "--json", ...argv], consumer, env));
          expect({ argv, rows: expected.results.length > 0 }).toEqual({ argv, rows });
          expect(minusCommits(sc)).toEqual(expected);
          expect(sc.bank_commits).toEqual({ acme: head(bank) });
          expect(textOf(r)).toBe(await cli(["query", "--bank", bank, ...argv], consumer, env));
        }
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "head by id and by path matches `ltm head`, and refuses a path outside the Bank",
    () =>
      withServer(async ({ client, bank, env }) => {
        const expected = await cli(["head", POSTGRES], bank, env);
        expect(expected).toStartWith("---\n");
        for (const args of [{ id: "kQ7vN2xLp4" }, { path: POSTGRES }]) {
          const sc = ok(await call(client, "head", args));
          expect(sc).toEqual({ path: POSTGRES, head: expected, bank_commits: { acme: head(bank) } });
        }
        const out = await call(client, "head", { path: "../../etc/passwd" });
        expect(out.isError).toBe(true);
        expect(textOf(out)).toContain("outside the Bank");
        expect((await call(client, "head", { id: "kQ7vN2xLp4", path: POSTGRES })).isError).toBe(true);
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "read by id and by path returns the whole Record file, and refuses what isn't one",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "ltm-mcp-outside-"));
      writeFileSync(join(outside, "secret.md"), "not a Record\n");
      try {
        await withServer(
          async ({ client, bank }) => {
            const expected = readFileSync(join(bank, POSTGRES), "utf8");
            // head stops at the frontmatter, so a read that wraps head can't pass on this.
            expect(expected).toContain("\n## Decision\n");
            expect(ok(await call(client, "head", { id: "kQ7vN2xLp4" })).head).not.toContain("\n## Decision\n");
            for (const args of [{ id: "kQ7vN2xLp4" }, { path: POSTGRES }]) {
              const r = await call(client, "read", args);
              expect(ok(r)).toEqual({ path: POSTGRES, text: expected, bank_commits: { acme: head(bank) } });
              expect(textOf(r)).toBe(expected);
            }
            const refusals: [Record<string, unknown>, string][] = [
              [{ path: "../memory-bank.yaml" }, "../memory-bank.yaml is outside the Bank"],
              [{ path: "_memory/leak.md" }, "_memory/leak.md is outside the Bank"],
              [{ path: "memory-bank.yaml" }, "memory-bank.yaml is not a Record in the Bank"],
              [{ id: "kQ7vN2xLp4", path: POSTGRES }, "give exactly one of id or path"],
              [{}, "give exactly one of id or path"],
            ];
            for (const [args, msg] of refusals) {
              const r = await call(client, "read", args);
              expect({ args, isError: r.isError, text: textOf(r) }).toEqual({ args, isError: true, text: msg });
            }
          },
          (root) => symlinkSync(join(outside, "secret.md"), join(root, "_memory/leak.md")),
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
    MCP_TEST_TIMEOUT,
  );

  test(
    "facets and validate match their `--json` arrays",
    () =>
      withServer(async ({ client, bank, env }) => {
        for (const name of ["facets", "validate"]) {
          const sc = ok(await call(client, name));
          const expected = JSON.parse(await cli([name, "--json"], bank, env));
          expect(name === "facets" ? expected.length : 1).toBeGreaterThan(0);
          expect(sc).toEqual({ results: expected, bank_commits: { acme: head(bank) } });
        }
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "validate with a schema error is data, not a tool error",
    () =>
      withServer(
        async ({ client, bank, env }) => {
          const r = await call(client, "validate");
          expect(r.isError).toBeFalsy();
          const sc = ok(r);
          const expected = JSON.parse(await cli(["validate", "--json"], bank, env));
          expect(sc).toEqual({ results: expected, bank_commits: { acme: head(bank) } });
          expect(expected).toContainEqual(expect.objectContaining({ file: POSTGRES, severity: "error" }));
        },
        (root) => {
          const p = join(root, POSTGRES);
          writeFileSync(p, readFileSync(p, "utf8").replace("memory_type: Decision\n", "memory_type: Bogus\n"));
        },
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "a rejected filter is isError and the connection keeps serving",
    () =>
      withServer(async ({ client, bank }) => {
        // `a=b=c` parses as key `a`, so an empty key is the filter the CLI's own checkArgs rejects.
        const bad = await call(client, "query", { filters: { "": "c" } });
        expect(bad.isError).toBe(true);
        expect(textOf(bad)).toContain("invalid filter");
        const sc = ok(await call(client, "query"));
        expect((sc.results as unknown[]).length).toBeGreaterThan(0);
        expect(sc.bank_commits).toEqual({ acme: head(bank) });
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "query with a bank no config names fails with the CLI's own error",
    () =>
      withConsumerRepo(async (consumer) => {
        const env = { ...process.env, LTM_BANK_PATH: undefined, LTM_BANK_URL: undefined };
        const r = await withMcp(env, consumer, (client) => call(client, "query", { bank: "no-such-bank" }));
        expect(r.isError).toBe(true);
        const expected = await run({ argv: ["query", "--json", "--bank=no-such-bank"], cwd: consumer, env });
        expect(expected.exitCode).not.toBe(0);
        expect(textOf(r)).toBe(expected.stderr.trimEnd());
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "bank_commits is keyed by the aliases query rows carry, even when two Banks share a name",
    () =>
      withDemoGitBank((one) =>
        withDemoGitBank((two) =>
          withConsumerRepo(async (consumer) => {
            // Same memory-bank.yaml name in both; only the user-config aliases tell them apart. The second HEAD differs so a collapsed map can't pass by luck.
            git(two, ...IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "second");
            const cfgDir = mkdtempSync(join(tmpdir(), "ltm-cfg-"));
            try {
              writeFileSync(join(cfgDir, "config.yaml"), `banks:\n  alpha: { path: ${one} }\n  beta: { path: ${two} }\n`);
              writeFileSync(join(consumer, ".ltm.yaml"), "banks: [alpha, beta]\n");
              const env = { ...process.env, LTM_BANK_PATH: undefined, LTM_BANK_URL: undefined, LTM_CONFIG: join(cfgDir, "config.yaml") };
              const sc = ok(await withMcp(env, consumer, (client) => call(client, "query", {})));
              const commits = sc.bank_commits as Record<string, string>;
              expect(commits).toEqual({ alpha: head(one), beta: head(two) });
              expect(head(one)).not.toBe(head(two));
              const rows = sc.results as { bank: string }[];
              expect(new Set(rows.map((r) => r.bank))).toEqual(new Set(["alpha", "beta"]));
              for (const r of rows) expect(Object.keys(commits)).toContain(r.bank);
            } finally {
              rmSync(cfgDir, { recursive: true, force: true });
            }
          }),
        ),
      ),
    MCP_TEST_TIMEOUT,
  );

  test("a bad LTM_BANK_TTL exits 1 before serving", () => {
    const r = spawnSync(process.execPath, [bin, "mcp"], { env: { ...process.env, LTM_BANK_TTL: "abc" }, input: "", encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("ltm mcp: LTM_BANK_TTL 'abc' is not a whole number of seconds\n");
  }, MCP_TEST_TIMEOUT);
});

const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

// A `git` first on PATH that logs its argv, so the suite counts the fetches the server really ran.
async function withRig<T>(fn: (rig: { path: string; dataDir: string; fetches: () => number }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ltm-mcp-rig-"));
  const binDir = join(dir, "bin");
  const log = join(dir, "git.log");
  const dataDir = join(dir, "data");
  execFileSync("mkdir", ["-p", binDir, dataDir]);
  writeFileSync(log, "");
  writeFileSync(join(binDir, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(binDir, "git"), 0o755);
  const fetches = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => / fetch( |$)/.test(` ${l}`)).length;
  try {
    return await fn({ path: `${binDir}:${process.env.PATH}`, dataDir, fetches });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function advance(bare: string): string {
  const work = mkdtempSync(join(tmpdir(), "ltm-mcp-adv-"));
  try {
    git(work, "clone", "--quiet", bare, ".");
    writeFileSync(join(work, "extra.txt"), `${Date.now()}\n`);
    git(work, "add", "-A");
    git(work, ...IDENTITY, "commit", "--quiet", "-m", "advance");
    git(work, "push", "--quiet", "origin", "main");
    return git(bare, "rev-parse", "main").trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("ltm mcp under LTM_BANK_URL", () => {
  test(
    "an unreachable remote still answers from the clone, with a staleness note",
    () =>
      withGitBank(({ bare }) =>
        withConsumerRepo(async (consumer) => {
          const dataDir = mkdtempSync(join(tmpdir(), "ltm-mcp-data-"));
          try {
            const env = { ...process.env, LTM_BANK_URL: bare, LTM_DATA_DIR: dataDir, LTM_BANK_TTL: "0" };
            const clone = join(dataDir, "banks", createHash("sha1").update(bare).digest("hex"));
            await withMcp(env, consumer, async (client) => {
              const first = ok(await call(client, "query"));
              expect(first.bank_notes).toBeUndefined();
              git(clone, "remote", "set-url", "origin", "/nonexistent");
              const r = await call(client, "query");
              const sc = ok(r);
              expect(sc.results).toEqual(first.results);
              expect(sc.bank_notes).toEqual([expect.stringMatching(/^can't refresh Bank from /)]);
              const human = await cli(["query", "--bank", clone], consumer, env);
              expect(human).not.toBe("");
              expect(textOf(r)).toBe(human);
            });
          } finally {
            rmSync(dataDir, { recursive: true, force: true });
          }
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "old SHA within the TTL, new SHA after it, one fetch per expired TTL, none under LTM_BANK_PATH",
    () =>
      withGitBank(({ bare }) =>
        withConsumerRepo((consumer) =>
          withRig(async ({ path, dataDir, fetches }) => {
            const env = { ...process.env, PATH: path, LTM_BANK_URL: bare, LTM_DATA_DIR: dataDir };
            const old = git(bare, "rev-parse", "main").trim();
            let fresh = "";
            await withMcp({ ...env, LTM_BANK_TTL: "3600" }, consumer, async (client) => {
              expect(ok(await call(client, "query")).bank_commits).toEqual({ acme: old });
              fresh = advance(bare);
              expect(ok(await call(client, "query")).bank_commits).toEqual({ acme: old });
            });
            expect(fetches()).toBe(0);
            await withMcp({ ...env, LTM_BANK_TTL: "0" }, consumer, async (client) => {
              expect(ok(await call(client, "query")).bank_commits).toEqual({ acme: fresh });
              expect(fetches()).toBe(1);
              expect(ok(await call(client, "query")).bank_commits).toEqual({ acme: fresh });
              expect(fetches()).toBe(2);
            });
            await withDemoGitBank(async (other) => {
              await withMcp({ ...env, LTM_BANK_TTL: "0", LTM_BANK_PATH: other }, consumer, async (client) => {
                expect(ok(await call(client, "query")).bank_commits).toEqual({ acme: head(other) });
              });
            });
            expect(fetches()).toBe(2);
          }),
        ),
      ),
    MCP_TEST_TIMEOUT,
  );
});

describe("ltm mcp, an env-selected path that is not a Bank root", () => {
  test(
    "facets, validate and query refuse it instead of resolving the parent Bank, and the server keeps answering",
    () =>
      withDemoGitBank((bank) =>
        withConsumerRepo((consumer) =>
          withMcp({ ...process.env, LTM_BANK_PATH: join(bank, "_memory") }, consumer, async (client) => {
            for (const name of ["facets", "validate", "query"]) {
              const r = await client.callTool({ name, arguments: {} });
              expect(r.isError).toBe(true);
              expect(textOf(r)).toContain(`LTM_BANK_PATH '${join(bank, "_memory")}' has no memory-bank.yaml`);
            }
            const { tools } = await client.listTools();
            expect(tools.map((t) => t.name)).toContain("query");
          }),
        ),
      ),
    MCP_TEST_TIMEOUT,
  );
});

const MOVED = "_memory/decisions/postgres-moved-kQ7vN2xLp4.md";
const OVERVIEW = "_memory/context/order-service-overview-gN5yD9sMe2.md";
const idOf = (text: unknown): string | undefined => String(text).match(/^id: (\S+)$/m)?.[1];

// The swap issue #111 names: kQ7vN2xLp4 leaves POSTGRES and gN5yD9sMe2 takes its old path, in one commit.
function refresh(bank: string): void {
  git(bank, "mv", POSTGRES, MOVED);
  git(bank, "mv", OVERVIEW, POSTGRES);
  git(bank, ...IDENTITY, "commit", "--quiet", "-m", "refresh");
}

// In-process rather than withMcp, because a spy in this process can't reach a stdio subprocess.
async function inProcess<T>(bank: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer({ ...process.env, LTM_BANK_PATH: bank, LTM_BANK_URL: undefined }, bank);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "ltm-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// Lands the refresh right after the first listRecords call and hands back the pre-refresh list, so the race is deterministic.
function refreshAfterFirstList(bank: string): void {
  const real = query.listRecords;
  let fired = false;
  spyOn(query, "listRecords").mockImplementation((config, onSkip) => {
    const out = real(config, onSkip);
    if (!fired) {
      fired = true;
      refresh(bank);
    }
    return out;
  });
}

describe("ltm mcp, a refresh that moves an id mid-request", () => {
  afterEach(() => mock.restore());

  for (const tool of ["head", "read"]) {
    test(
      `${tool} by id answers for the id at the commit bank_commits names, not for the Record now at its old path`,
      () =>
        withDemoGitBank((bank) =>
          inProcess(bank, async (client) => {
            const seed = head(bank);
            refreshAfterFirstList(bank);
            const sc = ok(await call(client, tool, { id: "kQ7vN2xLp4" }));
            expect(head(bank)).not.toBe(seed);
            expect(sc.bank_commits).toEqual({ acme: head(bank) });
            expect({ path: sc.path, id: idOf(sc[tool === "head" ? "head" : "text"]) }).toEqual({ path: MOVED, id: "kQ7vN2xLp4" });
          }),
        ),
      MCP_TEST_TIMEOUT,
    );
  }

  test(
    "read by path answers for the path, so after the same refresh it returns gN5yD9sMe2",
    () =>
      withDemoGitBank((bank) =>
        inProcess(bank, async (client) => {
          refreshAfterFirstList(bank);
          const sc = ok(await call(client, "read", { path: POSTGRES }));
          expect(sc.bank_commits).toEqual({ acme: head(bank) });
          expect(sc.path).toBe(POSTGRES);
          expect(idOf(sc.text)).toBe("gN5yD9sMe2");
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  // head by path never lists Records, so the refresh lands before the request instead.
  test(
    "head by path answers for the path, so after a refresh it returns gN5yD9sMe2",
    () =>
      withDemoGitBank((bank) =>
        inProcess(bank, async (client) => {
          refresh(bank);
          const sc = ok(await call(client, "head", { path: POSTGRES }));
          expect(sc.bank_commits).toEqual({ acme: head(bank) });
          expect(sc.path).toBe(POSTGRES);
          expect(idOf(sc.head)).toBe("gN5yD9sMe2");
        }),
      ),
    MCP_TEST_TIMEOUT,
  );
});

describe("ltm mcp, an id request the Bank files fail", () => {
  afterEach(() => mock.restore());

  // The window a `git merge --ff-only` opens: worktree files change before the ref moves, so HEAD holds still over bytes that belong to the next commit.
  for (const tool of ["head", "read"]) {
    test(
      `${tool} by id errors rather than return another Record's bytes while HEAD has not moved`,
      () =>
        withDemoGitBank((bank) =>
          inProcess(bank, async (client) => {
            const seed = head(bank);
            // Every attempt sees the pre-overwrite list, as it would if the ref kept lagging the files for all 3 reads.
            const real = query.listRecords;
            let stale: ReturnType<typeof real> | undefined;
            spyOn(query, "listRecords").mockImplementation((config, onSkip) => {
              if (stale === undefined) {
                stale = real(config, onSkip);
                writeFileSync(join(bank, POSTGRES), readFileSync(join(bank, OVERVIEW)));
              }
              return stale;
            });
            const r = await call(client, tool, { id: "kQ7vN2xLp4" });
            expect(head(bank)).toBe(seed);
            expect(r.isError).toBe(true);
            expect(textOf(r)).toContain("the Bank moved during each of 3 reads; try again");
          }),
        ),
      MCP_TEST_TIMEOUT,
    );

    test(
      `${tool} by id reports a broken memory-bank.yaml the way the CLI does`,
      () =>
        withDemoGitBank((bank) =>
          inProcess(bank, async (client) => {
            // Valid when the server picks the Bank at startup, broken by the time relOf loads it.
            writeFileSync(join(bank, "memory-bank.yaml"), "bank: [unclosed\n");
            const r = await call(client, tool, { id: "kQ7vN2xLp4" });
            expect(r.isError).toBe(true);
            expect(textOf(r)).toStartWith(`ltm ${tool}: ${join(bank, "memory-bank.yaml")}`);
          }),
        ),
      MCP_TEST_TIMEOUT,
    );
  }
});

describe("ltm mcp, id refusals", () => {
  for (const tool of ["head", "read"]) {
    test(
      `${tool} by an unknown id says it matches no Record`,
      () => withServer(async ({ client }) => {
        const r = await call(client, tool, { id: "zzzzzzzzzz" });
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain("'zzzzzzzzzz' matches no Record");
      }),
      MCP_TEST_TIMEOUT,
    );

    test(
      `${tool} by an id two Records share says it is held by 2 Records`,
      () => withServer(
        async ({ client }) => {
          const r = await call(client, tool, { id: "kQ7vN2xLp4" });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toContain("'kQ7vN2xLp4' is held by 2 Records");
        },
        (root) => cpSync(join(root, POSTGRES), join(root, "_memory/decisions/postgres-copy-kQ7vN2xLp4.md")),
      ),
      MCP_TEST_TIMEOUT,
    );
  }

  // bank is refused while LTM_BANK_PATH picks the Bank, so this server's env drops both selectors and cwd sits outside the Bank.
  test(
    "read by id finds the Record in the Bank that bank names",
    () => withDemoGitBank((bank) => withConsumerRepo((consumer) => {
      const env = { ...process.env, LTM_BANK_PATH: undefined, LTM_BANK_URL: undefined };
      return withMcp(env, consumer, async (client) => {
        const sc = ok(await call(client, "read", { id: "kQ7vN2xLp4", bank }));
        expect(sc.path).toBe(POSTGRES);
        expect(idOf(sc.text)).toBe("kQ7vN2xLp4");
      });
    })),
    MCP_TEST_TIMEOUT,
  );
});
