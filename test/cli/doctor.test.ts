import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

// A stand-in qmd: `collection show` exits QMD_SHOW_STATUS; anything else prints QMD_OUT.
const FAKE_QMD = `#!/bin/sh
if [ "$1" = collection ]; then exit "\${QMD_SHOW_STATUS:-0}"; fi
printf '%s' "$QMD_OUT"
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

  test("mode: query exits 1 naming the value, with nothing on stdout", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir, "query");
      const r = await ltm(dir, "doctor");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe('ltm doctor: memory-bank.yaml: recall.mode must be search or vsearch, not "query"\n');
    });
  });

  test("a fake qmd's 0.97 hit surfaces as a near-duplicate", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const out = JSON.stringify([{ file: "qmd://decisions/publish-order-events-to-the-queue-aB3cD4eF5g.md", score: 0.97 }]);
        const r = await run({ argv: ["doctor"], cwd: dir, env: { ...env, PATH: bin, QMD_OUT: out } });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain(`${MQ}: near-duplicate: scores 0.97 against ${PUB} (threshold 0.85)\n`);
      });
    });
  });

  test("a missing collection exits 1 naming it", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
      await withFake(async (bin) => {
        const r = await run({ argv: ["doctor"], cwd: dir, env: { ...env, PATH: bin, QMD_SHOW_STATUS: "1" } });
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

  test.skipIf(!hasQmd)("real qmd (skipped when qmd is not installed): reports one near-duplicate, the same on a rerun", async () => {
    await withScratch(demo, async (dir) => {
      setup(dir);
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
        const dupes = a.stdout.split("\n").filter((l) => l.includes(": near-duplicate: "));
        expect(dupes).toHaveLength(1);
        expect(dupes[0]).toStartWith(`${MQ}: near-duplicate: `);
        expect(dupes[0]).toMatch(/scores 0\.\d+ against .* \(threshold 0\.85\)$/);
        expect(b.stdout).toBe(a.stdout);
      } finally {
        rmSync(xdg, { recursive: true, force: true });
      }
    });
  }, 60000);
});
