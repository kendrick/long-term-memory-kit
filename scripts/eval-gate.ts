// Release gate: fails when the bench hit rate drops below the newest earlier committed result.
// Usage: bun scripts/eval-gate.ts <bench.json> [--results <dir>]. Only bench.json counts; plugin-eval.json reports and never gates.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");
const { values, positionals } = parseArgs({ options: { results: { type: "string" } }, allowPositionals: true });
if (positionals.length !== 1) {
  console.error("usage: bun scripts/eval-gate.ts <bench.json> [--results <dir>]");
  process.exit(2);
}

const resultsDir = resolve(values.results ?? join(root, "evals/results"));
const input = JSON.parse(readFileSync(positionals[0], "utf8")) as { version: string; hit_rate: number };

const baseline = (existsSync(resultsDir) ? readdirSync(resultsDir) : [])
  .filter((v) => Bun.semver.order(v, input.version) < 0 && existsSync(join(resultsDir, v, "bench.json")))
  .sort(Bun.semver.order)
  .at(-1);

if (baseline === undefined) {
  console.log(`no baseline found below ${input.version}; hit_rate ${input.hit_rate}`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(join(resultsDir, baseline, "bench.json"), "utf8")) as { hit_rate: number };
console.log(`${input.version} hit_rate ${input.hit_rate} vs ${baseline} hit_rate ${base.hit_rate}`);
if (input.hit_rate < base.hit_rate) {
  console.error(`eval-gate: hit_rate fell below ${baseline}`);
  process.exit(1);
}
