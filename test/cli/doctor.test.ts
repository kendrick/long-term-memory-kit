import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
