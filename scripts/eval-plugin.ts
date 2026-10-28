// Runs the plugin eval suite under evals/plugin/ and writes its JSON result to evals/results/<version>/plugin-eval.json.
// Usage: bun scripts/eval-plugin.ts [--version <v>] [<extra claude plugin eval flags>]. Exits with claude's own code: 1 can mean a score below threshold, so read stderr for load errors.
//        bun scripts/eval-plugin.ts --scrub <file>   rewrites local paths in an existing result file, in place.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Committed results must not carry machine paths. One pass, longest prefix first so `/private/tmp` beats `/tmp`; the lookarounds leave `/tmpfoo`, `a/tmp/b`, and `/Users/me.config` alone but still match `file:///Users/me` and a path ending a sentence (`/tmp.`). The scrub must be idempotent, so a prefix right after our own outputs (`~`, `.`, `>` of `<tmp>`) is never rewritten again, and `//tmp/x` or anything inside a non-file `scheme://` URL is a host or URL path, not a local one. `-I/Users/me` stays unscrubbed: telling it from `/opt/Users/me` needs the char before the prefix, and no rule on that is safe.
export function scrubPaths<T>(value: T, replacements: [string, string][]): T {
  const by = new Map(replacements.map(([from, to]) => [from.replace(/\/+$/, ""), to]));
  const prefixes = [...by.keys()].sort((a, b) => b.length - a.length).map(esc).join("|");
  const re = new RegExp(`(?<![\\w.\\-~>])(?<!(?<!file:/)/)(?<!\\b(?!file:)[a-z][a-z0-9+.\\-]*://\\S*)(?:${prefixes})(?![\\w\\-])(?!\\.\\w)`, "g");
  const walk = (v: unknown): unknown =>
    typeof v === "string" ? v.replace(re, (m) => by.get(m)!)
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    : v;
  return walk(value) as T;
}

function localReplacements(root: string, tmp?: string): [string, string][] {
  const roots = [root];
  const wt = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (wt.status === 0) for (const l of wt.stdout.split("\n")) if (l.startsWith("worktree ")) roots.push(l.slice(9));
  const temps = ["/private/tmp", "/tmp", tmpdir(), process.env.TMPDIR, tmp].filter((p): p is string => !!p);
  for (const t of [...temps]) try { temps.push(realpathSync(t)); } catch {}
  const home = process.env.HOME ?? homedir();
  return [...roots.map((r): [string, string] => [r, "."]), ...temps.map((t): [string, string] => [t, "<tmp>"]), [home, "~"]];
}

const scrubFile = (file: string, map: [string, string][]) =>
  writeFileSync(file, JSON.stringify(scrubPaths(JSON.parse(readFileSync(file, "utf8")), map), null, 2) + "\n");

function main() {
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
  // claude can exit 1 on a low score yet still write the file, so scrub whenever it exists.
  try { scrubFile(out, localReplacements(root, tmp)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  process.exit(r.status ?? 1);
}

if (import.meta.main) {
  const s = process.argv.indexOf("--scrub");
  if (s === -1) main();
  else scrubFile(process.argv[s + 1]!, localReplacements(root));
}
