import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const reflowed = (tool: string) =>
  new URL(`../../fixtures/reflowed/${tool}`, import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });

// Raw bytes (latin1), so a reflow that only changes whitespace still compares unequal.
const read = (file: string) => readFileSync(file, "latin1");

function memoryRecords(dir: string): string[] {
  const out: string[] = [];
  for (const folder of readdirSync(join(dir, "_memory"))) {
    for (const name of readdirSync(join(dir, "_memory", folder))) {
      if (name.endsWith(".md")) out.push(`_memory/${folder}/${name}`);
    }
  }
  return out.sort();
}

function allFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

const hashes = (dir: string) =>
  allFiles(dir).map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]);

function bodyOf(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  expect(m).not.toBeNull();
  return text.slice(m![0].length);
}

describe.each(["prettier", "oxfmt"])("ltm fmt on the %s-reflowed Bank", (tool) => {
  test("restores every Record to the demo-bank bytes and is idempotent", async () => {
    await withScratch(reflowed(tool), async (dir) => {
      const records = memoryRecords(dir);
      expect(records).toEqual(memoryRecords(demo));

      // Without a real reflow the byte comparison below proves nothing.
      const differing = records.filter((r) => read(join(dir, r)) !== read(join(demo, r)));
      expect(differing.length).toBeGreaterThan(0);

      const bodiesBefore = records.map((r) => bodyOf(read(join(dir, r))));

      const first = await ltm(dir, "fmt");
      expect(first.exitCode).toBe(0);

      for (const r of records) {
        expect(read(join(dir, r))).toBe(read(join(demo, r)));
      }
      expect(records.map((r) => bodyOf(read(join(dir, r))))).toEqual(bodiesBefore);

      const before = hashes(dir);
      const second = await ltm(dir, "fmt");
      expect(second.exitCode).toBe(0);
      expect(hashes(dir)).toEqual(before);

      expect(await ltm(dir, "fmt", "--check")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    });
  });
});
