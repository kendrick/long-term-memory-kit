import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { run } from "../../src/cli/run.ts";
import { splitFrontmatter } from "../../src/core/record.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });

const QUEUE = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";
const PG = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const OVERVIEW = "_memory/context/order-service-overview-gN5yD9sMe2.md";

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const keysOf = (text: string) =>
  splitFrontmatter(text)!.frontmatterLines.map((l) => /^([A-Za-z_]+):/.exec(l)![1]!);

// Writes, then reads back, so an edit that matched nothing fails here and not as a false green later.
function edit(file: string, fn: (text: string) => string): string {
  const before = readFileSync(file, "utf8");
  writeFileSync(file, fn(before));
  const after = readFileSync(file, "utf8");
  expect(after).not.toBe(before);
  return after;
}

function reverseKeys(text: string): string {
  const split = splitFrontmatter(text)!;
  return `---\n${[...split.frontmatterLines].reverse().join("\n")}\n---\n${split.body}`;
}

const dropLine = (prefix: string) => (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith(prefix))
    .join("\n");

function allIds(dir: string): { file: string; id: unknown }[] {
  const out: { file: string; id: unknown }[] = [];
  for (const folder of readdirSync(join(dir, "_memory"))) {
    for (const name of readdirSync(join(dir, "_memory", folder))) {
      const rel = `_memory/${folder}/${name}`;
      const fm = parse(splitFrontmatter(readFileSync(join(dir, rel), "utf8"))!.frontmatterLines.join("\n"));
      out.push({ file: rel, id: fm.id });
    }
  }
  return out;
}

