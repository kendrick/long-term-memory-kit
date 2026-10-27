// Release gate: fails when the bench hit rate drops below the newest committed result at or below the input's version.
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
// A gate that can't read its input must fail, not pass on `undefined < n` being false.
const readResult = (file: string) => {
  const r = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; hit_rate?: unknown };
  const validVersion = typeof r.version === "string" && /^\d+\.\d+\.\d+/.test(r.version);
  if (!validVersion || typeof r.hit_rate !== "number" || !Number.isFinite(r.hit_rate)) {
    console.error(`eval-gate: ${file} needs a semver "version" and a finite numeric "hit_rate"`);
    process.exit(1);
  }
  return r as { version: string; hit_rate: number };
};
const input = readResult(positionals[0]);

// `<=` so a dry run at the committed version is held to its own result; a tag push's directory isn't committed yet.
const baseline = (existsSync(resultsDir) ? readdirSync(resultsDir) : [])
  .filter((v) => Bun.semver.order(v, input.version) <= 0 && existsSync(join(resultsDir, v, "bench.json")))
  .sort(Bun.semver.order)
  .at(-1);

if (baseline === undefined) {
  console.log(`no baseline found at or below ${input.version}; hit_rate ${input.hit_rate}`);
  process.exit(0);
}

const base = readResult(join(resultsDir, baseline, "bench.json"));
console.log(`${input.version} hit_rate ${input.hit_rate} vs ${baseline} hit_rate ${base.hit_rate}`);
if (input.hit_rate < base.hit_rate) {
  console.error(`eval-gate: hit_rate fell below ${baseline}`);
  process.exit(1);
}
