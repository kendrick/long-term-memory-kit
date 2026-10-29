// Agent-answer eval (issue #26): the exported half reads a `claude -p --output-format stream-json --verbose` transcript and scores it on cited Record ids, with no spawning or fs access; the runner below `import.meta.main` stages a consumer repo per question and drives real `claude` runs.
// Usage: bun scripts/eval-agent-answer.ts [--limit N] [--version <v>] [--out <file>] [--transcripts <dir>]
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/core/bank.ts";
import { listRecords } from "../src/core/query.ts";
import { scrubPaths } from "./eval-plugin.ts";

export type Style = "single-hop" | "multi-session" | "temporal" | "knowledge-update" | "abstention";

export type Question = {
  id: string;
  style: Style;
  question: string;
  gold_ids: string[];
  forbidden_ids: string[];
  gold_files: string[];
};

export type Transcript = {
  answer: string;
  /** null when the final line has no `CITED:` line; `[]` for `CITED: NONE`. */
  cited: string[] | null;
  filesRead: string[];
};

export type Score = { correct: boolean; fileRecall: number | null };

type Block = { type?: string; is_error?: boolean; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown };

const MCP_HEAD = "mcp__plugin_ltm_ltm__head";
const MCP_QUERY = "mcp__plugin_ltm_ltm__query";

const toText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n") : "";

// Absolute paths under the staged Bank copy collapse to the Bank-relative form `ltm query --json` prints.
function normalize(p: string, bankRoot: string): string {
  const q = p.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
  if (!isAbsolute(q)) return q;
  const rel = relative(bankRoot, q);
  return rel.startsWith("..") ? q : rel;
}

