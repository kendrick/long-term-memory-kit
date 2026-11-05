import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const env = { LTM_TODAY: "2026-10-09" };
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env });
const MQ = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe("ltm doctor", () => {
  test("1: demo Bank exits 0, prints well-formed lines, and writes nothing", async () => {
    await withScratch(demo, async (dir) => {
      const before = hashTree(dir);
      const r = await ltm(dir, "doctor");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.split("\n").filter((l) => l !== "");
      for (const l of lines) expect(l).toMatch(/^[^:]+: [a-z-]+: .+$/);
      expect(hashTree(dir)).toEqual(before);
    });
  });

  test("2: --json parses and every element has exactly the four keys", async () => {
    await withScratch(demo, async (dir) => {
      const before = hashTree(dir);
      const r = await ltm(dir, "doctor", "--json");
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>[];
      expect(Array.isArray(parsed)).toBe(true);
      for (const f of parsed) expect(Object.keys(f)).toEqual(["file", "check", "message", "related_files"]);
      expect(hashTree(dir)).toEqual(before);
    });
  });

  test("3: a broken related entry shows in both outputs and the exit stays 0", async () => {
    await withScratch(demo, async (dir) => {
      const file = join(dir, MQ);
      const src = readFileSync(file, "utf8");
      const edited = src.replace(/^status: .*$/m, (s) => `${s}\nrelated: [constrained_by::ZZZZZZZZZZ]`);
      expect(edited).not.toBe(src);
      writeFileSync(file, edited);
      const human = await ltm(dir, "doctor");
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain(`${MQ}: broken-related: `);
      expect(human.stdout).toContain("ZZZZZZZZZZ");
      const json = await ltm(dir, "doctor", "--json");
      expect(json.exitCode).toBe(0);
      const hits = (JSON.parse(json.stdout) as { file: string; check: string; message: string }[]).filter(
        (f) => f.file === MQ && f.check === "broken-related",
      );
      expect(hits).toHaveLength(1);
      expect(hits[0]!.message).toContain("ZZZZZZZZZZ");
    });
  });

  test("4: outside a Bank exits 1 with openBank's line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
    try {
      const r = await ltm(dir, "doctor");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`ltm doctor: no memory-bank.yaml in ${dir} or any parent directory\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: a bad threshold exits 1 naming the key", async () => {
    await withScratch(demo, async (dir) => {
      const cfg = join(dir, "memory-bank.yaml");
      writeFileSync(cfg, `${readFileSync(cfg, "utf8")}doctor:\n  orphan_days: 0\n`);
      const r = await ltm(dir, "doctor");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(
        "ltm doctor: memory-bank.yaml: doctor.orphan_days must be an integer of 1 or more\n",
      );
    });
  });

  test("6: an invalid LTM_TODAY exits 1", async () => {
    await withScratch(demo, async (dir) => {
      const r = await run({ argv: ["doctor"], cwd: dir, env: { LTM_TODAY: "2026-13-40" } });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("ltm doctor: LTM_TODAY '2026-13-40' is not a YYYY-MM-DD date\n");
    });
  });

  test("7: an unparseable Record prints its skipped line on stderr and the exit stays 0", async () => {
    await withScratch(demo, async (dir) => {
      mkdirSync(join(dir, "_memory/decisions"), { recursive: true });
      writeFileSync(join(dir, "_memory/decisions/broken-aaaaaaaaaa.md"), "---\nid: [unclosed\n---\nbody\n");
      const r = await ltm(dir, "doctor");
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toMatch(/^ltm doctor: skipped _memory\/decisions\/broken-aaaaaaaaaa\.md: .+$/m);
    });
  });

  describe("--bank", () => {
    // resolveBankFlag reads the user config under HOME; an empty one keeps the real config out.
    const withHome = async <T>(fn: (benv: Record<string, string>) => Promise<T>) => {
      const home = mkdtempSync(join(tmpdir(), "ltm-home-"));
      try {
        return await fn({ ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    };
    const root = new URL("../..", import.meta.url).pathname;

    test("from the repo root prints what doctor prints inside the Bank", async () => {
      await withHome(async (benv) => {
        const flagged = await run({ argv: ["doctor", "--bank", "fixtures/demo-bank"], cwd: root, env: benv });
        const inside = await run({ argv: ["doctor"], cwd: demo, env: benv });
        expect(flagged.exitCode).toBe(0);
        expect(inside.stdout).not.toBe("");
        expect(flagged.stdout).toBe(inside.stdout);
      });
    });

    test("naming a dir with no memory-bank.yaml exits 1 with resolveBankFlag's message", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
      try {
        await withHome(async (benv) => {
          const r = await run({ argv: ["doctor", "--bank", dir], cwd: root, env: benv });
          expect(r.exitCode).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toContain(`ltm doctor: ${join(dir, "memory-bank.yaml")}: --bank '${dir}' is neither a Bank in `);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

const PUB = "_memory/decisions/publish-order-events-to-the-queue-aB3cD4eF5g.md";
const PUB_TEXT = `---
schema: 1
id: aB3cD4eF5g
memory_type: Decision
title: Publish order events to the message queue
status: accepted
date: 2026-04-22
summary: Order-service publishes order lifecycle events to the shared message queue instead of calling downstream services.
applies_to: [service:order-service, domain:commerce]
---

## Decision Outcome

Publish order events to the queue.
`;

const hasQmd = spawnSync("qmd", ["--version"]).status === 0;

// A stand-in qmd: `collection show` prints QMD_ROOT as the collection's Path and exits QMD_SHOW_STATUS; anything else prints QMD_OUT, then QMD_ERR to stderr, and exits QMD_STATUS.
// With QMD_LOG set, each call appends its argv, one argument per line, then a `--` line.
const FAKE_QMD = `#!/bin/sh
if [ -n "$QMD_LOG" ]; then
  for a in "$@"; do printf '%s\\n' "$a" >> "$QMD_LOG"; done
  printf -- '--\\n' >> "$QMD_LOG"
fi
if [ "$1" = collection ]; then
  printf 'Collection: %s\\n  Path:     %s\\n' "$3" "$QMD_ROOT"
  exit "\${QMD_SHOW_STATUS:-0}"
fi
printf '%s' "$QMD_OUT"
if [ -n "$QMD_ERR" ]; then printf '%s\\n' "$QMD_ERR" >&2; fi
exit "\${QMD_STATUS:-0}"
`;

describe("ltm doctor with recall:", () => {
  const recallLine = (mode: string) => `recall: { backend: qmd, mode: ${mode}, collections: { Decision: decisions } }`;
  const setup = (dir: string, mode = "search") => {
    const cfg = join(dir, "memory-bank.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\n${recallLine(mode)}\n`);
    writeFileSync(join(dir, PUB), PUB_TEXT);
  };
  const withFake = async (fn: (bin: string) => Promise<void>) => {
    const bin = mkdtempSync(join(tmpdir(), "ltm-fakeqmd-"));
    try {
      writeFileSync(join(bin, "qmd"), FAKE_QMD);
      chmodSync(join(bin, "qmd"), 0o755);
      await fn(bin);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  };

  for (const mode of ["query", "vsearch"]) {
    test(`mode: ${mode} exits 1 naming the value, with nothing on stdout`, async () => {
      await withScratch(demo, async (dir) => {
        setup(dir, mode);
        const r = await ltm(dir, "doctor");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe(`ltm doctor: memory-bank.yaml: recall.mode must be search or vector, not "${mode}"\n`);
      });
    });
  }

  test("a fake qmd's 0.97 hit surfaces as a near-duplicate", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const out = JSON.stringify([{ file: "qmd://decisions/publish-order-events-to-the-queue-aB3cD4eF5g.md", score: 0.97 }]);
        const r = await run({ argv: ["doctor"], cwd: dir, env: { ...env, PATH: bin, QMD_OUT: out, QMD_ROOT: join(dir, "_memory/decisions") } });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain(`${MQ}: near-duplicate: scores 0.97 against ${PUB} (threshold 0.85)\n`);
      });
    });
  });

  const fakeRun = (dir: string, bin: string, vars: Record<string, string>, ...argv: string[]) =>
    run({ argv: ["doctor", ...argv], cwd: dir, env: { ...env, PATH: bin, QMD_ROOT: join(dir, "_memory/decisions"), ...vars } });
  const hit = JSON.stringify([{ file: "qmd://decisions/publish-order-events-to-the-queue-aB3cD4eF5g.md", score: 0.97 }]);

  test("a qmd failure during search exits 1 with stderr and nothing on stdout", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const r = await fakeRun(dir, bin, { QMD_STATUS: "1", QMD_ERR: "index is locked" });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("ltm doctor: qmd search failed: index is locked\n");
      });
    });
  });

  test("a qmd stderr line on a good search goes to stderr, and --json stdout still parses", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const r = await fakeRun(dir, bin, { QMD_OUT: hit, QMD_ERR: "9 documents need embeddings" }, "--json");
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toBe("ltm doctor: qmd: 9 documents need embeddings\n");
        expect((JSON.parse(r.stdout) as { check: string }[]).some((f) => f.check === "near-duplicate")).toBe(true);
      });
    });
  });

  test("qmd is asked to search the title's tokens, with --json --all, in the type's collection", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const log = join(bin, "argv.log");
        await fakeRun(dir, bin, { QMD_OUT: "[]", QMD_LOG: log });
        const calls = readFileSync(log, "utf8");
        expect(calls).toContain("collection\nshow\ndecisions\n--\n");
        expect(calls).toContain("search\nadopt a message queue for order events\n--json\n--all\n-c\ndecisions\n--\n");
      });
    });
  });

  test("a collection whose Path is gone exits 1 naming it", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const gone = join(dir, "no-such-dir");
        const r = await fakeRun(dir, bin, { QMD_ROOT: gone });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe(`ltm doctor: recall.collections.Decision: qmd collection 'decisions' points at ${gone}, which does not exist\n`);
      });
    });
  });

  test("a missing collection exits 1 naming it", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const r = await run({ argv: ["doctor"], cwd: dir, env: { ...env, PATH: bin, QMD_SHOW_STATUS: "1", QMD_ROOT: join(dir, "_memory/decisions") } });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("ltm doctor: recall.collections.Decision: qmd has no collection 'decisions'\n");
      });
    });
  });

  test("no qmd on PATH exits 1", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      const empty = mkdtempSync(join(tmpdir(), "ltm-noqmd-"));
      try {
        const r = await run({ argv: ["doctor"], cwd: dir, env: { ...env, PATH: empty } });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toBe("ltm doctor: qmd not found on PATH\n");
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  const realQmd = async (pubText: string, check: (a: string, b: string) => void) => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      writeFileSync(join(dir, PUB), pubText);
      const xdg = mkdtempSync(join(tmpdir(), "ltm-xdg-"));
      try {
        // Own XDG dirs keep qmd off the user's real index.
        const qenv = {
          PATH: process.env.PATH,
          XDG_CACHE_HOME: join(xdg, "cache"),
          XDG_CONFIG_HOME: join(xdg, "config"),
          LTM_TODAY: env.LTM_TODAY,
        };
        const add = spawnSync("qmd", ["collection", "add", join(dir, "_memory/decisions"), "--name", "decisions"], {
          encoding: "utf8",
          env: qenv,
        });
        expect(add.status).toBe(0);
        const a = await run({ argv: ["doctor"], cwd: dir, env: qenv });
        const b = await run({ argv: ["doctor"], cwd: dir, env: qenv });
        expect(a.exitCode).toBe(0);
        expect(b.exitCode).toBe(0);
        check(a.stdout, b.stdout);
      } finally {
        rmSync(xdg, { recursive: true, force: true });
      }
    });
  };
  const oneDupe = (stdout: string) => {
    const dupes = stdout.split("\n").filter((l) => l.includes(": near-duplicate: "));
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toStartWith(`${MQ}: near-duplicate: `);
    expect(dupes[0]).toMatch(/scores 0\.\d+ against .* \(threshold 0\.85\)$/);
  };

  test.skipIf(!hasQmd)("real qmd (skipped when qmd is not installed): reports one near-duplicate, the same on a rerun", async () => {
    await realQmd(PUB_TEXT, (a, b) => {
      oneDupe(a);
      expect(b).toBe(a);
    });
  }, 60000);

  // Because qmd search ANDs every query word, a summary query lost this pair once one summary word changed. A title query keeps it.
  test.skipIf(!hasQmd)("real qmd (skipped when qmd is not installed): still pairs when PUB's summary says common, not shared", async () => {
    const common = PUB_TEXT.replace("the shared message queue", "the common message queue");
    expect(common).not.toBe(PUB_TEXT);
    await realQmd(common, (a) => {
      oneDupe(a);
      expect(a).toContain(` against ${PUB} (threshold 0.85)\n`);
    });
  }, 60000);
});

