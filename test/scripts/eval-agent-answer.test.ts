import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregate, authProblem, extractAnswer, parseCli, probeProblems, RUN_BUDGET_USD, runCost, scoreAnswer, spawnOutput, type Question, type Row } from "../../scripts/eval-agent-answer.ts";
import { loadConfig } from "../../src/core/bank.ts";
import { listRecords } from "../../src/core/query.ts";

const BANK = "/tmp/ltm-eval-bank";
const load = (name: string) => extractAnswer(readFileSync(join(import.meta.dir, "../fixtures/agent-answer", name), "utf8"), BANK);

const PG = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const MY = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";
const update: Question = {
  id: "ku-db",
  style: "knowledge-update",
  question: "Which database do new services use?",
  gold_ids: ["kQ7vN2xLp4"],
  forbidden_ids: ["mB3tR9wZe1"],
  gold_files: [PG],
};
const abstain: Question = { id: "ab-1", style: "abstention", question: "Which cloud do we run on?", gold_ids: [], forbidden_ids: [], gold_files: [] };

describe("scoring", () => {
  test("(a) citing the gold id is correct", () => {
    const s = scoreAnswer(update, load("cites-gold.jsonl"));
    expect(s.correct).toBe(true);
    expect(s.fileRecall).toBe(1);
  });
  test("(b) adding the forbidden superseded id is incorrect, prose unchanged", () => {
    const a = load("cites-gold.jsonl");
    const b = load("cites-forbidden.jsonl");
    expect(b.answer).toBe(a.answer);
    expect(b.cited).toEqual(["kQ7vN2xLp4", "mB3tR9wZe1"]);
    expect(scoreAnswer(update, b).correct).toBe(false);
  });
  test("(c) same CITED line with opposite prose is still correct", () => {
    const c = load("cites-gold-opposite-prose.jsonl");
    expect(c.answer).not.toBe(load("cites-gold.jsonl").answer);
    expect(scoreAnswer(update, c).correct).toBe(true);
  });
  test("(d) abstention: NONE is correct, any id is incorrect, recall is null", () => {
    const none = scoreAnswer(abstain, load("abstain-none.jsonl"));
    expect(none.correct).toBe(true);
    expect(none.fileRecall).toBeNull();
    expect(scoreAnswer(abstain, load("abstain-cites.jsonl")).correct).toBe(false);
  });
  test("a missing CITED line is incorrect, for both kinds of question", () => {
    const t = load("no-cited-line.jsonl");
    expect(t.cited).toBeNull();
    expect(scoreAnswer(update, t).correct).toBe(false);
    expect(scoreAnswer(abstain, t).correct).toBe(false);
  });
});

describe("file-read extraction", () => {
  test("Read, Bash ltm head and MCP query count; a grep that printed only paths does not", () => {
    const t = load("extraction.jsonl");
    expect([...t.filesRead].sort()).toEqual(
      [PG, MY, "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md"].sort(),
    );
  });
});

describe("file-read extraction of MCP head by id and compound Bash", () => {
  const IDS = new Map([["kQ7vN2xLp4", PG]]);
  const raw = readFileSync(join(import.meta.dir, "../fixtures/agent-answer/compound-reads.jsonl"), "utf8");
  test("head by id resolves through the id map; cd re-roots each && / ; segment; head -n counts like cat", () => {
    expect([...extractAnswer(raw, BANK, IDS).filesRead].sort()).toEqual(
      [
        PG,
        MY,
        "_memory/policy-rules/structured-json-logging-vD8mH3zQb5.md",
        "_memory/decisions/ulid-order-identifiers-uL5eX1pJd8.md",
        "_memory/decisions/sequential-order-numbers-sQ9dW3nHc6.md",
      ].sort(),
    );
  });
  test("without the id map, head by id counts as nothing", () => {
    expect(extractAnswer(raw, BANK).filesRead).not.toContain(PG);
  });
});

describe("file-read extraction on a real transcript", () => {
  // Trimmed from a real 2.1.311 run: two Reads of a path that didn't exist and a failed MCP facets call came back is_error.
  test("errored tool results count as no read; a JSON MCP query result does", () => {
    const t = load("real-errored-reads.jsonl");
    expect([...t.filesRead].sort()).toEqual([
      "_memory/policy-rules/no-cross-service-db-reads-cA9wE6uJr3.md",
      "_memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md",
      "_memory/policy-rules/shared-sftp-for-partner-files-yF4kP7tNs2.md",
      "_memory/policy-rules/structured-json-logging-vD8mH3zQb5.md",
    ]);
  });
});

