import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });
const lines = (s: string) => s.split("\n").filter((l) => l !== "");

describe("ltm facets", () => {
  test("lists sorted Facets with non-retired counts", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "facets");
      expect(r.exitCode).toBe(0);
      const out = lines(r.stdout);
      expect(out).toContain("service:order-service  3");
      expect(out).toContain("domain:commerce  8");
      const names = out.map((l) => l.split("  ")[0]!);
      expect(names).toEqual([...names].sort());
    });
  });

  test("--all counts retired Records too", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "facets", "--all");
      expect(r.exitCode).toBe(0);
      const out = lines(r.stdout);
      expect(out).toContain("service:order-service  3");
      expect(out).toContain("domain:commerce  10");
    });
  });

  test("--json prints facet/count objects only", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "facets", "--json");
      expect(r.exitCode).toBe(0);
      const rows = JSON.parse(r.stdout) as Record<string, unknown>[];
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(["count", "facet"]);
      expect(rows).toContainEqual({ facet: "domain:commerce", count: 8 });
      expect(r.stdout.endsWith("}\n]\n")).toBe(true);
    });
  });

  test("no Bank exits 1 and names the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
    try {
      const r = await ltm(dir, "facets");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(dir);
      expect(r.stderr).toContain("ltm facets:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--help lists facets", async () => {
    const r = await ltm(demo, "--help");
    expect(r.stdout).toContain("facets");
  });
});
