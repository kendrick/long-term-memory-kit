// Runs the plugin eval suite under evals/plugin/ and writes its JSON result to evals/results/<version>/plugin-eval.json.
// Usage: bun scripts/eval-plugin.ts [--version <v>] [<extra claude plugin eval flags>]. Exits with claude's own code: 1 can mean a score below threshold, so read stderr for load errors.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
// Every flag but --version passes through to claude, so `--case <glob>` works. Not parseArgs: Bun drops a leading "--" from argv, so the usual separator can't be relied on.
const passthrough = process.argv.slice(2);
const at = passthrough.indexOf("--version");
const picked = at === -1 ? undefined : passthrough.splice(at, 2)[1];
const version = picked ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const out = join(root, "evals/results", version, "plugin-eval.json");
mkdirSync(dirname(out), { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), "ltm-plugin-eval-"));
// Eval runs get a throwaway HOME and only allowlisted env vars, and plugin.json hands the MCP server an empty LTM_BANK_PATH. So the Bank has to reach ltm through the shim itself, via an LTM_CONFIG baked into it.
const bank = join(tmp, "demo-bank");
cpSync(join(root, "fixtures/demo-bank"), bank, { recursive: true });
const config = join(tmp, "ltm-config.yaml");
writeFileSync(config, `banks:\n  acme: { path: ${JSON.stringify(bank)} }\ndefault: acme\n`);

// CI puts the release binary on PATH; locally fall back to the source tree.
const onPath = Bun.which("ltm");
const exec = onPath ? `'${onPath}'` : `'${process.execPath}' '${join(root, "src/cli/bin.ts")}'`;
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "ltm"), `#!/bin/sh\nLTM_CONFIG='${config}' exec ${exec} "$@"\n`);
chmodSync(join(bin, "ltm"), 0o755);

const args = [
  "plugin", "eval", root,
  "--trust-plugin",
  "--no-publish",
  // The plugin's one MCP server has no mock, so record mode would leave it unstarted without this.
  "--allow-real-servers",
  "--allow-tools", "Bash(ltm *)", "mcp__plugin_ltm_ltm__*",
  "--max-cost-usd", "15",
  // Keeps claude's timestamped results dir out of the repo.
  "--output-dir", join(tmp, "results"),
  ...passthrough,
  "--json", out,
];
const r = spawnSync("claude", args, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
