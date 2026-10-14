import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });
const paths = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("  ")[0]!);

const record = (id: string, title: string, status: string, summary: string, tags: string) =>
  [
    "---",
    "schema: 1",
    `id: ${id}`,
    "memory_type: Decision",
    `title: ${title}`,
    `status: ${status}`,
    "date: 2026-03-01",
    `summary: ${summary}`,
    "applies_to: [domain:commerce]",
    "owners: [team:commerce-architecture]",
    `tags: [${tags}]`,
    "---",
    "",
    "## Context",
    "",
    "Scratch Record for a query rule.",
    "",
  ].join("\n");

describe("ltm query rules", () => {
  // Whole-token recall would miss this Record: "postgresql" is one token and never equals
  // "postgres". The title and summary avoid a bare "postgres" so nothing else can carry the hit.
  test("--text matches a substring of a longer word", async () => {
    await withScratch(demo, async (dir) => {
      const rel = "_memory/decisions/postgresql-connection-pooling-pQ4wE8rTy2.md";
      writeFileSync(
        join(dir, rel),
        record("pQ4wE8rTy2", "PostgreSQL connection pooling", "accepted", "Pool sizes for the relational tier.", "pooling"),
      );
      expect((await ltm(dir, "validate")).exitCode).toBe(0);

      const r = await ltm(dir, "query", "--text", "postgres");
      expect(r.exitCode).toBe(0);
      expect(paths(r.stdout)).toContain(rel);
    });
  });

  test("tags=superseded does not unlock retired Records", async () => {
    await withScratch(demo, async (dir) => {
      const rel = "_memory/decisions/retire-the-old-queue-xN6cV1bMk9.md";
      writeFileSync(
        join(dir, rel),
        record("xN6cV1bMk9", "Retire the old queue", "deprecated", "The old queue is gone.", "superseded"),
      );
      expect((await ltm(dir, "validate")).exitCode).toBe(0);

      // Control: the Record does match the tag filter once retired Records are unlocked.
      const all = await ltm(dir, "query", "--all", "tags=superseded");
      expect(paths(all.stdout)).toContain(rel);

      const r = await ltm(dir, "query", "tags=superseded");
      expect(r.exitCode).toBe(0);
      expect(paths(r.stdout)).not.toContain(rel);
    });
  });

  // Equal scores tie-break on a code-unit path compare, where "B-" sorts before "a-"; a locale
  // compare would flip them. Goes through the CLI so the order a caller sees is what's pinned.
  test("--text lists equal-scoring Records in code-unit path order", async () => {
    await withScratch(demo, async (dir) => {
      const upper = "_memory/decisions/B-zephyrwidget-bK3mN7pQw2.md";
      const lower = "_memory/decisions/a-zephyrwidget-aR5tY9uLe4.md";
      const body = (id: string) =>
        record(id, "Zephyrwidget rollout", "accepted", "Zephyrwidget ships in stages.", "rollout");
      writeFileSync(join(dir, upper), body("bK3mN7pQw2"));
      writeFileSync(join(dir, lower), body("aR5tY9uLe4"));
      expect((await ltm(dir, "validate")).exitCode).toBe(0);

      const r = await ltm(dir, "query", "--text", "zephyrwidget");
      expect(r.exitCode).toBe(0);
      expect(paths(r.stdout)).toEqual([upper, lower]);
    });
  });
});