describe("file-read extraction of Bash ltm query --json", () => {
  // Real CLI stdout: inside a Bank `ltm query --json` prints a bare array; with --bank or from a Consumer repo it prints {results:[…]}.
  test("both CLI shapes count every path they list", () => {
    expect([...load("cli-query-json.jsonl").filesRead].sort()).toEqual([
      "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md",
      "_memory/decisions/ulid-order-identifiers-uL5eX1pJd8.md",
    ]);
  });
});

describe("questions.json", () => {
  const BANK_ROOT = join(import.meta.dir, "../../fixtures/demo-bank");
  const questions = JSON.parse(
    readFileSync(join(import.meta.dir, "../../evals/agent-answer/questions.json"), "utf8"),
  ) as Question[];
  // Ids and statuses come from the Records' own frontmatter so a renamed or re-statused fixture breaks this test.
  const records = listRecords(loadConfig(BANK_ROOT), () => {});
  const byId = new Map(records.map((r) => [String(r.frontmatter.id), r]));
  const byPath = new Map(records.map((r) => [r.path, r]));

  test("35 questions, 7 per style, unique ids", () => {
    expect(questions).toHaveLength(35);
    const counts: Record<string, number> = {};
    for (const q of questions) counts[q.style] = (counts[q.style] ?? 0) + 1;
    expect(counts).toEqual({
      "single-hop": 7,
      "multi-session": 7,
      temporal: 7,
      "knowledge-update": 7,
      abstention: 7,
    });
    expect(new Set(questions.map((q) => q.id)).size).toBe(35);
  });

  test("every gold and forbidden id is a Record in the demo Bank", () => {
    const missing = questions.flatMap((q) =>
      [...q.gold_ids, ...q.forbidden_ids]
        .filter((id) => !byId.has(id))
        .map((id) => `${q.id}: ${id}`),
    );
    expect(missing).toEqual([]);
  });

  test("every gold file exists and belongs to one of the question's gold ids", () => {
    for (const q of questions) {
      for (const f of q.gold_files) {
        expect(existsSync(join(BANK_ROOT, f))).toBe(true);
        expect(q.gold_ids).toContain(String(byPath.get(f)?.frontmatter.id));
      }
    }
  });

  test("every knowledge-update question forbids a superseded Record", () => {
    for (const q of questions.filter((q) => q.style === "knowledge-update")) {
      expect(q.forbidden_ids.some((id) => byId.get(id)?.frontmatter.status === "superseded")).toBe(
        true,
      );
    }
  });

  test("every temporal question names a YYYY-MM-DD reference date", () => {
    for (const q of questions.filter((q) => q.style === "temporal"))
      expect(q.question).toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  test("abstention questions have no gold ids or files", () => {
    for (const q of questions.filter((q) => q.style === "abstention")) {
      expect(q.gold_ids).toEqual([]);
      expect(q.gold_files).toEqual([]);
    }
  });
});

describe("isolation probe", () => {
  const raw = (name: string) => readFileSync(join(import.meta.dir, "../fixtures/agent-answer", name), "utf8");
  // Both fixtures are trimmed from real Claude Code 2.1.311 runs under a temp CLAUDE_CONFIG_DIR.
  test("--strict-mcp-config drops the plugin's MCP server, and a logged-out run fails", () => {
    expect(probeProblems(raw("probe-strict-mcp-not-logged-in.jsonl"))).toEqual([
      "MCP server plugin:ltm:ltm not listed",
      "run failed: Not logged in · Please run /login",
    ]);
  });
  test("builtin plugins don't count as other plugins; only the failed run does", () => {
    expect(probeProblems(raw("probe-no-strict-mcp-not-logged-in.jsonl"))).toEqual(["run failed: Not logged in · Please run /login"]);
  });
  test("passes only with no leak: another plugin, MCP server, plugin error or memory path each fail it", () => {
    const [init, result] = raw("probe-no-strict-mcp-not-logged-in.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    const ok = { ...result, is_error: false, result: "fine" };
    const run = (patch: object) => [JSON.stringify({ ...init, ...patch }), JSON.stringify(ok)].join("\n");
    expect(probeProblems(run({}))).toEqual([]);
    expect(probeProblems(run({ plugins: [...init.plugins, { name: "superpowers", path: "/x" }] }))).toEqual(["other plugins loaded: superpowers"]);
    // Only the three named builtins are allowed; a new builtin still fails.
    expect(probeProblems(run({ plugins: [...init.plugins, { name: "cc-plugin-new", path: "builtin" }] }))).toEqual(["other plugins loaded: cc-plugin-new"]);
    expect(probeProblems(run({ mcp_servers: [...init.mcp_servers, { name: "context7", status: "connected" }] }))).toEqual(["other MCP servers loaded: context7"]);
    expect(probeProblems(run({ plugin_errors: [{ plugin: "ltm" }] }))).toHaveLength(1);
    expect(probeProblems(run({ memory_paths: ["~/.claude/CLAUDE.md"] }))).toHaveLength(1);
    expect(probeProblems(run({ plugins: init.plugins.slice(1) }))).toEqual(["plugin ltm not loaded"]);
    expect(probeProblems(run({ mcp_servers: [{ name: "plugin:ltm:ltm", status: "failed" }] }))).toEqual(["MCP server plugin:ltm:ltm is failed"]);
    expect(probeProblems(JSON.stringify(ok))).toEqual(["no system/init event"]);
  });
});

describe("runner helpers", () => {
  test("auth: fails with neither key nor OAuth token, so a run never falls back to the real config dir", () => {
    expect(authProblem({})).toBeString();
    expect(authProblem({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" })).toBeString();
    expect(authProblem({ CLAUDE_CODE_OAUTH_TOKEN: "x" })).toBeUndefined();
    expect(authProblem({ ANTHROPIC_API_KEY: "x" })).toBeUndefined();
  });
  test("--limit must be a positive integer", () => {
    expect(parseCli(["--limit", "3"]).limit).toBe(3);
    expect(parseCli([]).limit).toBeUndefined();
    expect(() => parseCli(["--limit", "0"])).toThrow();
    expect(() => parseCli(["--limit", "2.5"])).toThrow();
  });
  test("runCost: a result event's total_cost_usd is the cost; without one the cost is unknown and the guard charges the per-run cap", () => {
    const raw = readFileSync(join(import.meta.dir, "../fixtures/agent-answer/extraction.jsonl"), "utf8");
    expect(runCost(raw)).toEqual({ cost_usd: 0.1944172, charged_usd: 0.1944172 });
    const killed = raw.trim().split("\n").filter((l) => JSON.parse(l).type !== "result").join("\n");
    expect(runCost(killed)).toEqual({ cost_usd: null, charged_usd: 0.5 });
    expect(RUN_BUDGET_USD).toBe(0.5);
  });
  test("aggregate: per-style accuracy, recall averaged only over non-null, cost summed", () => {
    const row = (id: string, style: Row["style"], correct: boolean, file_recall: number | null, cost_usd: number | null): Row => ({ id, style, correct, answer: "", cited: [], file_recall, cost_usd, plugin_loaded: true, files_read: [] });
    const a = aggregate([row("a", "single-hop", true, 1, 0.1), row("b", "single-hop", false, 0, 0.2), row("c", "abstention", true, null, 0.3)]);
    expect(a.by_style["single-hop"]).toEqual({ n: 2, correct: 1, accuracy: 0.5, file_recall: 0.5 });
    expect(a.by_style.abstention).toEqual({ n: 1, correct: 1, accuracy: 1, file_recall: null });
    expect(a.overall).toEqual({ n: 3, correct: 2, accuracy: 2 / 3, file_recall: 0.5 });
    expect(a.total_cost_usd).toBeCloseTo(0.6);
    expect(a.cost_unknown_runs).toBe(0);
  });
  test("aggregate: an unknown cost adds nothing to total_cost_usd and is counted in cost_unknown_runs", () => {
    const row = (id: string, cost_usd: number | null): Row => ({ id, style: "single-hop", correct: true, answer: "", cited: [], file_recall: 1, cost_usd, plugin_loaded: true, files_read: [] });
    const a = aggregate([row("a", 0.1), row("b", null)]);
    expect(a.total_cost_usd).toBeCloseTo(0.1);
    expect(a.cost_unknown_runs).toBe(1);
  });
});

describe("spawnOutput", () => {
  const partial = '{"type":"system","subtype":"init"}\n';
  test("a timeout keeps its partial stdout and reads as unknown cost", () => {
    const err = Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" });
    const o = spawnOutput({ error: err, stdout: partial, stderr: "" });
    expect(o.stream).toBe(partial);
    expect(runCost(o.stream)).toEqual({ cost_usd: null, charged_usd: RUN_BUDGET_USD });
  });
  test("a signal kill (no error) keeps its stdout; null output becomes empty", () => {
    expect(spawnOutput({ stdout: partial, stderr: null }).stream).toBe(partial);
    expect(spawnOutput({ stdout: null, stderr: null })).toEqual({ stream: "", stderr: "" });
  });
  test("a launch failure throws", () => {
    const err = Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
    expect(() => spawnOutput({ error: err, stdout: null, stderr: null })).toThrow("ENOENT");
  });
});
