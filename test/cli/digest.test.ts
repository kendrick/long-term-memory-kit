import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../../src/cli/digest.ts";
import { query } from "../../src/cli/query.ts";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const ltm = (cwd: string, argv: string[], LTM_TODAY = "2026-11-05") =>
  run({ argv, cwd, env: { LTM_TODAY } }, [digest, query]);
// Only entry headings carry an id in parens; link lines name other Records' ids too.
const digestIds = (md: string) => new Set([...md.matchAll(/^### .* \(([^()\s]+)\)$/gm)].map((m) => m[1]!));
const snapshot = (dir: string) =>
  Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), "utf8")]));

describe("ltm digest", () => {
  test("lists exactly the ids ltm query --status accepted lists", async () => {
    await withScratch(demo, async (dir) => {
      const d = await ltm(dir, ["digest"]);
      const q = await ltm(dir, ["query", "--status", "accepted", "--json"]);
      expect(d.exitCode).toBe(0);
      expect(q.exitCode).toBe(0);
      const want = new Set((JSON.parse(q.stdout) as { id: string }[]).map((r) => r.id));
      expect(want.size).toBeGreaterThan(0);
      expect(digestIds(d.stdout)).toEqual(want);
    });
  });

  test("drops an Exception the day after its effective_to and keeps it on that day", async () => {
    await withScratch(demo, async (dir) => {
      const after = await ltm(dir, ["digest"], "2027-04-01");
      const on = await ltm(dir, ["digest"], "2027-03-31");
      expect(digestIds(after.stdout).has("wJ3nC7hTy4")).toBe(false);
      expect(digestIds(on.stdout).has("wJ3nC7hTy4")).toBe(true);
    });
  });

  test("--out twice with the same LTM_TODAY leaves every file byte-identical", async () => {
    await withScratch(demo, async (dir) => {
      const out = join(dir, "digest-out");
      expect((await ltm(dir, ["digest", "--out", out])).exitCode).toBe(0);
      const first = snapshot(out);
      expect(Object.keys(first)).toEqual(["accepted.md"]);
      expect((await ltm(dir, ["digest", "--out", out])).exitCode).toBe(0);
      expect(snapshot(out)).toEqual(first);
    });
  });

  test("--split facet writes a file per Facet plus org-wide.md", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, ["digest", "--out", "split", "--split", "facet"]);
      expect(r.exitCode).toBe(0);
      const names = readdirSync(join(dir, "split"));
      expect(names).toContain("service_3aorder-service.md");
      expect(names).toContain("org-wide.md");
    });
  });

  test("--split without --out, and a mode other than facet, are usage errors", async () => {
    await withScratch(demo, async (dir) => {
      for (const argv of [
        ["digest", "--split", "facet"],
        ["digest", "--out", "x", "--split", "tag"],
      ]) {
        const r = await ltm(dir, argv);
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toBe("");
      }
    });
  });

  test("a Digest under 1,500,000 characters prints no warning", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, ["digest"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeLessThan(1_500_000);
      expect(r.stderr).toBe("");
    });
  });
});