// Flags drop out; `-n`/`-c` also take their count, so `head -n 20 <path>` yields only the path.
function fileArgs(rest: string): string[] {
  const out: string[] = [];
  const toks = rest.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t === "-n" || t === "-c") i++;
    else if (!t.startsWith("-")) out.push(t.replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

// The `ltm query --json` CLI prints a bare array of {path}, while Claude Code 2.1.311 hands the agent the MCP query tool's structuredContent as {results:[{path}]}; the line regex covers the tool's human `bank:path  type ...` text.
function queryPaths(result: string): string[] {
  try {
    const parsed = JSON.parse(result) as unknown;
    const rows = Array.isArray(parsed) ? parsed : (parsed as { results?: unknown } | null)?.results;
    if (Array.isArray(rows)) return rows.flatMap((r) => (typeof r?.path === "string" ? [r.path] : []));
  } catch {}
  return [...result.matchAll(/^(?:[^\s:]+:)?(\S+\.md)\s{2}/gm)].map((m) => m[1] as string);
}

// The query-memory skill tells agents to `cd <bank-root> && ltm head <path>`, so each `&&`/`;` segment counts on its own and a `cd` re-roots the relative paths after it.
function bashPaths(command: string, result: string): string[] {
  let cwd: string | undefined;
  const out: string[] = [];
  for (const seg of command.split(/&&|;/).map((s) => s.trim())) {
    const cd = /^cd\s+(\S+)$/.exec(seg);
    if (cd) {
      const dir = (cd[1] as string).replace(/^['"]|['"]$/g, "");
      cwd = cwd === undefined || isAbsolute(dir) ? dir : join(cwd, dir);
      continue;
    }
    const files = /^(?:cat|head|ltm head)\s+(.+)$/.exec(seg);
    const found = files ? fileArgs(files[1] as string) : /^ltm query\b/.test(seg) && /(^|\s)--json(\s|$)/.test(seg) ? queryPaths(result) : [];
    const base = cwd;
    out.push(...(files && base !== undefined ? found.map((f) => (isAbsolute(f) ? f : join(base, f))) : found));
  }
  return out;
}

function pathsRead(name: string, input: Record<string, unknown>, result: string, idPaths: ReadonlyMap<string, string>): string[] {
  if (name === "Read") return typeof input.file_path === "string" ? [input.file_path] : [];
  if (name === MCP_HEAD) {
    if (typeof input.path === "string") return [input.path];
    const byId = typeof input.id === "string" ? idPaths.get(input.id) : undefined;
    return byId ? [byId] : [];
  }
  if (name === MCP_QUERY) return queryPaths(result);
  if (name === "Bash" && typeof input.command === "string") return bashPaths(input.command, result);
  return [];
}

// MCP head by id never echoes the path, so the caller passes the Bank's id -> path map and this stays free of fs access.
export function extractAnswer(streamJson: string, bankRoot: string, idPaths: ReadonlyMap<string, string> = new Map()): Transcript {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const read = new Set<string>();
  let final = "";
  for (const line of streamJson.split("\n")) {
    if (line.trim() === "") continue;
    let ev: { type?: string; result?: unknown; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "result" && typeof ev.result === "string") final = ev.result;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (ev.type === "assistant" && b.type === "tool_use" && b.id) calls.set(b.id, { name: b.name ?? "", input: b.input ?? {} });
      // An errored result (missing file, denied command, MCP error) put no Record content in context.
      if (ev.type === "user" && b.type === "tool_result" && b.tool_use_id && b.is_error !== true) {
        const call = calls.get(b.tool_use_id);
        if (call) for (const p of pathsRead(call.name, call.input, toText(b.content), idPaths)) read.add(normalize(p, bankRoot));
      }
    }
  }
  const lines = final.split("\n");
  const at = lines.findLastIndex((l) => l.startsWith("CITED: "));
  const last = at < 0 ? undefined : (lines[at] as string).slice(7).trim();
  const cited = last === undefined || last === "" ? null : last === "NONE" ? [] : last.split(",").map((s) => s.trim()).filter(Boolean);
  return { answer: lines.filter((_, i) => i !== at).join("\n").trim(), cited, filesRead: [...read] };
}

// Correctness reads only the CITED line, never the prose.
export function scoreAnswer(q: Question, t: Transcript): Score {
  const abstain = q.style === "abstention";
  const cited = t.cited;
  const correct =
    cited === null ? false
    : abstain ? cited.length === 0
    : q.gold_ids.every((id) => cited.includes(id)) && !q.forbidden_ids.some((id) => cited.includes(id));
  const fileRecall = abstain || q.gold_files.length === 0 ? null : q.gold_files.filter((f) => t.filesRead.includes(f)).length / q.gold_files.length;
  return { correct, fileRecall };
}

export const INSTRUCTION =
  "Answer from this repo's org memory. End with a last line `CITED: <id>, <id>` listing the Record ids your answer relies on, or `CITED: NONE` if the memory doesn't cover it.";

type Init = {
  model?: string;
  claude_code_version?: string;
  plugins?: { name: string; path?: string }[];
  plugin_errors?: unknown;
  mcp_servers?: { name: string; status?: string }[];
  memory_paths?: unknown;
};

export function initEvent(streamJson: string): Init | undefined {
  for (const line of streamJson.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "system" && ev.subtype === "init") return ev as Init;
    } catch {}
  }
}

export function resultEvent(streamJson: string): { is_error?: boolean; result?: string; total_cost_usd?: number } | undefined {
  for (const line of streamJson.split("\n").reverse()) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "result") return ev;
    } catch {}
  }
}

const isEmpty = (v: unknown) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.keys(v as object).length === 0);

// Why each check: the eval measures this plugin alone, so any other plugin or MCP server, or the user's CLAUDE.md/auto-memory, would leak outside knowledge into answers.
// Claude Code 2.1.311 loads these three `path: "builtin"` plugins under every setup (temp config dir, --bare, --strict-mcp-config) and the eval can't turn them off, so they're allowed by name; any other non-ltm plugin fails the probe.
export const ALLOWED_BUILTINS = ["cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-plugin-authoring"];

export function pluginProblems(init: Init | undefined): string[] {
  if (!init) return ["no system/init event"];
  const p: string[] = [];
  if (!init.plugins?.some((x) => x.name === "ltm")) p.push("plugin ltm not loaded");
  if (!isEmpty(init.plugin_errors)) p.push(`plugin_errors: ${JSON.stringify(init.plugin_errors)}`);
  const ltmMcp = init.mcp_servers?.find((m) => m.name === "plugin:ltm:ltm");
  if (!ltmMcp) p.push("MCP server plugin:ltm:ltm not listed");
  else if (ltmMcp.status !== "connected") p.push(`MCP server plugin:ltm:ltm is ${ltmMcp.status}`);
  return p;
}

