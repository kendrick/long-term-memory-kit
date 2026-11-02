import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { BankLocator, bankCommits, namedRoot, parseTtl, type Picked } from "../../src/mcp/bank.ts";
import { git, IDENTITY, withGitBank } from "../helpers/git-bank.ts";

// Each test spawns many git processes; bun's 5s default flakes under load.
const GIT_TEST_TIMEOUT = 30_000;
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

type Rig = { env: Record<string, string | undefined>; dataDir: string; log: string; lines: () => string[]; fetches: () => number; gitCalls: () => number };

// A `git` first on PATH that logs its argv, so a test can count fetches the locator really ran.
async function withRig<T>(extra: Record<string, string>, fn: (rig: Rig) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ltm-rig-"));
  const bin = join(dir, "bin");
  const log = join(dir, "git.log");
  const dataDir = join(dir, "data");
  execFileSync("mkdir", ["-p", bin, dataDir]);
  writeFileSync(log, "");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const lines = () => readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LTM_DATA_DIR: dataDir, ...extra };
  try {
    return await fn({ env, dataDir, log, lines, fetches: () => lines().filter((l) => / fetch( |$)/.test(` ${l}`)).length, gitCalls: () => lines().length });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function picked(r: Picked | { error: string }): Picked {
  if ("error" in r) throw new Error(`expected a pick, got error: ${r.error}`);
  return r;
}

// Push one more commit to `bare` through a throwaway clone, returning the new main SHA.
function advance(bare: string): string {
  const work = mkdtempSync(join(tmpdir(), "ltm-adv-"));
  try {
    git(work, "clone", "--quiet", bare, ".");
    writeFileSync(join(work, "extra.txt"), "x\n");
    git(work, "add", "-A");
    git(work, ...IDENTITY, "commit", "--quiet", "-m", "advance");
    git(work, "push", "--quiet", "origin", "main");
    return git(bare, "rev-parse", "main").trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("pickBank", () => {
  test("LTM_BANK_PATH wins over LTM_BANK_URL and runs no git", async () => {
    await withRig({ LTM_BANK_PATH: "some/bank", LTM_BANK_URL: "/nonexistent/bank.git" }, async ({ env, gitCalls }) => {
      const work = mkdtempSync(join(tmpdir(), "ltm-work-"));
      try {
        mkdirSync(join(work, "some/bank"), { recursive: true });
        writeFileSync(join(work, "some/bank/memory-bank.yaml"), "name: x\n");
        const r = picked(await new BankLocator().pickBank({}, env, work));
        expect(r).toEqual({ root: resolve(work, "some/bank"), notes: [] });
        expect(gitCalls()).toBe(0);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  });

  test("LTM_BANK_PATH at a directory with no memory-bank.yaml is an error naming the value as given", async () => {
    const work = mkdtempSync(join(tmpdir(), "ltm-work-"));
    try {
      mkdirSync(join(work, "sub"));
      expect(await new BankLocator().pickBank({}, { LTM_BANK_PATH: "sub" }, work)).toEqual({ error: "LTM_BANK_PATH 'sub' has no memory-bank.yaml" });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("LTM_BANK_PATH at a directory holding a memory-bank.yaml directory is an error, not a walk up to a parent Bank", async () => {
    const work = mkdtempSync(join(tmpdir(), "ltm-work-"));
    try {
      mkdirSync(join(work, "sub/memory-bank.yaml"), { recursive: true });
      expect(await new BankLocator().pickBank({}, { LTM_BANK_PATH: "sub" }, work)).toEqual({ error: "LTM_BANK_PATH 'sub' has no memory-bank.yaml" });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test(
    "an LTM_BANK_URL clone with no memory-bank.yaml at its root is an error naming the redacted remote",
    async () => {
      const seed = mkdtempSync(join(tmpdir(), "ltm-seed-"));
      const bare = mkdtempSync(join(tmpdir(), "ltm-bare-"));
      try {
        mkdirSync(join(seed, "nested"));
        writeFileSync(join(seed, "nested/memory-bank.yaml"), "name: x\n");
        git(seed, "init", "--quiet", "--initial-branch=main");
        git(seed, "add", "-A");
        git(seed, ...IDENTITY, "commit", "--quiet", "-m", "seed");
        git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
        git(seed, "push", "--quiet", bare, "main:refs/heads/main");
        await withRig({ LTM_BANK_URL: bare }, async ({ env }) => {
          const locator = new BankLocator();
          const want = { error: `${bare} has no memory-bank.yaml at its root` };
          expect(await locator.pickBank({}, env, "/work")).toEqual(want);
          // Second call lands inside the TTL, where the clone already exists and no fetch runs.
          expect(await locator.pickBank({}, env, "/work")).toEqual(want);
        });
      } finally {
        for (const dir of [seed, bare]) rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_TEST_TIMEOUT,
  );

  test("neither variable set leaves root null so the CLI resolves", async () => {
    expect(await new BankLocator().pickBank({ bank: "acme" }, {}, "/work")).toEqual({ root: null, notes: [] });
  });

  test("a bank input is refused while an env var picks the Bank", async () => {
    expect(await new BankLocator().pickBank({ bank: "acme" }, { LTM_BANK_PATH: "/b" }, "/work")).toEqual({
      error: "bank can't be set while LTM_BANK_PATH or LTM_BANK_URL picks the Bank",
    });
  });

  test("LTM_BANK_URL without LTM_DATA_DIR is an error", async () => {
    expect(await new BankLocator().pickBank({}, { LTM_BANK_URL: "/x.git" }, "/work")).toEqual({ error: "LTM_BANK_URL needs LTM_DATA_DIR" });
    expect(await new BankLocator().pickBank({}, { LTM_BANK_URL: "/x.git", LTM_DATA_DIR: "" }, "/work")).toEqual({ error: "LTM_BANK_URL needs LTM_DATA_DIR" });
  });

  test(
    "the first LTM_BANK_URL request clones into $LTM_DATA_DIR/banks/<sha1>",
    async () => {
      await withGitBank(async ({ bare }) => {
        await withRig({ LTM_BANK_URL: bare }, async ({ env, dataDir, fetches }) => {
          const r = picked(await new BankLocator().pickBank({}, env, "/work"));
          expect(r.root).toBe(join(dataDir, "banks", createHash("sha1").update(bare).digest("hex")));
          expect(r.notes).toEqual([]);
          expect(git(r.root!, "rev-parse", "HEAD").trim()).toBe(git(bare, "rev-parse", "main").trim());
          expect(fetches()).toBe(0);
        });
      });
    },
    GIT_TEST_TIMEOUT,
  );

  test(
    "a failed clone is an error naming the redacted remote",
    async () => {
      await withRig({ LTM_BANK_URL: "https://user:tok@127.0.0.1:1/x.git" }, async ({ env }) => {
        const r = await new BankLocator().pickBank({}, env, "/work");
        expect("error" in r && r.error).toStartWith("can't clone https://127.0.0.1:1/x.git: ");
      });
    },
    GIT_TEST_TIMEOUT,
  );

  test(
    "refresh: old SHA and no fetch within the TTL, exactly one fetch per expired TTL",
    async () => {
      await withGitBank(async ({ bare }) => {
        await withRig({ LTM_BANK_URL: bare, LTM_BANK_TTL: "3600" }, async ({ env, fetches }) => {
          const oldSha = git(bare, "rev-parse", "main").trim();
          const hour = new BankLocator();
          const root = picked(await hour.pickBank({}, env, "/work")).root!;
          const newSha = advance(bare);
          picked(await hour.pickBank({}, env, "/work"));
          expect(git(root, "rev-parse", "HEAD").trim()).toBe(oldSha);
          expect(fetches()).toBe(0);

          const zero = new BankLocator();
          const env0 = { ...env, LTM_BANK_TTL: "0" };
          picked(await zero.pickBank({}, env0, "/work"));
          expect(fetches()).toBe(1);
          expect(git(root, "rev-parse", "HEAD").trim()).toBe(newSha);
          picked(await zero.pickBank({}, env0, "/work"));
          expect(fetches()).toBe(2);
        });
      });
    },
    GIT_TEST_TIMEOUT,
  );

  test(
    "concurrent requests on an expired TTL share one fetch",
    async () => {
      await withGitBank(async ({ bare }) => {
        await withRig({ LTM_BANK_URL: bare, LTM_BANK_TTL: "3600" }, async ({ env, fetches }) => {
          picked(await new BankLocator().pickBank({}, env, "/work"));
          const loc = new BankLocator();
          await Promise.all([loc.pickBank({}, env, "/work"), loc.pickBank({}, env, "/work")]);
          expect(fetches()).toBe(1);
        });
      });
    },
    GIT_TEST_TIMEOUT,
  );

  test(
    "an unreachable remote after a good clone still answers, with a staleness note",
    async () => {
      await withGitBank(async ({ bare }) => {
        await withRig({ LTM_BANK_URL: bare, LTM_BANK_TTL: "0" }, async ({ env }) => {
          const loc = new BankLocator();
          const root = picked(await loc.pickBank({}, env, "/work")).root!;
          git(root, "remote", "set-url", "origin", "/nonexistent");
          const r = picked(await loc.pickBank({}, env, "/work"));
          expect(r.root).toBe(root);
          expect(r.notes).toHaveLength(1);
          expect(r.notes[0]).toStartWith(`can't refresh Bank from ${bare}: `);
          expect(r.notes[0]).toEndWith(`; answering from ${git(root, "rev-parse", "--short", "HEAD").trim()}, which may be stale`);
        });
      });
    },
    GIT_TEST_TIMEOUT,
  );

  test(
    "the staleness note stays on every answer inside the TTL after a failed refresh, and a good refresh clears it",
    async () => {
      await withGitBank(async ({ bare }) => {
        await withRig({ LTM_BANK_URL: bare }, async ({ env, fetches }) => {
          // TTL is read per call, so 0 forces the one refresh attempt and 3600 keeps the next call inside the TTL that attempt started.
          const now = { ...env, LTM_BANK_TTL: "0" };
          const hour = { ...env, LTM_BANK_TTL: "3600" };
          const loc = new BankLocator();
          const root = picked(await loc.pickBank({}, now, "/work")).root!;
          git(root, "remote", "set-url", "origin", "/nonexistent");
          const failed = picked(await loc.pickBank({}, now, "/work"));
          expect(failed.notes).toEqual([expect.stringMatching(/^can't refresh Bank from /)]);
          expect(fetches()).toBe(1);

          const inside = picked(await loc.pickBank({}, hour, "/work"));
          expect(fetches()).toBe(1);
          expect(inside).toEqual({ root, notes: failed.notes });

          git(root, "remote", "set-url", "origin", bare);
          expect(picked(await loc.pickBank({}, now, "/work")).notes).toEqual([]);
          expect(fetches()).toBe(2);
          expect(picked(await loc.pickBank({}, hour, "/work")).notes).toEqual([]);
        });
      });
    },
    GIT_TEST_TIMEOUT,
  );
});

describe("parseTtl", () => {
  test("defaults to 300 and takes whole seconds only", () => {
    expect(parseTtl(undefined)).toBe(300);
    expect(parseTtl("0")).toBe(0);
    expect(parseTtl("42")).toBe(42);
    expect(parseTtl("abc")).toEqual({ error: "LTM_BANK_TTL 'abc' is not a whole number of seconds" });
    expect(parseTtl("-1")).toEqual({ error: "LTM_BANK_TTL '-1' is not a whole number of seconds" });
  });
});

describe("bankCommits", () => {
  test(
    "maps each given name to its root's HEAD, and a non-git dir to null",
    async () => {
      await withGitBank(async ({ clone }) => {
        const plain = mkdtempSync(join(tmpdir(), "ltm-plain-"));
        try {
          const out = bankCommits([{ name: "one", root: clone }, { name: "two", root: plain }]);
          expect(out).toEqual({ one: git(clone, "rev-parse", "HEAD").trim(), two: null });
        } finally {
          rmSync(plain, { recursive: true, force: true });
        }
      });
    },
    GIT_TEST_TIMEOUT,
  );

  test(
    "namedRoot takes memory-bank.yaml's name, else the basename",
    async () => {
      await withGitBank(async ({ clone }) => {
        expect(namedRoot(clone)).toEqual({ name: "acme", root: clone });
        const plain = mkdtempSync(join(tmpdir(), "ltm-plain-"));
        try {
          expect(namedRoot(plain)).toEqual({ name: plain.split("/").pop()!, root: plain });
        } finally {
          rmSync(plain, { recursive: true, force: true });
        }
      });
    },
    GIT_TEST_TIMEOUT,
  );
});

describe("BankLocator.reading", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // With no writer, reading runs fn before its first await, so a probe that hasn't run on return is queued behind a pending merge.
  // Boxed, since an async function returning the bare promise would wait for it.
  async function untilQueued(loc: BankLocator, root: string, fn: () => Promise<void>): Promise<{ done: Promise<void> }> {
    for (let i = 0; i < 300; i++) {
      let ran = false;
      const p = loc.reading([root], async () => {
        ran = true;
        await fn();
      });
      if (!ran) return { done: p };
      await p;
      await sleep(10);
    }
    throw new Error("no merge ever went pending");
  }

  test("a root with no writer runs fn at once", async () => {
    let ran = false;
    const p = new BankLocator().reading(["/no/writer"], async () => {
      ran = true;
      return 7;
    });
    expect(ran).toBe(true);
    expect(await p).toBe(7);
  });

  test(
    "a read started before a refresh holds the merge until it returns",
    async () => {
      await withGitBank(async ({ bare }) => {
        await withRig({ LTM_BANK_URL: bare, LTM_BANK_TTL: "0" }, async ({ env, log, lines }) => {
          const loc = new BankLocator();
          const root = picked(await loc.pickBank({}, env, "/work")).root!;
          const fresh = advance(bare);
          let release!: () => void;
          const held = new Promise<void>((r) => (release = r));
          const reader = loc.reading([root], async () => {
            await held;
            appendFileSync(log, "reader done\n");
          });
          const refresh = loc.pickBank({}, env, "/work");
          const probe = await untilQueued(loc, root, async () => {});
          await sleep(300);
          expect(lines().some((l) => / merge /.test(` ${l} `))).toBe(false);
          release();
          await reader;
          picked(await refresh);
          await probe.done;
          const order = lines();
          const merge = order.findIndex((l) => / merge /.test(` ${l} `));
          expect({ readerFirst: order.indexOf("reader done") >= 0 && order.indexOf("reader done") < merge }).toEqual({ readerFirst: true });
          expect(git(root, "rev-parse", "HEAD").trim()).toBe(fresh);
        });
      });
    },
    GIT_TEST_TIMEOUT,
  );

  test(
    "a failed merge still releases the reads queued behind it",
    async () => {
      await withGitBank(async ({ bare }) => {
        await withRig({ LTM_BANK_URL: bare, LTM_BANK_TTL: "0" }, async ({ env }) => {
          const loc = new BankLocator();
          const root = picked(await loc.pickBank({}, env, "/work")).root!;
          // No upstream, so `merge --ff-only @{u}` fails after the fetch succeeds.
          git(root, "branch", "--unset-upstream");
          let release!: () => void;
          const held = new Promise<void>((r) => (release = r));
          const reader = loc.reading([root], () => held);
          const refresh = loc.pickBank({}, env, "/work");
          let queuedRan = false;
          const queued = await untilQueued(loc, root, async () => {
            queuedRan = true;
          });
          release();
          await reader;
          await queued.done;
          expect(queuedRan).toBe(true);
          expect(picked(await refresh).notes).toEqual([expect.stringMatching(/^can't refresh Bank from /)]);
        });
      });
    },
    GIT_TEST_TIMEOUT,
  );
});
