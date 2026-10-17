import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { splitFrontmatter } from "../../src/core/record.ts";
import { noBankLine } from "../../src/cli/bank.ts";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const TODAY = "2026-10-09";
const accept = (cwd: string, id: string, env: Record<string, string> = { LTM_TODAY: TODAY }) =>
  run({ argv: ["accept", id], cwd, env });

const P = "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md";
const H = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";
const K = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";

// Every file in the Bank, not just the Records the command should touch, so a stray write anywhere shows.
function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    out[path.slice(dir.length + 1)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const fm = (dir: string, rel: string): Record<string, unknown> =>
  parse(splitFrontmatter(readFileSync(join(dir, rel), "utf8"))!.frontmatterLines.join("\n"));

// Fails loudly when `from` is absent, so fixture drift can't turn a case into a no-op.
function patch(dir: string, rel: string, from: string, to: string): void {
  const path = join(dir, rel);
  const text = readFileSync(path, "utf8");
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
}

const validate = (dir: string) => run({ argv: ["validate"], cwd: dir, env: {} });

describe("ltm accept", () => {
  test("accepts the proposed Decision, stamps status and date, and leaves the Bank valid", async () => {
    await withScratch(demo, async (dir) => {
      const r = await accept(dir, "pL2sG4nVq0");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${P}\n`);
      const data = fm(dir, P);
      expect(data.status).toBe("accepted");
      expect(String(data.date)).toBe(TODAY);
      expect((await validate(dir)).exitCode).toBe(0);
    });
  });

  test("last_confirmed in the past moves up to today", async () => {
    await withScratch(demo, async (dir) => {
      patch(dir, P, "status: proposed\n", "status: proposed\nlast_confirmed: 2026-01-01\n");
      expect((await accept(dir, "pL2sG4nVq0")).exitCode).toBe(0);
      const data = fm(dir, P);
      expect(String(data.last_confirmed)).toBe(TODAY);
      expect(String(data.date)).toBe(TODAY);
    });
  });

  test("last_confirmed in the future stays put", async () => {
    await withScratch(demo, async (dir) => {
      patch(dir, P, "status: proposed\n", "status: proposed\nlast_confirmed: 2026-12-31\n");
      expect((await accept(dir, "pL2sG4nVq0")).exitCode).toBe(0);
      const data = fm(dir, P);
      expect(String(data.last_confirmed)).toBe("2026-12-31");
      expect(String(data.date)).toBe(TODAY);
    });
  });

  test("a non-empty supersedes list supersedes its target", async () => {
    await withScratch(demo, async (dir) => {
      patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce]\nsupersedes: [hT5cY8dUa6]");
      const r = await accept(dir, "pL2sG4nVq0");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual([H, P].sort());
      expect(fm(dir, H).status).toBe("superseded");
      expect(fm(dir, H).superseded_by).toBe("pL2sG4nVq0");
      expect(fm(dir, P).status).toBe("accepted");
      expect(fm(dir, P).supersedes).toEqual(["hT5cY8dUa6"]);
      expect((await validate(dir)).exitCode).toBe(0);
    });
  });

  test("an empty supersedes list leaves the shared-Facet Record untouched", async () => {
    await withScratch(demo, async (dir) => {
      patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce]\nsupersedes: []");
      const before = readFileSync(join(dir, H), "utf8");
      const r = await accept(dir, "pL2sG4nVq0");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${P}\n`);
      expect(readFileSync(join(dir, H), "utf8")).toBe(before);
      expect(fm(dir, P).status).toBe("accepted");
    });
  });

  test("refuses an already accepted Record and changes nothing", async () => {
    await withScratch(demo, async (dir) => {
      const before = hashes(dir);
      const r = await accept(dir, "kQ7vN2xLp4");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`ltm accept: ${K} has status 'accepted', not 'proposed'\n`);
      expect(hashes(dir)).toEqual(before);
    });
  });

  test("a supersedes list with one valid id and one missing id refuses and changes nothing", async () => {
    await withScratch(demo, async (dir) => {
      patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce]\nsupersedes: [hT5cY8dUa6, NoSuchId00]");
      const before = hashes(dir);
      const r = await accept(dir, "pL2sG4nVq0");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("ltm accept: 'NoSuchId00' matches no Record\n");
      expect(hashes(dir)).toEqual(before);
    });
  });

  test("a malformed LTM_TODAY refuses before anything else and changes nothing", async () => {
    await withScratch(demo, async (dir) => {
      const before = hashes(dir);
      const r = await accept(dir, "pL2sG4nVq0", { LTM_TODAY: "2026-13-40" });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("ltm accept: LTM_TODAY '2026-13-40' is not a YYYY-MM-DD date\n");
      expect(hashes(dir)).toEqual(before);
    });
  });

  test("an unknown id refuses and changes nothing", async () => {
    await withScratch(demo, async (dir) => {
      const before = hashes(dir);
      const r = await accept(dir, "NoSuchId00");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("ltm accept: 'NoSuchId00' matches no Record\n");
      expect(hashes(dir)).toEqual(before);
    });
  });

  test("outside a Bank it exits 1 with the no-Bank line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
    try {
      const r = await accept(dir, "pL2sG4nVq0");
      expect(r).toEqual({ exitCode: 1, stdout: "", stderr: noBankLine("accept", dir) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write that fails on the first file reports that nothing landed", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    await withScratch(demo, async (dir) => {
      patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce]\nsupersedes: [hT5cY8dUa6]");
      // H sorts before P, so H is staged first and its failure stops the run before P is touched.
      chmodSync(join(dir, H), 0o444);
      try {
        const before = hashes(dir);
        const r = await accept(dir, "pL2sG4nVq0");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(new RegExp(`^ltm accept: wrote nothing, then failed on ${H.replace(/[.]/g, "\\.")}: .+\\n$`));
        expect(hashes(dir)).toEqual(before);
      } finally {
        chmodSync(join(dir, H), 0o644);
      }
    });
  });

  test("a write that fails on the second file rolls back the first and reports that nothing landed", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    await withScratch(demo, async (dir) => {
      patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce]\nsupersedes: [hT5cY8dUa6]");
      // H sorts before P, so H is staged first and the read-only P fails second: without rollback, H would retire alone.
      chmodSync(join(dir, P), 0o444);
      try {
        const before = hashes(dir);
        const r = await accept(dir, "pL2sG4nVq0");
        const esc = (s: string) => s.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(new RegExp(`^ltm accept: wrote nothing, then failed on ${esc(P)}: .+\\n$`));
        expect(hashes(dir)).toEqual(before);
      } finally {
        chmodSync(join(dir, P), 0o644);
      }
    });
  });

  describe("a skipped file makes the command refuse, since it could hide an id holder or an edge", () => {
    const BROKEN = "_memory/decisions/broken-pL2sG4nVq0.md";

    test("an unparseable Record that would duplicate the Proposal's id", async () => {
      await withScratch(demo, async (dir) => {
        writeFileSync(join(dir, BROKEN), "---\nid: pL2sG4nVq0\ntitle: [unclosed\n---\nbody\n");
        const before = hashes(dir);
        const r = await accept(dir, "pL2sG4nVq0");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain(`ltm accept: skipped ${BROKEN}: `);
        expect(r.stderr.endsWith("ltm accept: 1 file skipped, so nothing was written\n")).toBe(true);
        expect(hashes(dir)).toEqual(before);
      });
    });

    test("an unreadable Record", async () => {
      if (process.getuid?.() === 0) return; // root ignores file modes
      await withScratch(demo, async (dir) => {
        writeFileSync(join(dir, BROKEN), readFileSync(join(dir, P), "utf8"));
        const before = hashes(dir);
        chmodSync(join(dir, BROKEN), 0o000);
        try {
          const r = await accept(dir, "pL2sG4nVq0");
          expect(r.exitCode).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toContain(`ltm accept: skipped ${BROKEN}: `);
          expect(r.stderr.endsWith("ltm accept: 1 file skipped, so nothing was written\n")).toBe(true);
        } finally {
          chmodSync(join(dir, BROKEN), 0o644);
        }
        expect(hashes(dir)).toEqual(before);
      });
    });
  });
});
