import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import * as runModule from "../../src/cli/run.ts";
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
        // The third set matches only the demo Bank's org-wide PolicyRule, since an org-wide Record matches every Facet. The fourth is the only set passing `status` as an array, checked against repeated --status flags.
        const cases: [Record<string, unknown>, string[], boolean][] = [
          [{}, [], true],
          [{ filters: { status: "accepted" } }, ["status=accepted"], true],
          [{ type: "PolicyRule", facets: ["service:order-service"] }, ["--type", "PolicyRule", "--facet", "service:order-service"], true],
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
    "query with facets follows query.org_wide: exclude",
    () =>
      withServer(
        async ({ client }) => {
          const results = ok(await call(client, "query", { facets: ["service:order-service"] })).results as { path: string }[];
          expect(results.length).toBeGreaterThan(0);
          expect(results.map((r) => r.path)).not.toContain("_memory/policy-rules/services-have-codeowners-aW7kC3oRf2.md");
        },
        (root) => {
          const cfg = join(root, "memory-bank.yaml");
          writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\nquery:\n  org_wide: exclude\n`);
        },
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "query with facets still returns Org-wide Records under query.org_wide: include and with the key absent",
    async () => {
      for (const edit of [
        undefined,
        (root: string) => {
          const cfg = join(root, "memory-bank.yaml");
          writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\nquery:\n  org_wide: include\n`);
        },
      ]) {
        await withServer(async ({ client }) => {
          const results = ok(await call(client, "query", { facets: ["service:order-service"] })).results as { path: string }[];
          expect(results.map((r) => r.path)).toContain("_memory/policy-rules/services-have-codeowners-aW7kC3oRf2.md");
        }, edit);
      }
    },
    MCP_TEST_TIMEOUT * 2,
  );

  test(
    "query with body: true finds a body-only match",
    () => {
      const bodyOnly = "_memory/context/body-only-zQ1bB0dY01.md";
      return withServer(
        async ({ client, bank, consumer, env }) => {
          const pathsOf = (sc: Record<string, unknown>) => (sc.results as { path: string }[]).map((r) => r.path);
          const withBody = ok(await call(client, "query", { text: "zanzibarqueue", body: true }));
          expect(pathsOf(withBody)).toContain(bodyOnly);
          expect(minusCommits(withBody)).toEqual(JSON.parse(await cli(["query", "--bank", bank, "--json", "--text", "zanzibarqueue", "--body"], consumer, env)));
          expect(pathsOf(ok(await call(client, "query", { text: "zanzibarqueue" })))).not.toContain(bodyOnly);
        },
        (root) => {
          writeFileSync(
            join(root, bodyOnly),
            "---\nschema: 1\nid: zQ1bB0dY01\nmemory_type: Context\ntitle: Queue notes\nstatus: accepted\ndate: 2026-10-12\nsummary: S.\n---\n\nWe picked zanzibarqueue for retries.\n",
          );
        },
      );
    },
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
  return serve({ ...process.env, LTM_BANK_PATH: bank, LTM_BANK_URL: undefined }, bank, fn);
}

