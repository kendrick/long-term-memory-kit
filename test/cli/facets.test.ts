import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withConsumerRepo } from "../helpers/consumer-repo.ts";
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
      expect(out).toContain("service:order-service  5");
      expect(out).toContain("domain:commerce  10");
      const names = out.map((l) => l.split("  ")[0]!);
      expect(names).toEqual([...names].sort());
    });
  });

  test("--all counts retired Records too", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "facets", "--all");
      expect(r.exitCode).toBe(0);
      const out = lines(r.stdout);
      expect(out).toContain("service:order-service  7");
      expect(out).toContain("domain:commerce  14");
    });
  });

  test("--json prints facet/count objects only", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "facets", "--json");
      expect(r.exitCode).toBe(0);
      const rows = JSON.parse(r.stdout) as Record<string, unknown>[];
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(["count", "facet"]);
      expect(rows).toContainEqual({ facet: "domain:commerce", count: 10 });
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

// A Consumer repo outside any Bank, plus a user config naming temp copies of the demo Bank. Its origin (github.com/acme/order-service) matches no rule unless `rules` adds one.
async function withConfiguredRepo(
  config: (banks: string[]) => string,
  names: string[],
  fn: (repo: string, env: Record<string, string>, banks: string[]) => Promise<void>,
) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ltm-facets-home-")));
  try {
    const banks = names.map((n) => {
      const dir = join(home, "banks", n);
      cpSync(demo, dir, { recursive: true });
      return dir;
    });
    const path = join(home, "config.yaml");
    writeFileSync(path, config(banks));
    await withConsumerRepo((repo) => fn(repo, { LTM_CONFIG: path, HOME: home }, banks));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// MCP `facets` runs `ltm facets --json` with the Bank root as cwd, so that run is the reference for every fallback.
const inBankJson = async (bank: string) => {
  const r = await ltm(bank, "facets", "--json");
  expect(r.exitCode).toBe(0);
  return r.stdout;
};

describe("ltm facets outside a Bank", () => {
  test("counts the user config's default Bank", async () => {
    await withConfiguredRepo(
      ([a]) => `banks:\n  acme: { path: ${a} }\ndefault: acme\n`,
      ["acme"],
      async (repo, env, [bank]) => {
        const r = await run({ argv: ["facets", "--json"], cwd: repo, env });
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        const rows = JSON.parse(r.stdout) as { facet: string; count: number }[];
        expect(rows.map((row) => row.facet)).toContain("service:order-service");
        expect(r.stdout).toBe(await inBankJson(bank as string));
      },
    );
  });

  test("two resolved Banks fail naming both", async () => {
    await withConfiguredRepo(
      ([a, b]) =>
        `banks:\n  acme: { path: ${a} }\n  personal: { path: ${b} }\nrules:\n  - { match: github.com/acme/*, bank: acme }\n  - { match: github.com/acme/order-service, bank: personal }\n`,
      ["acme", "personal"],
      async (repo, env) => {
        const r = await run({ argv: ["facets"], cwd: repo, env });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe(`ltm facets: 2 Banks resolve for ${repo} (acme, personal); pass --bank to pick one\n`);
      },
    );
  });

  test("--bank <path> counts that Bank", async () => {
    await withConfiguredRepo(
      () => "banks: {}\n",
      ["other"],
      async (repo, env, [bank]) => {
        const r = await run({ argv: ["facets", "--json", "--bank", bank as string], cwd: repo, env });
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        const rows = JSON.parse(r.stdout) as { facet: string; count: number }[];
        expect(rows.map((row) => row.facet)).toContain("service:order-service");
        expect(r.stdout).toBe(await inBankJson(bank as string));
      },
    );
  });
});
