import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../../scripts/eval-gate.ts", import.meta.url).pathname;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bench = (version: string, hit_rate: number) => ({
  version,
  hit_rate,
  hits: Math.round(hit_rate * 10),
  total: 10,
  queries: [],
});
const writeResult = (version: string, rate: number, file = "bench.json") => {
  mkdirSync(join(dir, "results", version), { recursive: true });
  writeFileSync(join(dir, "results", version, file), JSON.stringify(bench(version, rate)));
};
const gate = (version: string, rate: number) => {
  const input = join(dir, "input.json");
  writeFileSync(input, JSON.stringify(bench(version, rate)));
  const r = spawnSync("bun", [SCRIPT, input, "--results", join(dir, "results")], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe("eval-gate", () => {
  test("0.1.0 against a 0.0.0 baseline of 0.8: 0.8 and 0.9 pass, 0.7 fails", () => {
    writeResult("0.0.0", 0.8);
    expect(gate("0.1.0", 0.8).code).toBe(0);
    expect(gate("0.1.0", 0.9).code).toBe(0);
    const low = gate("0.1.0", 0.7);
    expect(low.code).toBe(1);
    expect(low.out).toContain("0.7");
    expect(low.out).toContain("0.8");
  });

  test("a committed 0.1.0 at 0.9 becomes the baseline for 0.2.0, which fails at 0.8", () => {
    writeResult("0.0.0", 0.8);
    writeResult("0.1.0", 0.9);
    expect(gate("0.2.0", 0.8).code).toBe(1);
    expect(gate("0.2.0", 0.9).code).toBe(0);
  });

  test("no earlier result passes and says so", () => {
    const r = gate("0.0.0", 0.1);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no baseline");
  });

  test("a version that sorts above the input, or lacks bench.json, is not a baseline", () => {
    writeResult("0.5.0", 0.99);
    mkdirSync(join(dir, "results", "0.0.0"), { recursive: true });
    expect(gate("0.1.0", 0.1)).toMatchObject({ code: 0 });
  });

  test("an input at the committed version is held to that committed result", () => {
    writeResult("0.0.0", 0.8);
    expect(gate("0.0.0", 0.7).code).toBe(1);
    expect(gate("0.0.0", 0.8).code).toBe(0);
  });

  test("plugin-eval.json never moves the gate", () => {
    writeResult("0.0.0", 0.8);
    writeResult("0.0.0", 0.1, "plugin-eval.json");
    writeResult("0.0.5", 0.1, "plugin-eval.json");
    expect(gate("0.1.0", 0.7).code).toBe(1);
    expect(gate("0.1.0", 0.8).code).toBe(0);
  });

  test("an input or baseline without a valid version and finite hit_rate fails", () => {
    const run = (body: unknown) => {
      const input = join(dir, "bad.json");
      writeFileSync(input, JSON.stringify(body));
      return spawnSync("bun", [SCRIPT, input, "--results", join(dir, "results")], { encoding: "utf8" });
    };
    expect(run({ version: "0.1.0" }).status).toBe(1);
    expect(run({ version: "nope", hit_rate: 1 }).status).toBe(1);
    expect(run({ version: "0.1.0", hit_rate: null }).status).toBe(1);
    mkdirSync(join(dir, "results", "0.0.0"), { recursive: true });
    writeFileSync(join(dir, "results", "0.0.0", "bench.json"), JSON.stringify({ version: "0.0.0" }));
    expect(gate("0.1.0", 1).code).toBe(1);
  });
});
