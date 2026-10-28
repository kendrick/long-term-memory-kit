import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAnswer, scoreAnswer, type Question } from "../../scripts/eval-agent-answer.ts";

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
