import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { noBankLine } from "../../src/cli/bank.ts";
import { defaultCommands } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/run.ts";
import { splitFrontmatter } from "../../src/core/record.ts";
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

const H = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";
const K = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const M = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";
const P = "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md";

function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[relative(dir, abs)] = createHash("sha256").update(readFileSync(abs)).digest("hex");
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const sup = (cwd: string, ...ids: string[]) => run({ argv: ["supersede", ...ids], cwd, env: {} });
const validate = (cwd: string) => run({ argv: ["validate"], cwd, env: {} });
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
const body = (text: string) => splitFrontmatter(text)!.body;

function patch(dir: string, rel: string, from: string, to: string): void {
  const text = read(dir, rel);
  expect(text).toContain(from);
  writeFileSync(join(dir, rel), text.replace(from, to));
}

async function refuses(setup: (dir: string) => void, ids: [string, string], message: (dir: string) => string) {
  await withScratch(demoBank, async (dir) => {
    setup(dir);
    const before = hashes(dir);
    const r = await sup(dir, ...ids);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`ltm supersede: ${message(dir)}\n`);
    expect(hashes(dir)).toEqual(before);
  });
}

describe("ltm supersede", () => {
  test("is no longer a hidden stub", () => {
    expect(defaultCommands.find((c) => c.name === "supersede")?.hidden).toBeUndefined();
  });

  test("sets all three fields, prints both paths, and leaves the Bank valid", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4");
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe(`${H}\n${K}\n`);
      const h = read(dir, H);
      const k = read(dir, K);
      expect(h).toMatch(/^status: superseded$/m);
      expect(h).toMatch(/^superseded_by: kQ7vN2xLp4$/m);
      expect(k).toMatch(/^supersedes: \[mB3tR9wZe1, hT5cY8dUa6\]$/m);
      expect((await validate(dir)).exitCode).toBe(0);
    });
  });

  test("leaves the bytes after the closing fence of both Records unchanged", async () => {
    await withScratch(demoBank, async (dir) => {
      const before = { h: body(read(dir, H)), k: body(read(dir, K)) };
      expect((await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4")).exitCode).toBe(0);
      expect(body(read(dir, H))).toBe(before.h);
      expect(body(read(dir, K))).toBe(before.k);
    });
  });

  test("a second identical run exits 0, prints nothing, and changes no file", async () => {
    await withScratch(demoBank, async (dir) => {
      expect((await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4")).exitCode).toBe(0);
      const before = hashes(dir);
      const r = await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4");
      expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(hashes(dir)).toEqual(before);
    });
  });

  describe("refusals leave every file in the Bank byte-identical", () => {
    test("1: old and new are the same Record", () =>
      refuses(() => {}, ["hT5cY8dUa6", "hT5cY8dUa6"], () => "old and new are the same Record ('hT5cY8dUa6')"));

    test("2: an id that matches no Record, old first", async () => {
      await refuses(() => {}, ["NoSuchId00", "AlsoNone00"], () => "'NoSuchId00' matches no Record");
      await refuses(() => {}, ["hT5cY8dUa6", "NoSuchId00"], () => "'NoSuchId00' matches no Record");
    });

    test("3: an id held by more than one Record", () =>
      refuses(
        (dir) => writeFileSync(join(dir, "_memory/decisions/adopt-message-queue-copy-hT5cY8dUa6.md"), read(dir, H)),
        ["hT5cY8dUa6", "kQ7vN2xLp4"],
        () => "'hT5cY8dUa6' is held by 2 Records",
      ));

    test("4: the old Record is already superseded by another id", () =>
      refuses(
        (dir) => patch(dir, H, "status: accepted\n", "status: superseded\nsuperseded_by: rX6jK1fWc9\n"),
        ["hT5cY8dUa6", "kQ7vN2xLp4"],
        () => `${H} is already superseded by 'rX6jK1fWc9'`,
      ));

    test("5: the new Record is itself superseded", async () => {
      await refuses(() => {}, ["hT5cY8dUa6", "mB3tR9wZe1"], () => `${M} is itself superseded`);
      await refuses(
        (dir) => patch(dir, K, "status: accepted\n", "status: accepted\nsuperseded_by: rX6jK1fWc9\n"),
        ["hT5cY8dUa6", "kQ7vN2xLp4"],
        () => `${K} is itself superseded`,
      );
    });

    test("5b: the new Record is not accepted", () =>
      refuses(
        // Share a Facet with H so the scope refusal can't answer first.
        (dir) => patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce]"),
        ["hT5cY8dUa6", "pL2sG4nVq0"],
        () => `${P} has status 'proposed', not 'accepted'`,
      ));

    test("6: the old Record already reaches the new one through supersedes", () =>
      refuses(
        (dir) => patch(dir, H, "status: accepted\n", "status: accepted\nsupersedes: [kQ7vN2xLp4]\n"),
        ["hT5cY8dUa6", "kQ7vN2xLp4"],
        () => `superseding ${H} with ${K} would make a cycle`,
      ));

    test("7: the two Records share no applies_to entry", () =>
      refuses(
        (dir) => patch(dir, K, "applies_to: [domain:commerce, system:data-platform]", "applies_to: [system:data-platform]"),
        ["hT5cY8dUa6", "kQ7vN2xLp4"],
        () => `${H} and ${K} share no applies_to entry`,
      ));

    test("8: the new Record's supersedes is not a list of ids", () =>
      refuses(
        (dir) => patch(dir, K, "supersedes: [mB3tR9wZe1]", "supersedes: mB3tR9wZe1"),
        ["hT5cY8dUa6", "kQ7vN2xLp4"],
        () => `${K}: supersedes is not a list of ids`,
      ));
  });

  test("a write failure on the second file rolls back the first and reports that nothing landed", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    await withScratch(demoBank, async (dir) => {
      chmodSync(join(dir, K), 0o444);
      try {
        const before = hashes(dir);
        const r = await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(new RegExp(`^ltm supersede: wrote nothing, then failed on ${K}: .+\\n$`));
        expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
        expect(hashes(dir)).toEqual(before);
      } finally {
        chmodSync(join(dir, K), 0o644);
      }
    });
  });

  test("a write failure on the first file reports that nothing landed", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    await withScratch(demoBank, async (dir) => {
      chmodSync(join(dir, H), 0o444);
      try {
        const before = hashes(dir);
        const r = await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(new RegExp(`^ltm supersede: wrote nothing, then failed on ${H}: .+\\n$`));
        expect(hashes(dir)).toEqual(before);
      } finally {
        chmodSync(join(dir, H), 0o644);
      }
    });
  });

  test("from a dir with no Bank exits 1 and names the missing Bank", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
    try {
      const r = await sup(empty, "hT5cY8dUa6", "kQ7vN2xLp4");
      expect(r).toEqual({ exitCode: 1, stdout: "", stderr: noBankLine("supersede", empty) });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  describe("a skipped file makes the command refuse, since it could hide an id holder or an edge", () => {
    const BROKEN = "_memory/decisions/broken-hT5cY8dUa6.md";

    test("an unparseable Record that would duplicate the old id", async () => {
      await withScratch(demoBank, async (dir) => {
        writeFileSync(join(dir, BROKEN), "---\nid: hT5cY8dUa6\ntitle: [unclosed\n---\nbody\n");
        const before = hashes(dir);
        const r = await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain(`ltm supersede: skipped ${BROKEN}: `);
        expect(r.stderr.endsWith("ltm supersede: 1 file skipped, so nothing was written\n")).toBe(true);
        expect(hashes(dir)).toEqual(before);
      });
    });

    test("an unreadable Record", async () => {
      if (process.getuid?.() === 0) return; // root ignores file modes
      await withScratch(demoBank, async (dir) => {
        writeFileSync(join(dir, BROKEN), read(dir, H));
        const before = hashes(dir);
        chmodSync(join(dir, BROKEN), 0o000);
        try {
          const r = await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4");
          expect(r.exitCode).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toContain(`ltm supersede: skipped ${BROKEN}: `);
          expect(r.stderr.endsWith("ltm supersede: 1 file skipped, so nothing was written\n")).toBe(true);
        } finally {
          chmodSync(join(dir, BROKEN), 0o644);
        }
        expect(hashes(dir)).toEqual(before);
      });
    });

    test("two skipped files are counted in the plural", async () => {
      await withScratch(demoBank, async (dir) => {
        writeFileSync(join(dir, BROKEN), "---\n: [\n---\n");
        writeFileSync(join(dir, "_memory/decisions/broken-two.md"), "---\n: [\n---\n");
        const before = hashes(dir);
        const r = await sup(dir, "hT5cY8dUa6", "kQ7vN2xLp4");
        expect(r.exitCode).toBe(1);
        expect(r.stderr.endsWith("ltm supersede: 2 files skipped, so nothing was written\n")).toBe(true);
        expect(hashes(dir)).toEqual(before);
      });
    });
  });
});