async function serve<T>(env: Record<string, string | undefined>, cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer(env, cwd);
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

describe("ltm mcp outside a Bank", () => {
  // A cwd in no Bank, whose origin no rule maps unless `rules` adds one, so only the user config can name a Bank.
  async function withConfig<T>(config: (one: string, two: string) => string, fn: (o: { env: Record<string, string | undefined>; consumer: string; one: string }) => Promise<T>): Promise<T> {
    return withDemoGitBank((one) =>
      withDemoGitBank((two) =>
        withConsumerRepo(async (consumer) => {
          const cfgDir = mkdtempSync(join(tmpdir(), "ltm-cfg-"));
          try {
            writeFileSync(join(cfgDir, "config.yaml"), config(one, two));
            const env = { ...process.env, LTM_BANK_PATH: undefined, LTM_BANK_URL: undefined, LTM_CONFIG: join(cfgDir, "config.yaml") };
            return await fn({ env, consumer, one });
          } finally {
            rmSync(cfgDir, { recursive: true, force: true });
          }
        }),
      ),
    );
  }
  const oneBank = (one: string, two: string) => `banks:\n  alpha: { path: ${one} }\n  beta: { path: ${two} }\ndefault: alpha\n`;
  const twoBanks = (one: string, two: string) => `${oneBank(one, two)}rules:\n  - { match: "github.com/acme/order-service", bank: alpha }\n  - { match: "github.com/acme/*", bank: beta }\n`;
  const facetNames = (sc: Record<string, unknown>) => (sc.results as { facet: string }[]).map((r) => r.facet);

  test(
    "facets, head, and read answer from the user config's one Bank",
    () =>
      withConfig(oneBank, ({ env, consumer, one }) =>
        withMcp(env, consumer, async (client) => {
          expect(facetNames(ok(await call(client, "facets")))).toContain("service:order-service");
          const sc = ok(await call(client, "head", { path: POSTGRES }));
          expect(sc.head).toStartWith("---\n");
          expect(sc.head).toContain("id: kQ7vN2xLp4\n");
          expect(ok(await call(client, "read", { id: "kQ7vN2xLp4" })).text).toBe(readFileSync(join(one, POSTGRES), "utf8"));
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "facets, head, and read fail naming both Banks when the config resolves two",
    () =>
      withConfig(twoBanks, ({ env, consumer }) =>
        withMcp(env, consumer, async (client) => {
          for (const [tool, args] of [["facets", {}], ["head", { path: POSTGRES }], ["read", { id: "kQ7vN2xLp4" }]] as const) {
            const r = await call(client, tool, args);
            expect(r.isError).toBe(true);
            expect(textOf(r)).toBe(`ltm ${tool}: 2 Banks resolve for ${consumer} (alpha, beta); pass bank to pick one`);
          }
        }),
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "LTM_BANK_PATH still beats the user config's Bank",
    () =>
      withDemoGitBank(
        (picked) =>
          withConfig(oneBank, async ({ env, consumer }) => {
            const facets = facetNames(ok(await withMcp({ ...env, LTM_BANK_PATH: picked }, consumer, (client) => call(client, "facets"))));
            expect(facets).toContain("system:env-pick");
          }),
        (root) => {
          const p = join(root, POSTGRES);
          writeFileSync(p, readFileSync(p, "utf8").replace("system:data-platform", "system:env-pick"));
        },
      ),
    MCP_TEST_TIMEOUT,
  );

  test(
    "validate still wants a Bank around the cwd",
    () =>
      withConfig(oneBank, async ({ env, consumer }) => {
        const r = await withMcp(env, consumer, (client) => call(client, "validate"));
        expect(r.isError).toBe(true);
        expect(textOf(r)).toBe(`ltm validate: no memory-bank.yaml in ${consumer} or any parent directory`);
      }),
    MCP_TEST_TIMEOUT,
  );
});

// On a merge with something to fast-forward, this `git` checks out the upstream files, touches `marker`, and sleeps 2s before HEAD moves. That holds open the window issue #124 names, so a read can land in it. It then runs the real `merge --ff-only`, which accepts a worktree and index that already match the target, so it needs no `reset --hard` stand-in.
function pausingGit(dir: string): { path: string; marker: string } {
  const binDir = join(dir, "bin");
  const marker = join(dir, "files-rewritten");
  execFileSync("mkdir", ["-p", binDir]);
  writeFileSync(
    join(binDir, "git"),
    `#!/bin/sh
g='${realGit}'
if [ "$3" = merge ] && [ "$("$g" -C "$2" rev-parse HEAD)" != "$("$g" -C "$2" rev-parse '@{u}')" ]; then
  "$g" -C "$2" checkout -q '@{u}' -- .
  touch '${marker}'
  sleep 2
fi
exec "$g" "$@"
`,
  );
  chmodSync(join(binDir, "git"), 0o755);
  return { path: `${binDir}:${process.env.PATH}`, marker };
}

function retitle(bare: string): string {
  const work = mkdtempSync(join(tmpdir(), "ltm-mcp-adv-"));
  try {
    git(work, "clone", "--quiet", bare, ".");
    const file = join(work, POSTGRES);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^title: .*$/m, "title: Postgres everywhere, revised"));
    git(work, ...IDENTITY, "commit", "--quiet", "-am", "retitle");
    git(work, "push", "--quiet", "origin", "main");
    return git(bare, "rev-parse", "main").trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const titleOf = (text: string): string | undefined => text.match(/^title: (.*)$/m)?.[1];
const titleAt = (bare: string, commit: unknown): string | undefined => titleOf(git(bare, "show", `${String(commit)}:${POSTGRES}`));
const COMMERCE = { facets: ["domain:commerce"] };

// POSTGRES's title in a query or head result: the bytes the falsifier ties to bank_commits.
function titleIn(tool: string, sc: Record<string, unknown>): string | undefined {
  if (tool === "head") return titleOf(String(sc.head));
  return (sc.results as { id: string; title: string }[]).find((r) => r.id === "kQ7vN2xLp4")?.title;
}

// The spy holds request 1 inside its read, after its own refresh, while `change` advances the remote and request 2 (a query) refreshes the clone. The hold waits up to 3s for the merge to rewrite the files, then reads.
type Raced = { bare: string; seed: string; fresh: string; first: Record<string, unknown>; second: Record<string, unknown> };

async function readUnderRefresh(tool: string, change: (bare: string) => string, check: (r: Raced) => void): Promise<void> {
  return withGitBank(({ bare }) =>
    withConsumerRepo(async (consumer) => {
      const dir = mkdtempSync(join(tmpdir(), "ltm-mcp-pause-"));
      try {
        const { path, marker } = pausingGit(dir);
        const env = { ...process.env, PATH: path, LTM_BANK_URL: bare, LTM_DATA_DIR: join(dir, "data"), LTM_BANK_TTL: "0", LTM_BANK_PATH: undefined };
        const seed = git(bare, "rev-parse", "main").trim();
        return await serve(env, consumer, async (client) => {
          const real = runModule.run;
          let fresh = "";
          let second: Promise<Called> | undefined;
          spyOn(runModule, "run").mockImplementation(async (input) => {
            if (second === undefined) {
              fresh = change(bare);
              second = call(client, "query", COMMERCE);
              for (const until = Date.now() + 3000; !existsSync(marker) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
            }
            return real(input);
          });
          const first = ok(await call(client, tool, tool === "head" ? { path: POSTGRES } : COMMERCE));
          check({ bare, seed, fresh, first, second: ok(await second!) });
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
}

describe("ltm mcp, a read that lands mid fast-forward of the clone", () => {
  afterEach(() => mock.restore());

  for (const tool of ["query", "head"]) {
    test(
      `${tool} returns bytes from the commit bank_commits names when the refresh rewrites the Record`,
      async () => {
        await readUnderRefresh(tool, retitle, ({ bare, seed, fresh, first, second }) => {
          const commit = (sc: Record<string, unknown>) => (sc.bank_commits as Record<string, string>).acme;
          expect(titleAt(bare, seed)).not.toBe(titleAt(bare, fresh));
          expect({ tool, title: titleIn(tool, first) }).toEqual({ tool, title: titleAt(bare, commit(first)) });
          expect({ title: titleIn("query", second), commit: commit(second) }).toEqual({ title: titleAt(bare, fresh), commit: fresh });
        });
      },
      MCP_TEST_TIMEOUT,
    );

    test(
      `${tool} under a refresh that leaves every Record alone returns bytes that match both commits`,
      async () => {
        await readUnderRefresh(tool, advance, ({ bare, seed, fresh, first }) => {
          expect(fresh).not.toBe(seed);
          const title = titleIn(tool, first);
          expect(title).toBe("Postgres everywhere");
          expect({ seed: titleAt(bare, seed), fresh: titleAt(bare, fresh) }).toEqual({ seed: title, fresh: title });
        });
      },
      MCP_TEST_TIMEOUT,
    );
  }
});

describe("ltm mcp, a config-resolved query whose Bank changes mid-read", () => {
  afterEach(() => mock.restore());

  test(
    "bank_commits names the Bank the rows came from after the user config switches its default",
    () =>
      withDemoGitBank((one) =>
        withDemoGitBank((two) =>
          withConsumerRepo(async (consumer) => {
            const cfgDir = mkdtempSync(join(tmpdir(), "ltm-cfg-"));
            try {
              const cfg = join(cfgDir, "config.yaml");
              const config = (pick: string) => `banks:\n  alpha: { path: ${one} }\n  beta: { path: ${two} }\ndefault: ${pick}\n`;
              writeFileSync(cfg, config("alpha"));
              const env = { ...process.env, LTM_BANK_PATH: undefined, LTM_BANK_URL: undefined, LTM_CONFIG: cfg };
              await serve(env, consumer, async (client) => {
                const real = runModule.run;
                let switched = false;
                // Lands after pinned resolved the roots and before the CLI resolves its own, so the rows come from beta.
                spyOn(runModule, "run").mockImplementation(async (input) => {
                  if (!switched) {
                    switched = true;
                    writeFileSync(cfg, config("beta"));
                  }
                  return real(input);
                });
                const r = await call(client, "query", {});
                if (r.isError) {
                  expect(textOf(r)).toContain("the Bank moved during each of 3 reads");
                  return;
                }
                const sc = r.structuredContent as Record<string, unknown>;
                const rows = sc.results as { bank: string }[];
                expect(rows.length).toBeGreaterThan(0);
                expect({ rowBanks: [...new Set(rows.map((x) => x.bank))], commitBanks: Object.keys(sc.bank_commits as object) }).toEqual({ rowBanks: ["beta"], commitBanks: ["beta"] });
              });
            } finally {
              rmSync(cfgDir, { recursive: true, force: true });
            }
          }),
        ),
      ),
    MCP_TEST_TIMEOUT,
  );
});

// Task 5 of #134: query's text comes from its --json rows, so Stage 0 runs once per request.
describe("ltm mcp, query runs the CLI once", () => {
  afterEach(() => mock.restore());

  // Resolved path (LTM_BANK_PATH, so --bank) from the consumer repo, and in-Bank path (cwd in the Bank, nothing picked).
  type At = { client: Client; bank: string; inBank: boolean; cwd: string; env: Record<string, string | undefined> };
  const atBoth = <T>(edit: ((root: string) => void) | undefined, extra: (bank: string) => Record<string, string>, fn: (o: At) => Promise<T>) =>
    withDemoGitBank(
      (bank) =>
        withConsumerRepo(async (consumer) => {
          const base = { ...process.env, LTM_BANK_URL: undefined, LTM_CONFIG: undefined, ...extra(bank) };
          for (const [inBank, cwd, env] of [
            [false, consumer, { ...base, LTM_BANK_PATH: bank }],
            [true, bank, { ...base, LTM_BANK_PATH: undefined }],
          ] as const) {
            await serve(env, cwd, (client) => fn({ client, bank, inBank, cwd, env }));
          }
        }),
      edit,
    );
  const none = () => ({});

  // Recorded from the server before it built query's text from rows (AC 1), never regenerated.
  test(
    "with no recall:, query's structuredContent and text match the pre-Stage-0 server",
    () =>
      atBoth(undefined, none, async ({ client, inBank }) => {
        const r = await call(client, "query", { text: "postgres" });
        const got = { structured: minusCommits(ok(r)), text: textOf(r) };
        if (inBank) expect(got).toMatchInlineSnapshot(`
          {
            "structured": {
              "results": [
                {
                  "frontmatter": {
                    "applies_to": [
                      "domain:commerce",
                      "system:data-platform",
                    ],
                    "date": "2026-02-10",
                    "id": "kQ7vN2xLp4",
                    "last_confirmed": "2026-09-01",
                    "memory_type": "Decision",
                    "owners": [
                      "team:commerce-architecture",
                    ],
                    "schema": 1,
                    "source_refs": [
                      "fixtures/hydration-sources/adr/0001-postgres.md",
                    ],
                    "status": "accepted",
                    "summary": "Acme services use PostgreSQL as their relational store, superseding the MySQL decision for all new and migrated services.",
                    "supersedes": [
                      "mB3tR9wZe1",
                    ],
                    "tags": [
                      "database",
                      "postgres",
                    ],
                    "title": "Postgres everywhere",
                  },
                  "id": "kQ7vN2xLp4",
                  "is_proposal": false,
                  "memory_type": "Decision",
                  "path": "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md",
                  "status": "accepted",
                  "summary": "Acme services use PostgreSQL as their relational store, superseding the MySQL decision for all new and migrated services.",
                  "title": "Postgres everywhere",
                },
                {
                  "frontmatter": {
                    "applies_to": [
                      "domain:commerce",
                      "system:data-platform",
                    ],
                    "date": "2026-02-10",
                    "id": "nR5hB2yTq8",
                    "last_confirmed": "2026-09-01",
                    "memory_type": "PolicyRule",
                    "owners": [
                      "team:commerce-architecture",
                    ],
                    "schema": 1,
                    "status": "accepted",
                    "summary": "A service in the commerce domain that needs a relational store runs PostgreSQL, not another engine.",
                    "tags": [
                      "database",
                      "postgres",
                      "relational-storage",
                      "data-platform",
                      "commerce-services",
                      "persistence-layer",
                      "operational-standards",
                    ],
                    "title": "Relational stores use PostgreSQL",
                  },
                  "id": "nR5hB2yTq8",
                  "is_proposal": false,
                  "memory_type": "PolicyRule",
                  "path": "_memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md",
                  "status": "accepted",
                  "summary": "A service in the commerce domain that needs a relational store runs PostgreSQL, not another engine.",
                  "title": "Relational stores use PostgreSQL",
                },
                {
                  "frontmatter": {
                    "applies_to": [
                      "service:billing-service",
                    ],
                    "date": "2026-03-02",
                    "effective_to": "2026-12-31",
                    "id": "tZ6qL0vKd1",
                    "memory_type": "Exception",
                    "owners": [
                      "team:commerce-architecture",
                    ],
                    "related": [
                      "constrained_by::nR5hB2yTq8",
                    ],
                    "review_by": "2026-11-15",
                    "schema": 1,
                    "status": "accepted",
                    "summary": "Billing-service may stay on MySQL until 2026-12-31 while its migration to Postgres completes.",
                    "title": "billing-service may keep MySQL until 2026-12",
                  },
                  "id": "tZ6qL0vKd1",
                  "is_proposal": false,
                  "memory_type": "Exception",
                  "path": "_memory/exceptions/legacy-billing-mysql-until-2026-12-tZ6qL0vKd1.md",
                  "status": "accepted",
                  "summary": "Billing-service may stay on MySQL until 2026-12-31 while its migration to Postgres completes.",
                  "title": "billing-service may keep MySQL until 2026-12",
                },
              ],
            },
            "text": 
          "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md  Decision  accepted  Postgres everywhere
          _memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md  PolicyRule  accepted  Relational stores use PostgreSQL
          _memory/exceptions/legacy-billing-mysql-until-2026-12-tZ6qL0vKd1.md  Exception  accepted  billing-service may keep MySQL until 2026-12
          "
          ,
          }
        `);
        else expect(got).toMatchInlineSnapshot(`
          {
            "structured": {
              "notes": [],
              "resolved_by": "flag",
              "results": [
                {
                  "bank": "acme",
                  "frontmatter": {
                    "applies_to": [
                      "domain:commerce",
                      "system:data-platform",
                    ],
                    "date": "2026-02-10",
                    "id": "kQ7vN2xLp4",
                    "last_confirmed": "2026-09-01",
                    "memory_type": "Decision",
                    "owners": [
                      "team:commerce-architecture",
                    ],
                    "schema": 1,
                    "source_refs": [
                      "fixtures/hydration-sources/adr/0001-postgres.md",
                    ],
                    "status": "accepted",
                    "summary": "Acme services use PostgreSQL as their relational store, superseding the MySQL decision for all new and migrated services.",
                    "supersedes": [
                      "mB3tR9wZe1",
                    ],
                    "tags": [
                      "database",
                      "postgres",
                    ],
                    "title": "Postgres everywhere",
                  },
                  "id": "kQ7vN2xLp4",
                  "is_proposal": false,
                  "memory_type": "Decision",
                  "path": "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md",
                  "status": "accepted",
                  "summary": "Acme services use PostgreSQL as their relational store, superseding the MySQL decision for all new and migrated services.",
                  "title": "Postgres everywhere",
                },
                {
                  "bank": "acme",
                  "frontmatter": {
                    "applies_to": [
                      "domain:commerce",
                      "system:data-platform",
                    ],
                    "date": "2026-02-10",
                    "id": "nR5hB2yTq8",
                    "last_confirmed": "2026-09-01",
                    "memory_type": "PolicyRule",
                    "owners": [
                      "team:commerce-architecture",
                    ],
                    "schema": 1,
                    "status": "accepted",
                    "summary": "A service in the commerce domain that needs a relational store runs PostgreSQL, not another engine.",
                    "tags": [
                      "database",
                      "postgres",
                      "relational-storage",
                      "data-platform",
                      "commerce-services",
                      "persistence-layer",
                      "operational-standards",
                    ],
                    "title": "Relational stores use PostgreSQL",
                  },
                  "id": "nR5hB2yTq8",
                  "is_proposal": false,
                  "memory_type": "PolicyRule",
                  "path": "_memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md",
                  "status": "accepted",
                  "summary": "A service in the commerce domain that needs a relational store runs PostgreSQL, not another engine.",
                  "title": "Relational stores use PostgreSQL",
                },
              ],
            },
            "text": 
          "acme:_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md  Decision  accepted  Postgres everywhere
          acme:_memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md  PolicyRule  accepted  Relational stores use PostgreSQL
          "
          ,
          }
        `);
      }),
    MCP_TEST_TIMEOUT,
  );

  // Counts calls to run(), the one door every CLI run in jsonTool goes through.
  const countRuns = (): (() => number) => {
    const real = runModule.run;
    let n = 0;
    spyOn(runModule, "run").mockImplementation(async (input) => {
      n++;
      return real(input);
    });
    return () => n;
  };

  test(
    "query runs the CLI once per request; facets and validate still run it twice",
    () =>
      atBoth(undefined, none, async ({ client }) => {
        for (const [name, args, runs] of [["query", { text: "postgres" }, 1], ["facets", {}, 2], ["validate", {}, 2]] as const) {
          const runsNow = countRuns();
          ok(await call(client, name, args));
          expect({ name, runs: runsNow() }).toEqual({ name, runs });
          mock.restore();
        }
      }),
    MCP_TEST_TIMEOUT,
  );

  test(
    "with recall: and no qmd on PATH, the fallback note reaches notes (--bank) and bank_notes (in-Bank)",
    async () => {
      // git only, so the server can still read HEAD while qmd is missing.
      const dir = mkdtempSync(join(tmpdir(), "ltm-mcp-noqmd-"));
      symlinkSync(realGit, join(dir, "git"));
      try {
        await atBoth(setSearchRecall, () => ({ PATH: dir }), async ({ client, inBank, cwd, env, bank }) => {
          const r = await call(client, "query", { text: "postgres" });
          const sc = ok(r);
          const rows = sc.results as { ranked_by: string }[];
          expect(rows.length).toBeGreaterThan(0);
          for (const x of rows) expect(x.ranked_by).toBe("lexical");
          const note = "recall: qmd not found on PATH; ranked by lexical";
          if (inBank) {
            expect(sc.bank_notes).toEqual([note]);
            expect(textOf(r)).toBe(await cli(["query", "--text", "postgres"], cwd, env));
          } else {
            expect(sc.notes).toEqual([`Bank "acme": ${note}`]);
            expect(sc.bank_notes).toBeUndefined();
            expect(textOf(r)).toBe(await cli(["query", "--bank", bank, "--text", "postgres"], cwd, env));
          }
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    MCP_TEST_TIMEOUT,
  );

  test(
    "with recall: and qmd ranking, rows and text match the CLI's, from one run",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ltm-mcp-qmd-"));
      writeFileSync(join(dir, "qmd"), FAKE_QMD);
      chmodSync(join(dir, "qmd"), 0o755);
      symlinkSync(realGit, join(dir, "git"));
      try {
        await atBoth(
          setSearchRecall,
          (bank) => {
            const decisions = join(bank, "_memory/decisions");
            const ls = readdirSync(decisions).map((f) => `   1.2 KB  Nov  5 10:00  qmd://decisions/${f}\n`).join("");
            return { PATH: dir, QMD_ROOT: decisions, QMD_LS: ls, QMD_OUT: JSON.stringify([{ file: `qmd://decisions/${POSTGRES.slice("_memory/decisions/".length)}`, score: 0.9 }]) };
          },
          async ({ client, inBank, cwd, env, bank }) => {
            const runs = countRuns();
            const r = await call(client, "query", { text: "postgres" });
            expect(runs()).toBe(1);
            mock.restore();
            const sc = ok(r);
            const argv = [...(inBank ? [] : ["--bank", bank]), "--text", "postgres"];
            const json = JSON.parse(await cli(["query", "--json", ...argv], cwd, env));
            const rows = inBank ? json : json.results;
            expect(rows[0]).toMatchObject({ path: POSTGRES, ranked_by: "qmd search", score: 0.9 });
            expect(minusCommits(sc)).toEqual(inBank ? { results: json } : json);
            expect(textOf(r)).toBe(await cli(["query", ...argv], cwd, env));
            expect(textOf(r).split("\n")[0]).toEndWith(`${POSTGRES}  Decision  accepted  Postgres everywhere`);
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    MCP_TEST_TIMEOUT,
  );
});

const setSearchRecall = (root: string) => {
  const cfg = join(root, "memory-bank.yaml");
  writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\nrecall: { backend: qmd, mode: search, collections: { Decision: decisions } }\n`);
};

// A stand-in qmd, copied from test/cli/query.test.ts, so no test runs the real binary or touches the user's index.
const FAKE_QMD = `#!/bin/sh
if [ "$1" = collection ]; then printf 'Collection: %s\\n  Path:     %s\\n' "$3" "$QMD_ROOT"; exit 0; fi
if [ "$1" = ls ]; then printf '%s' "$QMD_LS"; exit 0; fi
printf '%s' "$QMD_OUT"
`;