describe("ltm doctor with recall: mode vector", () => {
  const fakePkg = fileURLToPath(new URL("../fixtures/fake-qmd-package", import.meta.url));
  // The fake's `skills path` points at the fake package; the worker reads its vectors and status from env.
  const VEC_QMD = `#!/bin/sh
if [ "$1" = skills ]; then printf '%s/skills\\n' "$FAKE_PKG"; exit 0; fi
if [ "$1" = collection ]; then printf 'Collection: %s\\n  Path:     %s\\n' "$3" "$FAKE_ROOT"; exit 0; fi
exit 1
`;
  const MQ_QUERY =
    "Adopt a message queue for order events. Order-service publishes order lifecycle events to the shared message queue instead of calling downstream services directly.";
  const vec = (score: number) => JSON.stringify({ decisions: { [MQ_QUERY]: [{ filepath: "qmd://decisions/publish-order-events-to-the-queue-aB3cD4eF5g.md", score }] } });

  const withVector = async (
    yaml: string,
    vars: Record<string, string>,
    fn: (r: Awaited<ReturnType<typeof run>>) => void,
    ...argv: string[]
  ) => {
    await withScratch(demo, async (dir) => {
      const cfg = join(dir, "memory-bank.yaml");
      writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\n${yaml}\n`);
      writeFileSync(join(dir, PUB), PUB_TEXT);
      const bin = mkdtempSync(join(tmpdir(), "ltm-fakeqmd-"));
      try {
        writeFileSync(join(bin, "qmd"), VEC_QMD);
        chmodSync(join(bin, "qmd"), 0o755);
        const venv = {
          ...env,
          PATH: bin,
          FAKE_PKG: fakePkg,
          FAKE_ROOT: join(dir, "_memory/decisions"),
          FAKE_STATUS: JSON.stringify({ decisions: { active: 9, pending: 0 } }),
          // Keeps the worker off the user's ~/.config/qmd, whose embed model would replace the fake's.
          XDG_CONFIG_HOME: join(bin, "config"),
          ...vars,
        };
        fn(await run({ argv: ["doctor", ...argv], cwd: dir, env: venv }));
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  };
  const RECALL = "recall: { backend: qmd, mode: vector, collections: { Decision: decisions } }";
  const WITH_THRESHOLD = `doctor: { near_duplicate_threshold: 0.6 }\n${RECALL}`;

  test("a 0.62 hit surfaces as a near-duplicate ending in the configured threshold", async () => {
    await withVector(WITH_THRESHOLD, { FAKE_VEC: vec(0.62) }, (r) => {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`${MQ}: near-duplicate: scores 0.62 against ${PUB} (threshold 0.6)\n`);
      expect(r.stdout.split("\n").filter((l) => l.includes(": near-duplicate: "))).toHaveLength(1);
    });
  });

  test("no threshold exits 1 with the config message", async () => {
    await withVector(RECALL, {}, (r) => {
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("ltm doctor: memory-bank.yaml: doctor.near_duplicate_threshold is required when recall.mode is vector\n");
    });
  });

  test("every document pending exits 1 naming qmd embed, nothing on stdout", async () => {
    await withVector(WITH_THRESHOLD, { FAKE_STATUS: JSON.stringify({ decisions: { active: 9, pending: 9 } }) }, (r) => {
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("run qmd embed");
    });
  });

  test("2 of 9 pending warns on stderr, exits 0, and --json stdout still parses", async () => {
    await withVector(WITH_THRESHOLD, { FAKE_VEC: vec(0.62), FAKE_STATUS: JSON.stringify({ decisions: { active: 9, pending: 2 } }) }, (r) => {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("ltm doctor: qmd: collection 'decisions': 2 of 9 documents need embedding; run qmd embed\n");
      expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
    }, "--json");
  });

  // qmd's CLI adopts a .qmd/ config above its cwd, with the index beside it, so `qmd embed` there fills that index, not the global one.
  // Spawned, since qmd and the worker see ltm's process cwd, which an in-process run() leaves at the repo.
  const withLocalConfig = async (vars: Record<string, string> | ((local: string) => Record<string, string>), fn: (r: SpawnSyncReturns<string>, stores: string[], local: string) => void) => {
    await withScratch(demo, async (dir) => {
      const cfg = join(dir, "memory-bank.yaml");
      writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\n${WITH_THRESHOLD}\n`);
      writeFileSync(join(dir, PUB), PUB_TEXT);
      mkdirSync(join(dir, ".qmd"));
      writeFileSync(join(dir, ".qmd/index.yml"), "models:\n  embed: hf:local/embed.gguf\n");
      const bin = mkdtempSync(join(tmpdir(), "ltm-fakeqmd-"));
      try {
        writeFileSync(join(bin, "qmd"), VEC_QMD);
        chmodSync(join(bin, "qmd"), 0o755);
        const log = join(bin, "fake.log");
        const r = spawnSync(process.execPath, [fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url)), "doctor"], {
          cwd: join(dir, "_memory"),
          encoding: "utf8",
          env: {
            ...env,
            PATH: `${bin}:${dirname(process.execPath)}`,
            FAKE_PKG: fakePkg,
            FAKE_ROOT: join(dir, "_memory/decisions"),
            FAKE_VEC: vec(0.62),
            FAKE_STATUS: JSON.stringify({ decisions: { active: 9, pending: 0, model: "hf:local/embed.gguf" } }),
            FAKE_LOG: log,
            XDG_CONFIG_HOME: join(bin, "config"),
            ...(typeof vars === "function" ? vars(join(realpathSync(dir), ".qmd")) : vars),
          },
        });
        const stores = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("createStore ")) : [];
        fn(r, stores, join(realpathSync(dir), ".qmd"));
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  };

  // QMD_TRUST_LOCAL_CONFIG is qmd's unattended opt-in for a checked-in config's custom models.
  test("a trusted project-local .qmd/ config above the cwd supplies the index and the embed model", async () => {
    await withLocalConfig({ QMD_TRUST_LOCAL_CONFIG: "1" }, (r, stores, local) => {
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`${MQ}: near-duplicate: scores 0.62 against ${PUB} (threshold 0.6)\n`);
      expect(stores.length).toBeGreaterThan(0);
      for (const line of stores) expect(line).toBe(`createStore ${local}/index.sqlite ${local}/index.yml`);
    });
  });

  test("qmd's recorded trust in a project-local config lets its embed model through", async () => {
    const trusted = (local: string) => ({ FAKE_TRUSTED: JSON.stringify({ [`${local}/index.yml`]: JSON.stringify({ embed: "hf:local/embed.gguf" }) }) });
    await withLocalConfig(trusted, (r, stores, local) => {
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      for (const line of stores) expect(line).toBe(`createStore ${local}/index.sqlite ${local}/index.yml`);
    });
  });

  // A cloned repo's .qmd/ can name any model file; qmd's CLI loads its own defaults until you trust the config (qmd #889).
  test("an untrusted project-local config's custom embed model never reaches the store", async () => {
    await withLocalConfig({}, (r, stores, local) => {
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("has no embeddings for qmd's current embedding model");
      expect(stores.length).toBeGreaterThan(0);
      for (const line of stores) expect(line).toBe(`createStore ${local}/index.sqlite inline`);
    });
  });

  test("a model that can't embed a query exits 1 naming the model, not a clean run", async () => {
    await withVector(WITH_THRESHOLD, { FAKE_VEC: vec(0.62), FAKE_UNLOADABLE: "fake-embed-model" }, (r) => {
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe('ltm doctor: qmd vector search failed: qmd could not embed a query with model fake-embed-model: No model file found at "fake-embed-model"\n');
    });
  });

  test("mode: vsearch exits 1 saying search or vector", async () => {
    await withVector("recall: { backend: qmd, mode: vsearch, collections: { Decision: decisions } }", {}, (r) => {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("must be search or vector");
    });
  });

  // Opt-in: the embedding model is ~300 MB, so no default run downloads it.
  const models = process.env.LTM_TEST_QMD_MODELS;
  const decide = (id: string, title: string, summary: string) =>
    `---\nschema: 1\nid: ${id}\nmemory_type: Decision\ntitle: ${title}\nstatus: accepted\ndate: 2026-04-22\nsummary: ${summary}\napplies_to: [service:order-service]\n---\n\n## Decision Outcome\n\n${title}.\n`;
  const writePair = (dir: string) => {
    writeFileSync(join(dir, "_memory/decisions/use-postgres-pGa1b2c3d4.md"), decide("pGa1b2c3d4", "Use Postgres", "Order data lives in Postgres for ACID guarantees."));
    writeFileSync(join(dir, "_memory/decisions/relational-stores-rSq5e6f7g8.md"), decide("rSq5e6f7g8", "Relational stores run on PostgreSQL", "Order data is kept in PostgreSQL for ACID guarantees."));
  };
  const pair = (out: string) => out.includes("near-duplicate") && out.includes("use-postgres") && out.includes("relational-stores");
  test.skipIf(!hasQmd || !models)(
    "real qmd embeddings (needs qmd and LTM_TEST_QMD_MODELS): vector pairs paraphrased Decisions, search does not, a changed model demands qmd embed",
    async () => {
      await withScratch(demo, async (dir) => {
        writePair(dir);
        const xdg = mkdtempSync(join(tmpdir(), "ltm-xdg-"));
        try {
          mkdirSync(join(xdg, "cache/qmd"), { recursive: true });
          symlinkSync(join(models!, "models"), join(xdg, "cache/qmd/models"));
          const qenv = { PATH: process.env.PATH, XDG_CACHE_HOME: join(xdg, "cache"), XDG_CONFIG_HOME: join(xdg, "config"), LTM_TODAY: env.LTM_TODAY };
          const qmd = (...a: string[]) => spawnSync("qmd", a, { encoding: "utf8", env: qenv });
          expect(qmd("collection", "add", join(dir, "_memory/decisions"), "--name", "decisions").status).toBe(0);
          expect(qmd("embed").status).toBe(0);
          const cfg = join(dir, "memory-bank.yaml");
          const base = readFileSync(cfg, "utf8").trimEnd();
          const setMode = (mode: string) => writeFileSync(cfg, `${base}\ndoctor: { near_duplicate_threshold: 0.5 }\nrecall: { backend: qmd, mode: ${mode}, collections: { Decision: decisions } }\n`);
          setMode("vector");
          const vector = await run({ argv: ["doctor"], cwd: dir, env: qenv });
          expect(vector.exitCode).toBe(0);
          expect(pair(vector.stdout)).toBe(true);
          setMode("search");
          const search = await run({ argv: ["doctor"], cwd: dir, env: qenv });
          expect(pair(search.stdout)).toBe(false);
          setMode("vector");
          // Byte-identical to use-postgres, so qmd stores one hash for two documents. Once the model changes, 11 hashes cover 12 documents
          // and all 11 need embedding: a distinct-hash count calls that "no embeddings", a document count would only warn.
          // Added after the search step, whose own near-duplicate of the copy would satisfy pair().
          writeFileSync(join(dir, "_memory/decisions/pg-copy.md"), readFileSync(join(dir, "_memory/decisions/use-postgres-pGa1b2c3d4.md")));
          expect(qmd("update").status).toBe(0);
          // qmd's CLI writes its model into its config, and the config outranks QMD_EMBED_MODEL, so change the model there.
          const qmdCfg = join(xdg, "config/qmd/index.yml");
          const yml = readFileSync(qmdCfg, "utf8");
          expect(yml).toMatch(/^\s+embed: \S+$/m);
          writeFileSync(qmdCfg, yml.replace(/^(\s+embed: )\S+$/m, "$1hf:example/other-model.gguf"));
          const other = await run({ argv: ["doctor"], cwd: dir, env: qenv });
          expect(other.exitCode).toBe(1);
          expect(other.stderr).toContain("run qmd embed");
          expect(other.stderr).toContain("has no embeddings");
        } finally {
          rmSync(xdg, { recursive: true, force: true });
        }
      });
    },
    300000,
  );

  // qmd's CLI keeps a project-local config's index in .qmd/ beside it, so the worker has to read that index, not the global one.
  test.skipIf(!hasQmd || !models)(
    "real qmd embeddings (needs qmd and LTM_TEST_QMD_MODELS): with qmd init's project-local index, vector pairs paraphrased Decisions",
    async () => {
      await withScratch(demo, async (dir) => {
        writePair(dir);
        const xdg = mkdtempSync(join(tmpdir(), "ltm-xdg-"));
        try {
          mkdirSync(join(xdg, "cache/qmd"), { recursive: true });
          symlinkSync(join(models!, "models"), join(xdg, "cache/qmd/models"));
          const qenv = { PATH: process.env.PATH, XDG_CACHE_HOME: join(xdg, "cache"), XDG_CONFIG_HOME: join(xdg, "config"), LTM_TODAY: env.LTM_TODAY };
          const qmd = (...a: string[]) => spawnSync("qmd", a, { cwd: dir, encoding: "utf8", env: qenv });
          expect(qmd("init").status).toBe(0);
          expect(qmd("collection", "add", join(dir, "_memory/decisions"), "--name", "decisions").status).toBe(0);
          expect(qmd("embed").status).toBe(0);
          const cfg = join(dir, "memory-bank.yaml");
          writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\ndoctor: { near_duplicate_threshold: 0.5 }\nrecall: { backend: qmd, mode: vector, collections: { Decision: decisions } }\n`);
          // Spawned, since qmd and the worker find .qmd/ from ltm's process cwd, which an in-process run() leaves at the repo.
          const r = spawnSync(process.execPath, [fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url)), "doctor"], { cwd: dir, encoding: "utf8", env: qenv });
          expect(r.stderr).toBe("");
          expect(r.status).toBe(0);
          expect(pair(r.stdout)).toBe(true);
          expect(existsSync(join(xdg, "cache/qmd/index.sqlite"))).toBe(false);
        } finally {
          rmSync(xdg, { recursive: true, force: true });
        }
      });
    },
    300000,
  );

  // A checked-in .qmd/ can name any model file. The custom model here is a symlink to the downloaded default, so nothing fetches.
  test.skipIf(!hasQmd || !models)(
    "real qmd embeddings (needs qmd and LTM_TEST_QMD_MODELS): a project-local custom embed model loads only once trusted, and one that can't load exits 1",
    async () => {
      await withScratch(demo, async (dir) => {
        writePair(dir);
        const xdg = mkdtempSync(join(tmpdir(), "ltm-xdg-"));
        try {
          mkdirSync(join(xdg, "cache/qmd"), { recursive: true });
          symlinkSync(join(models!, "models"), join(xdg, "cache/qmd/models"));
          const custom = join(xdg, "custom.gguf");
          symlinkSync(join(models!, "models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"), custom);
          const qenv = { PATH: process.env.PATH, XDG_CACHE_HOME: join(xdg, "cache"), XDG_CONFIG_HOME: join(xdg, "config"), LTM_TODAY: env.LTM_TODAY };
          const optIn = { ...qenv, QMD_TRUST_LOCAL_CONFIG: "1" };
          const qmd = (e: Record<string, string | undefined>, ...a: string[]) => spawnSync("qmd", a, { cwd: dir, encoding: "utf8", env: e });
          expect(qmd(qenv, "init").status).toBe(0);
          expect(qmd(qenv, "collection", "add", join(dir, "_memory/decisions"), "--name", "decisions").status).toBe(0);
          const qmdCfg = join(dir, ".qmd/index.yml");
          writeFileSync(qmdCfg, readFileSync(qmdCfg, "utf8").replace(/^(\s+embed: )\S+$/m, `$1${custom}`));
          expect(qmd(optIn, "embed").status).toBe(0);
          const cfg = join(dir, "memory-bank.yaml");
          writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\ndoctor: { near_duplicate_threshold: 0.5 }\nrecall: { backend: qmd, mode: vector, collections: { Decision: decisions } }\n`);
          const doctor = (e: Record<string, string | undefined>) =>
            spawnSync(process.execPath, [fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url)), "doctor"], { cwd: dir, encoding: "utf8", env: e });
          // Untrusted, qmd's defaults apply, and the index holds vectors only for the custom model.
          const untrusted = doctor(qenv);
          expect(untrusted.status).toBe(1);
          expect(untrusted.stderr).toContain("has no embeddings for qmd's current embedding model");
          const trusted = doctor(optIn);
          expect(trusted.stderr).toBe("");
          expect(trusted.status).toBe(0);
          expect(pair(trusted.stdout)).toBe(true);
          // qmd trust records a digest; matching it means the worker re-derived qmd's trust check, not only the env opt-in.
          expect(qmd(qenv, "trust").status).toBe(0);
          expect(pair(doctor(qenv).stdout)).toBe(true);
          rmSync(custom);
          const gone = doctor(optIn);
          expect(gone.status).toBe(1);
          expect(gone.stdout).toBe("");
          expect(gone.stderr).toBe(`ltm doctor: qmd vector search failed: qmd could not embed a query with model ${custom}: No model file found at "${custom}"\n`);
        } finally {
          rmSync(xdg, { recursive: true, force: true });
        }
      });
    },
    300000,
  );
});
