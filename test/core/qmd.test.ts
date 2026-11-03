import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FOLDERS, type BankConfig } from "../../src/core/bank.ts";
import { loadRecall, qmdBackend, RecallError, type Recall } from "../../src/core/qmd.ts";
import type { ParsedRecord } from "../../src/core/record.ts";

// A stand-in qmd on a test-owned PATH, so no test runs the real binary or touches the user's index.
const FAKE_QMD = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$QMD_LOG"; done
printf -- '--\\n' >> "$QMD_LOG"
if [ "$1" = collection ]; then exit "\${QMD_SHOW_STATUS:-0}"; fi
printf '%s' "$QMD_OUT"
if [ -n "$QMD_ERR" ]; then printf '%s\\n' "$QMD_ERR" >&2; fi
exit "\${QMD_STATUS:-0}"
`;

const root = mkdtempSync(join(tmpdir(), "ltm-qmd-"));
const bin = join(root, "bin");
const emptyBin = join(root, "empty");
mkdirSync(bin);
mkdirSync(emptyBin);
writeFileSync(join(bin, "qmd"), FAKE_QMD);
chmodSync(join(bin, "qmd"), 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

let logN = 0;
function fake(vars: Record<string, string> = {}) {
  const log = join(root, `log-${logN++}`);
  const env = { PATH: bin, QMD_LOG: log, QMD_OUT: "[]", ...vars };
  const argv = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { env, argv };
}

const config = (raw: Record<string, unknown>): BankConfig => ({ root: "/bank", folders: DEFAULT_FOLDERS, raw });

const rec = (path: string, memory_type = "Decision"): ParsedRecord => ({
  path,
  memoryType: "Decision",
  frontmatter: { memory_type, status: "accepted" },
});

const RECALL: Recall = { backend: "qmd", mode: "search", collections: { Decision: "decisions" } };
const noWarn = (line: string) => {
  throw new Error(`unexpected warning: ${line}`);
};

describe("loadRecall", () => {
  test("no recall: key gives null", () => {
    expect(loadRecall(config({}))).toBeNull();
  });

  test("the valid shape round-trips", () => {
    const recall = { backend: "qmd", mode: "vsearch", collections: { Decision: "decisions", Context: "ctx" } };
    expect(loadRecall(config({ recall }))).toEqual({
      backend: "qmd",
      mode: "vsearch",
      collections: { Decision: "decisions", Context: "ctx" },
    });
  });

  const errors: [string, unknown, string][] = [
    ["null", null, "recall is not a mapping"],
    ["a string", "qmd", "recall is not a mapping"],
    ["a list", ["qmd"], "recall is not a mapping"],
    ["an unknown key", { backend: "qmd", index: "x", mode: "search", collections: { Decision: "d" } }, "recall.index: unknown key"],
    ["another backend", { backend: "lexical", mode: "search", collections: { Decision: "d" } }, "recall.backend must be qmd"],
    ["no backend", { mode: "search", collections: { Decision: "d" } }, "recall.backend must be qmd"],
    ["mode query", { backend: "qmd", mode: "query", collections: { Decision: "d" } }, 'recall.mode must be search or vsearch, not "query"'],
    ["no mode", { backend: "qmd", collections: { Decision: "d" } }, "recall.mode must be search or vsearch, not undefined"],
    ["empty collections", { backend: "qmd", mode: "search", collections: {} }, "recall.collections must map a memory_type to a qmd collection"],
    ["list collections", { backend: "qmd", mode: "search", collections: ["d"] }, "recall.collections must map a memory_type to a qmd collection"],
    ["no collections", { backend: "qmd", mode: "search" }, "recall.collections must map a memory_type to a qmd collection"],
    ["an unknown memory_type", { backend: "qmd", mode: "search", collections: { Decision: "d", Rule: "r" } }, "recall.collections.Rule: unknown memory_type"],
    ["an empty name", { backend: "qmd", mode: "search", collections: { Decision: "" } }, "recall.collections.Decision must be a collection name"],
    ["a numeric name", { backend: "qmd", mode: "search", collections: { Context: 7 } }, "recall.collections.Context must be a collection name"],
  ];
  for (const [name, recall, error] of errors) {
    test(`${name}: ${error}`, () => {
      expect(loadRecall(config({ recall }))).toEqual({ error });
    });
  }
});

describe("qmdBackend.search", () => {
  test("sends the tokenized text to qmd search in the type's collection", () => {
    const { env, argv } = fake();
    qmdBackend(RECALL, env, noWarn).search([rec("_memory/decisions/a.md")], 'Order-service "publishes');
    expect(argv()).toBe("search\norder service publishes\n--json\n--all\n-c\ndecisions\n--\n");
  });

  test("vsearch mode sends vsearch", () => {
    const { env, argv } = fake();
    qmdBackend({ ...RECALL, mode: "vsearch" }, env, noWarn).search([rec("_memory/decisions/a.md")], "Order-service");
    expect(argv()).toBe("vsearch\norder service\n--json\n--all\n-c\ndecisions\n--\n");
  });

  test("a hit maps to the candidate at its path, and a hit matching no candidate drops", () => {
    const target = rec("_memory/decisions/x-aB3cD4eF5g.md");
    const other = rec("_memory/decisions/y-zZ9yY8xX7w.md");
    const out = JSON.stringify([
      { score: 0.93, file: "qmd://decisions/x-aB3cD4eF5g.md?index=t" },
      { score: 0.91, file: "qmd://decisions/nowhere-0000000000.md" },
    ]);
    const { env } = fake({ QMD_OUT: out });
    const hits = qmdBackend(RECALL, env, noWarn).search([target, other], "orders");
    expect(hits).toEqual([{ record: target, score: 0.93 }]);
  });

  test("no spawn for no records, a type with no collection, or text with no tokens", () => {
    const { env, argv } = fake();
    const backend = qmdBackend(RECALL, env, noWarn);
    expect(backend.search([], "orders")).toEqual([]);
    expect(backend.search([rec("_memory/context/c.md", "Context")], "orders")).toEqual([]);
    expect(backend.search([rec("_memory/decisions/a.md")], "")).toEqual([]);
    expect(argv()).toBe("");
  });

  test("a nonzero exit throws RecallError with qmd's first stderr line", () => {
    const { env } = fake({ QMD_STATUS: "1", QMD_OUT: "", QMD_ERR: "Collection not found: decisions" });
    const run = () => qmdBackend(RECALL, env, noWarn).search([rec("_memory/decisions/a.md")], "orders");
    expect(run).toThrow(RecallError);
    expect(run).toThrow("qmd search failed: Collection not found: decisions");
  });

  test("a stderr line on a zero exit warns once per backend", () => {
    const warning = "Warning: 9 documents (100%) need embeddings. Run 'qmd embed' for better results.";
    const { env } = fake({ QMD_ERR: warning });
    const warned: string[] = [];
    const backend = qmdBackend({ ...RECALL, mode: "vsearch" }, env, (line) => warned.push(line));
    backend.search([rec("_memory/decisions/a.md")], "orders");
    backend.search([rec("_memory/decisions/b.md")], "billing");
    expect(warned).toEqual([warning]);
  });

  const unreadable: [string, string, string][] = [
    ["score 1.5", '[{"score":1.5,"file":"qmd://decisions/a.md"}]', "qmd search returned score 1.5 for qmd://decisions/a.md"],
    ["a string score", '[{"score":"0.9","file":"qmd://decisions/a.md"}]', 'qmd search returned score "0.9" for qmd://decisions/a.md'],
    ["stdout that isn't JSON", "not json", "qmd search returned an unreadable result"],
  ];
  for (const [name, out, message] of unreadable) {
    test(`${name} throws RecallError`, () => {
      const { env } = fake({ QMD_OUT: out });
      const run = () => qmdBackend(RECALL, env, noWarn).search([rec("_memory/decisions/a.md")], "orders");
      expect(run).toThrow(RecallError);
      expect(run).toThrow(message);
    });
  }
});

describe("qmdBackend.preflight", () => {
  test("no qmd on PATH", () => {
    const { env } = fake();
    expect(qmdBackend(RECALL, { ...env, PATH: emptyBin }, noWarn).preflight()).toBe("qmd not found on PATH");
  });

  test("a missing collection names its memory_type and name", () => {
    const { env, argv } = fake({ QMD_SHOW_STATUS: "1" });
    expect(qmdBackend(RECALL, env, noWarn).preflight()).toBe("recall.collections.Decision: qmd has no collection 'decisions'");
    expect(argv()).toBe("collection\nshow\ndecisions\n--\n");
  });

  test("every collection present gives null, checked in memory_type order", () => {
    const { env, argv } = fake();
    const recall: Recall = { ...RECALL, collections: { PolicyRule: "rules", Context: "ctx", Decision: "decisions" } };
    expect(qmdBackend(recall, env, noWarn).preflight()).toBeNull();
    expect(argv()).toBe("collection\nshow\nctx\n--\ncollection\nshow\ndecisions\n--\ncollection\nshow\nrules\n--\n");
  });
});
