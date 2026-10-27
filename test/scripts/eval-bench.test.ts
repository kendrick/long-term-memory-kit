import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const benchPath = join(root, "evals/bench/demo-bank.bench.json");
const bank = join(root, "fixtures/demo-bank");
const bench = JSON.parse(readFileSync(benchPath, "utf8"));
const TYPES = ["exact", "semantic", "topical", "cross-domain", "alias"];
const SUPERSEDED = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";

function run(out: string, ...extra: string[]) {
  const p = Bun.spawnSync(["bun", join(root, "scripts/eval-bench.ts"), "--out", out, ...extra], { cwd: root });
  expect(p.exitCode, p.stderr.toString()).toBe(0);
  return readFileSync(out, "utf8");
}
const tmpOut = () => join(mkdtempSync(join(tmpdir(), "ltm-bench-test-")), "bench.json");

describe("bench file", () => {
  test("has at least 10 queries in qmd's shape", () => {
    expect(bench.queries.length).toBeGreaterThanOrEqual(10);
    for (const q of bench.queries) {
      expect(typeof q.id).toBe("string");
      expect(typeof q.query).toBe("string");
      expect(TYPES).toContain(q.type);
      expect(Array.isArray(q.expected_files)).toBe(true);
      expect(typeof q.expected_in_top_k).toBe("number");
    }
    expect(new Set(bench.queries.map((q: { id: string }) => q.id)).size).toBe(bench.queries.length);
  });

  test("every referenced path exists in the demo Bank", () => {
    for (const q of bench.queries) {
      for (const f of [...q.expected_files, ...(q.ltm_forbidden_files ?? [])]) {
        expect(existsSync(join(bank, f)), f).toBe(true);
      }
    }
  });
});

describe("runner", () => {
  test("two runs are byte-identical and every query is reported", () => {
    const a = run(tmpOut());
    expect(run(tmpOut())).toBe(a);
    const r = JSON.parse(a);
    expect(Object.keys(r)).toEqual(["version", "hit_rate", "hits", "total", "queries"]);
    expect(r.queries.map((q: { id: string }) => q.id)).toEqual(bench.queries.map((q: { id: string }) => q.id));
    expect(a.endsWith("}\n")).toBe(true);
  }, 120_000);

  test("the superseded-Decision query hits normally and misses with --all", () => {
    const id = bench.queries.find((q: { ltm_forbidden_files?: string[] }) => q.ltm_forbidden_files?.includes(SUPERSEDED)).id;
    const hit = (r: string) => JSON.parse(r).queries.find((q: { id: string }) => q.id === id).hit;
    expect(hit(run(tmpOut()))).toBe(true);
    expect(hit(run(tmpOut(), "--all"))).toBe(false);
  }, 120_000);
});