export function probeProblems(streamJson: string): string[] {
  const init = initEvent(streamJson);
  const p = pluginProblems(init);
  if (!init) return p;
  const others = (init.plugins ?? []).filter((x) => x.name !== "ltm" && !(x.path === "builtin" && ALLOWED_BUILTINS.includes(x.name))).map((x) => x.name);
  if (others.length) p.push(`other plugins loaded: ${others.join(", ")}`);
  const mcps = (init.mcp_servers ?? []).filter((m) => m.name !== "plugin:ltm:ltm").map((m) => m.name);
  if (mcps.length) p.push(`other MCP servers loaded: ${mcps.join(", ")}`);
  if (!isEmpty(init.memory_paths)) p.push(`memory files loaded: ${JSON.stringify(init.memory_paths)}`);
  const res = resultEvent(streamJson);
  if (!res) p.push("no result event");
  else if (res.is_error) p.push(`run failed: ${res.result}`);
  return p;
}

export type Row = { id: string; style: Style; correct: boolean; answer: string; cited: string[] | null; file_recall: number | null; cost_usd: number | null; plugin_loaded: boolean; files_read: string[] };

export const RUN_BUDGET_USD = 0.5;

// A timeout surfaces as r.error (ETIMEDOUT) with the partial stdout attached; throwing there would abort the loop before the results file is written and lose every finished question. Timeouts and signal kills fall through to runCost's unknown-cost path; only a failure to launch claude (ENOENT, EACCES) or a maxBuffer overrun stops the run.
export function spawnOutput(r: { error?: Error; stdout: string | null; stderr: string | null }): { stream: string; stderr: string } {
  if (r.error && (r.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw r.error;
  return { stream: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// A run that failed or was killed before its result event still spent up to the per-run cap, so the guard charges the cap; the row records null because the real figure is unknown, never 0.
export function runCost(streamJson: string): { cost_usd: number | null; charged_usd: number } {
  const c = resultEvent(streamJson)?.total_cost_usd;
  return typeof c === "number" ? { cost_usd: c, charged_usd: c } : { cost_usd: null, charged_usd: RUN_BUDGET_USD };
}

type Agg = { n: number; correct: number; accuracy: number; file_recall: number | null };
const agg = (rows: Row[]): Agg => {
  const recalls = rows.map((r) => r.file_recall).filter((x): x is number => x !== null);
  const correct = rows.filter((r) => r.correct).length;
  return { n: rows.length, correct, accuracy: rows.length ? correct / rows.length : 0, file_recall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null };
};

// File recall averages only questions that have one, so abstention (always null) doesn't drag it to zero. total_cost_usd sums known costs only, so cost_unknown_runs says how far it may undercount.
export function aggregate(rows: Row[]): { by_style: Partial<Record<Style, Agg>>; overall: Agg; total_cost_usd: number; cost_unknown_runs: number } {
  const by_style: Partial<Record<Style, Agg>> = {};
  for (const style of [...new Set(rows.map((r) => r.style))]) by_style[style] = agg(rows.filter((r) => r.style === style));
  return { by_style, overall: agg(rows), total_cost_usd: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0), cost_unknown_runs: rows.filter((r) => r.cost_usd === null).length };
}

const ROOT = resolve(import.meta.dir, "..");
const TOTAL_BUDGET_USD = 15;

// The temp CLAUDE_CONFIG_DIR is the isolation: it hides the user's plugins, MCP servers and settings. --strict-mcp-config and --bare would also drop the --plugin-dir plugin's own MCP server, so neither is used.
const ISOLATION = "temp CLAUDE_CONFIG_DIR, CLAUDE_CODE_DISABLE_CLAUDE_MDS=1, CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, --plugin-dir <repo>, ltm shim with LTM_CONFIG on PATH";

// A temp CLAUDE_CONFIG_DIR has no login, so a key must come from env; without one the run must stop rather than fall back to the user's real config dir.
export function authProblem(env: Record<string, string | undefined>): string | undefined {
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) return "neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set; a temp CLAUDE_CONFIG_DIR can't use the keychain login";
}

function git(cwd: string, ...args: string[]) {
  const p = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.trim();
}

// One throwaway world per run: consumer repo (git, origin mapped by the Bank's `consumers:`), Bank copy, ltm shim, and an empty CLAUDE_CONFIG_DIR.
function stage() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ltm-agent-answer-")));
  const repo = join(tmp, "repo");
  cpSync(join(ROOT, "fixtures/consumer-repo"), repo, { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");
  // Guard: never commit into a repo git found by walking up.
  if (git(repo, "rev-parse", "--git-dir") !== ".git") throw new Error(`staged repo ${repo} is not its own git repo`);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=ltm eval", "-c", "user.email=ltm@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed");
  git(repo, "remote", "add", "origin", "https://github.com/acme/order-service.git");
  const bank = join(tmp, "demo-bank");
  cpSync(join(ROOT, "fixtures/demo-bank"), bank, { recursive: true });
  // Same shim as scripts/eval-plugin.ts: a --plugin-dir plugin may never see userConfig, and the MCP server runs `ltm mcp` from PATH, so LTM_CONFIG baked into the shim reaches both the Bash and MCP routes.
  const config = join(tmp, "ltm-config.yaml");
  writeFileSync(config, `banks:\n  acme: { path: ${JSON.stringify(bank)} }\ndefault: acme\n`);
  const onPath = Bun.which("ltm");
  const exec = onPath ? `'${onPath}'` : `'${process.execPath}' '${join(ROOT, "src/cli/bin.ts")}'`;
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ltm"), `#!/bin/sh\nLTM_CONFIG='${config}' exec ${exec} "$@"\n`);
  chmodSync(join(bin, "ltm"), 0o755);
  const configDir = join(tmp, "claude-config");
  mkdirSync(configDir);
  return { tmp, repo, bank, bin, configDir };
}

function runClaude(question: string) {
  const s = stage();
  try {
    const args = [
      "-p", `${question}\n\n${INSTRUCTION}`,
      "--plugin-dir", ROOT,
      "--output-format", "stream-json", "--verbose",
      "--model", "sonnet",
      "--max-turns", "15",
      "--no-session-persistence",
      "--tools", "Read,Glob,Grep,Bash",
      "--allowedTools", "Read,Glob,Grep,Bash(ltm *),Bash(cat *),mcp__plugin_ltm_ltm__*",
      "--disallowedTools", "Edit,Write,WebFetch,WebSearch",
      "--permission-mode", "dontAsk",
      "--max-budget-usd", String(RUN_BUDGET_USD),
    ];
    const r = spawnSync("claude", args, {
      cwd: s.repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      // process.env carries the auth token through to claude; nothing here logs or writes it.
      env: {
        ...process.env,
        PATH: `${s.bin}${delimiter}${process.env.PATH ?? ""}`,
        CLAUDE_CONFIG_DIR: s.configDir,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
    });
    return { ...spawnOutput(r), bank: s.bank };
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
}

export function parseCli(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { limit: { type: "string" }, version: { type: "string" }, out: { type: "string" }, transcripts: { type: "string" } } });
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error(`--limit must be a positive integer, got ${values.limit}`);
  return { limit, version: values.version, out: values.out, transcripts: values.transcripts };
}

function main() {
  const cli = parseCli(process.argv.slice(2));
  const version = cli.version ?? JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const out = resolve(cli.out ?? join(ROOT, "evals/results", version, "agent-answer.json"));
  const all = JSON.parse(readFileSync(join(ROOT, "evals/agent-answer/questions.json"), "utf8")) as Question[];
  const questions = cli.limit ? all.slice(0, cli.limit) : all;
  const started_at = new Date().toISOString();
  // Bank-relative paths match the staged copy's, which is gone by the time a transcript is read.
  const idPaths = new Map(listRecords(loadConfig(join(ROOT, "fixtures/demo-bank")), () => {}).map((r) => [String(r.frontmatter.id), r.path]));

  const auth = authProblem(process.env);
  if (auth) {
    console.error(`probe: FAILED, ${auth}`);
    process.exit(2);
  }
  const probe = runClaude(all[0]!.question);
  const probeCost = resultEvent(probe.stream)?.total_cost_usd ?? 0;
  const problems = probeProblems(probe.stream);
  const init = initEvent(probe.stream);
  if (problems.length) {
    console.error(`probe: FAILED\n  ${problems.join("\n  ")}\n  init: ${JSON.stringify(init)}\n  stderr: ${probe.stderr.trim()}`);
    process.exit(2);
  }
  console.error("probe: passed");

  const rows: Row[] = [];
  let spent = probeCost;
  let stopped_for_budget = false;
  for (const q of questions) {
    if (spent > TOTAL_BUDGET_USD) {
      stopped_for_budget = true;
      break;
    }
    const { stream, bank } = runClaude(q.question);
    // Raw streams hold absolute temp paths; keep them out of the repo (scratch dir) and scrub before committing any as fixtures.
    if (cli.transcripts) {
      mkdirSync(cli.transcripts, { recursive: true });
      writeFileSync(join(cli.transcripts, `${q.id}.jsonl`), stream);
    }
    const t = extractAnswer(stream, bank, idPaths);
    const s = scoreAnswer(q, t);
    const { cost_usd: cost, charged_usd } = runCost(stream);
    spent += charged_usd;
    if (cost === null) console.error(`${q.id}: no result event, so its cost is unknown; counting $${RUN_BUDGET_USD.toFixed(2)} toward the $${TOTAL_BUDGET_USD} guard`);
    const row: Row = { id: q.id, style: q.style, correct: s.correct, answer: t.answer, cited: t.cited, file_recall: s.fileRecall, cost_usd: cost, plugin_loaded: pluginProblems(initEvent(stream)).length === 0, files_read: [...t.filesRead].sort() };
    rows.push(row);
    console.error(`${q.id}: ${row.correct ? "correct" : "wrong"} cited=${JSON.stringify(row.cited)} recall=${row.file_recall} ${cost === null ? "cost unknown" : `$${cost.toFixed(3)}`}${row.plugin_loaded ? "" : " PLUGIN NOT LOADED"}`);
  }

  const summary = aggregate(rows);
  const claudeVersion = init?.claude_code_version ?? spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();
  const result = {
    version,
    model: init?.model,
    claude_code_version: claudeVersion,
    isolation: ISOLATION,
    started_at,
    finished_at: new Date().toISOString(),
    partial: questions.length < all.length || stopped_for_budget,
    ...(cli.limit ? { limit: cli.limit } : {}),
    stopped_for_budget,
    probe_cost_usd: probeCost,
    ...summary,
    questions: rows,
  };
  const home = process.env.HOME ?? homedir();
  const temps = [tmpdir(), "/private/tmp", "/tmp"].flatMap((t) => { try { return [t, realpathSync(t)]; } catch { return [t]; } });
  const scrubbed = scrubPaths(result, [[ROOT, "."], ...temps.map((t): [string, string] => [t, "<tmp>"]), [home, "~"]]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(scrubbed, null, 2)}\n`);

  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
  console.log(`agent-answer ${version}: ${result.model}, Claude Code ${claudeVersion}`);
  for (const [style, a] of Object.entries(summary.by_style)) console.log(`  ${style.padEnd(17)} ${a!.correct}/${a!.n} correct (${pct(a!.accuracy)}), file recall ${pct(a!.file_recall)}`);
  console.log(`  ${"overall".padEnd(17)} ${summary.overall.correct}/${summary.overall.n} correct (${pct(summary.overall.accuracy)}), file recall ${pct(summary.overall.file_recall)}`);
  console.log(`  cost $${(summary.total_cost_usd + probeCost).toFixed(2)} (probe $${probeCost.toFixed(2)})${summary.cost_unknown_runs ? `, plus ${summary.cost_unknown_runs} run(s) of unknown cost` : ""}${result.partial ? `, partial` : ""} -> ${relative(ROOT, out)}`);
}

if (import.meta.main) main();
