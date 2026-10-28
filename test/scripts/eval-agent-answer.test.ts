import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAnswer, scoreAnswer, type Question } from "../../scripts/eval-agent-answer.ts";
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