describe("ltm fmt", () => {
  test("shuffled keys come out in schema order, with the extra key deciders last", async () => {
    await withScratch(demo, async (dir) => {
      const file = join(dir, QUEUE);
      const expected = [
        "schema",
        "id",
        "memory_type",
        "title",
        "status",
        "date",
        "summary",
        "applies_to",
        "owners",
        "tags",
        "deciders",
      ];
      const shuffled = edit(file, reverseKeys);
      expect(keysOf(shuffled)).toEqual([...expected].reverse());
      const r = await ltm(dir, "fmt", QUEUE);
      expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(keysOf(readFileSync(file, "utf8"))).toEqual(expected);
    });
  });

  test("a Record without id gets a fresh one unique in the Bank, and keeps its filename", async () => {
    await withScratch(demo, async (dir) => {
      const file = join(dir, PG);
      edit(file, dropLine("id:"));
      const namesBefore = readdirSync(join(dir, "_memory/decisions")).sort();
      const r = await ltm(dir, "fmt");
      expect(r.exitCode).toBe(0);
      expect(readdirSync(join(dir, "_memory/decisions")).sort()).toEqual(namesBefore);
      const ids = allIds(dir);
      const mine = ids.find((x) => x.file === PG)!.id;
      expect(mine).toMatch(/^[A-Za-z0-9_-]{10}$/);
      const others = ids.filter((x) => x.file !== PG).map((x) => x.id);
      expect(others).toHaveLength(15);
      expect(others).not.toContain(mine);
    });
  });

  test("a Decision-folder Record with no memory_type gets memory_type: Decision", async () => {
    await withScratch(demo, async (dir) => {
      const file = join(dir, PG);
      edit(file, dropLine("memory_type:"));
      const r = await ltm(dir, "fmt", PG);
      expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(splitFrontmatter(readFileSync(file, "utf8"))!.frontmatterLines).toContain("memory_type: Decision");
    });
  });

  test("memory_type: Context in the Decision folder is kept, warned about by file, exit 0", async () => {
    await withScratch(demo, async (dir) => {
      const file = join(dir, PG);
      edit(file, (t) => t.replace("memory_type: Decision\n", "memory_type: Context\n"));
      const r = await ltm(dir, "fmt", PG);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe(
        `ltm fmt: warning: ${PG}: memory_type is 'Context' but the file is in the Decision folder\n`,
      );
      expect(splitFrontmatter(readFileSync(file, "utf8"))!.frontmatterLines).toContain("memory_type: Context");
    });
  });

  test("a commented Record is left byte-identical and named; an ordinary one in the same run is still formatted", async () => {
    await withScratch(demo, async (dir) => {
      const commented = join(dir, PG);
      edit(commented, (t) => t.replace("title:", "# a comment\ntitle:"));
      const commentedHash = sha(commented);
      const ordinary = join(dir, OVERVIEW);
      edit(ordinary, reverseKeys);
      const r = await ltm(dir, "fmt");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`ltm fmt: ${PG}: `);
      expect(sha(commented)).toBe(commentedHash);
      expect(keysOf(readFileSync(ordinary, "utf8"))).toEqual([
        "schema",
        "id",
        "memory_type",
        "title",
        "status",
        "date",
        "last_confirmed",
        "summary",
        "applies_to",
        "owners",
      ]);
    });
  });

  test("an id spelled 0123 is refused byte-identical and named; another Record in the run is still formatted", async () => {
    await withScratch(demo, async (dir) => {
      const numeric = join(dir, PG);
      edit(numeric, (t) => t.replace("id: kQ7vN2xLp4\n", "id: 0123\n"));
      const numericHash = sha(numeric);
      const ordinary = join(dir, OVERVIEW);
      const shuffled = edit(ordinary, reverseKeys);
      const r = await ltm(dir, "fmt");
      expect(r).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `ltm fmt: ${PG}: id: '0123' would be rewritten as '123'; quote it or write it canonically\n`,
      });
      expect(sha(numeric)).toBe(numericHash);
      expect(shuffled).not.toBe(readFileSync(join(demo, OVERVIEW), "utf8"));
      expect(readFileSync(ordinary, "utf8")).toBe(readFileSync(join(demo, OVERVIEW), "utf8"));
    });
  });

  test("--check passes the canonical demo Bank, then flags a shuffled Record without writing it", async () => {
    await withScratch(demo, async (dir) => {
      expect(await ltm(dir, "fmt", "--check")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      const file = join(dir, OVERVIEW);
      edit(file, reverseKeys);
      const before = sha(file);
      const r = await ltm(dir, "fmt", "--check");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe(`${OVERVIEW}\n`);
      expect(sha(file)).toBe(before);
    });
  });

  test("a named path that is not a Record file is refused with exit 1", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "fmt", "memory-bank.yaml");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("ltm fmt: memory-bank.yaml: not a Record file under any configured type folder\n");
    });
  });

  describe("skipped walk entries", () => {
    const LINK = "_memory/decisions/linked-zz9AAAAAAA.md";
    const setup = (dir: string) => symlinkSync(join(dir, OVERVIEW), join(dir, LINK));

    test("whole-Bank --check exits 1 naming the symlink, and still checks the other Records", async () => {
      await withScratch(demo, async (dir) => {
        setup(dir);
        // Every other Record is canonical, so the skip alone has to carry the exit code.
        const clean = await ltm(dir, "fmt", "--check");
        expect(clean.exitCode).toBe(1);
        expect(clean.stderr).toContain(`skipped ${LINK}`);
        edit(join(dir, OVERVIEW), reverseKeys);
        const r = await ltm(dir, "fmt", "--check");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe(`${OVERVIEW}\n`);
      });
    });

    test("naming the symlink exits 1", async () => {
      await withScratch(demo, async (dir) => {
        setup(dir);
        const r = await ltm(dir, "fmt", LINK);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(`skipped ${LINK}`);
      });
    });

    test("naming an unrelated Record exits 0 and still prints the skipped line", async () => {
      await withScratch(demo, async (dir) => {
        setup(dir);
        const r = await ltm(dir, "fmt", PG);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain(`skipped ${LINK}`);
      });
    });
  });

  const root = process.getuid?.() === 0;
  // Root ignores mode bits, so the write would succeed and the assertion would prove nothing.
  test.skipIf(root)("a Record that cannot be written is named, exits 1, and later Records are still formatted", async () => {
    await withScratch(demo, async (dir) => {
      const locked = join(dir, OVERVIEW);
      const other = join(dir, PG);
      edit(locked, reverseKeys);
      edit(other, reverseKeys);
      const before = readFileSync(locked, "utf8");
      chmodSync(locked, 0o444);
      try {
        const r = await ltm(dir, "fmt");
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(`ltm fmt: ${OVERVIEW}:`);
        expect(readFileSync(locked, "utf8")).toBe(before);
        expect(readFileSync(other, "utf8")).toBe(readFileSync(join(demo, PG), "utf8"));
      } finally {
        chmodSync(locked, 0o644);
      }
    });
  });

  test("outside any Bank, fmt exits 1 and names the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
    try {
      const r = await ltm(dir, "fmt");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
