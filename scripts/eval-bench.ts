import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  options: { ltm: { type: "string" }, version: { type: "string" }, out: { type: "string" }, all: { type: "boolean" } },
});
const version = values.version ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const out = resolve(values.out ?? join(root, "evals/results", version, "bench.json"));
// shortcut: whitespace split, so a command path with spaces breaks; fine for `bun <repo>/...` and CI's dist/ binary.
const ltm = (values.ltm ?? `bun ${join(root, "src/cli/bin.ts")}`).split(/\s+/).filter(Boolean);
// The ltm child runs from a temp dir, so a relative binary path has to be pinned first.
if (ltm[0]!.includes("/") && !isAbsolute(ltm[0]!)) ltm[0] = resolve(ltm[0]!);

const bank = join(root, "fixtures/demo-bank");
const bench = JSON.parse(readFileSync(join(root, "evals/bench/demo-bank.bench.json"), "utf8"));

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

// Outside a repo whose origin the Bank's `consumers:` maps, ltm shows org-wide Records only and returns nothing for these queries.
const consumer = realpathSync(mkdtempSync(join(tmpdir(), "ltm-bench-")));
try {
  cpSync(join(root, "fixtures/consumer-repo"), consumer, { recursive: true });
  git(consumer, "init", "--quiet", "--initial-branch=main");
  git(consumer, "remote", "add", "origin", "https://github.com/acme/order-service.git");

  const queries = bench.queries.map((q: any) => {
    const args = [...ltm, "query", "--bank", bank, "--text", q.query, "--json", ...(values.all ? ["--all"] : [])];
    const p = Bun.spawnSync(args, { cwd: consumer, stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`ltm failed on "${q.query}": ${p.stderr.toString()}`);
    const ranked: string[] = JSON.parse(p.stdout.toString()).results.map((r: { path: string }) => r.path);
    const head = ranked.slice(0, q.expected_in_top_k);
    const forbidden: string[] = q.ltm_forbidden_files ?? [];
    // An empty expected_files list hits only on zero results; otherwise every no-answer query would pass vacuously.
    const hit =
      (q.expected_files.length === 0 ? ranked.length === 0 : q.expected_files.every((f: string) => head.includes(f))) &&
      !forbidden.some((f) => head.includes(f));
    return { id: q.id, hit, top: ranked };
  });

  const hits = queries.filter((q: { hit: boolean }) => q.hit).length;
  const total = queries.length;
  const result = { version, hit_rate: total ? hits / total : 0, hits, total, queries };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
