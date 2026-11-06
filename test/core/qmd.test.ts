import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
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
if [ "$1" = collection ]; then
  if [ -n "$QMD_ROOT" ]; then printf 'Collection: %s\\n  Path:     %s\\n' "$3" "$QMD_ROOT"; fi
  exit "\${QMD_SHOW_STATUS:-0}"
fi
if [ "$1" = ls ]; then
  printf '%s' "$QMD_LS"
  if [ -n "$QMD_LS_ERR" ]; then printf '%s\\n' "$QMD_LS_ERR" >&2; fi
  exit "\${QMD_LS_STATUS:-0}"
fi
if [ -n "$QMD_OUT_FILE" ]; then /bin/cat "$QMD_OUT_FILE"; else printf '%s' "$QMD_OUT"; fi
if [ -n "$QMD_ERR" ]; then printf '%s\\n' "$QMD_ERR" >&2; fi
exit "\${QMD_STATUS:-0}"
`;

const root = mkdtempSync(join(tmpdir(), "ltm-qmd-"));
const bin = join(root, "bin");
const emptyBin = join(root, "empty");
// The Bank root qmdBackend gets, and the collection root the fake reports for "decisions".
const bank = join(root, "bank");
const decisions = join(bank, "_memory/decisions");
mkdirSync(bin);
mkdirSync(emptyBin);
mkdirSync(decisions, { recursive: true });
writeFileSync(join(bin, "qmd"), FAKE_QMD);
chmodSync(join(bin, "qmd"), 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

let logN = 0;
function fake(vars: Record<string, string> = {}) {
  const log = join(root, `log-${logN++}`);
  const env = { PATH: bin, QMD_LOG: log, QMD_OUT: "[]", QMD_ROOT: decisions, ...vars };
  const argv = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { env, argv };
}

const config = (raw: Record<string, unknown>): BankConfig => ({ root: "/bank", folders: DEFAULT_FOLDERS, raw });

const rec = (path: string, memory_type = "Decision", memoryType: ParsedRecord["memoryType"] = "Decision"): ParsedRecord => ({
  path,
  memoryType,
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
    const recall = { backend: "qmd", mode: "search", collections: { Decision: "decisions", Context: "ctx" } };
    expect(loadRecall(config({ recall }))).toEqual({
      backend: "qmd",
      mode: "search",
      collections: { Decision: "decisions", Context: "ctx" },
    });
  });

  test("mode vector parses when doctor.near_duplicate_threshold is set", () => {
    const recall = { backend: "qmd", mode: "vector", collections: { Decision: "decisions" } };
    expect(loadRecall(config({ recall, doctor: { near_duplicate_threshold: 0.6 } }))).toEqual({
      backend: "qmd",
      mode: "vector",
      collections: { Decision: "decisions" },
    });
  });

  test("mode vector without doctor.near_duplicate_threshold is an error naming the key", () => {
    const recall = { backend: "qmd", mode: "vector", collections: { Decision: "decisions" } };
    expect(loadRecall(config({ recall }))).toEqual({
      error: "doctor.near_duplicate_threshold is required when recall.mode is vector",
    });
  });

  const errors: [string, unknown, string][] = [
    ["null", null, "recall is not a mapping"],
    ["a string", "qmd", "recall is not a mapping"],
    ["a list", ["qmd"], "recall is not a mapping"],
    ["an unknown key", { backend: "qmd", index: "x", mode: "search", collections: { Decision: "d" } }, "recall.index: unknown key"],
    ["another backend", { backend: "lexical", mode: "search", collections: { Decision: "d" } }, "recall.backend must be qmd"],
    ["no backend", { mode: "search", collections: { Decision: "d" } }, "recall.backend must be qmd"],
    ["mode query", { backend: "qmd", mode: "query", collections: { Decision: "d" } }, 'recall.mode must be search or vector, not "query"'],
    ["mode vsearch", { backend: "qmd", mode: "vsearch", collections: { Decision: "d" } }, 'recall.mode must be search or vector, not "vsearch"'],
    ["no mode", { backend: "qmd", collections: { Decision: "d" } }, "recall.mode must be search or vector, not undefined"],
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
  test("sends the tokenized text to qmd search in the type's collection, after reading its root once", () => {
    const { env, argv } = fake();
    const backend = qmdBackend(RECALL, bank, env, noWarn);
    backend.search([rec("_memory/decisions/a.md")], 'Order-service "publishes');
    backend.search([rec("_memory/decisions/a.md")], "billing");
    expect(argv()).toBe(
      "collection\nshow\ndecisions\n--\nsearch\norder service publishes\n--json\n--all\n-c\ndecisions\n--\nsearch\nbilling\n--json\n--all\n-c\ndecisions\n--\n",
    );
  });

  test("after preflight, search reuses the root preflight read", () => {
    const { env, argv } = fake();
    const backend = qmdBackend(RECALL, bank, env, noWarn);
    expect(backend.preflight()).toBeNull();
    backend.search([rec("_memory/decisions/a.md")], "orders");
    expect(argv()).toBe("collection\nshow\ndecisions\n--\nsearch\norders\n--json\n--all\n-c\ndecisions\n--\n");
  });

  test("a hit maps to the candidate at its path, and a hit matching no candidate drops", () => {
    const target = rec("_memory/decisions/x-aB3cD4eF5g.md");
    const other = rec("_memory/decisions/y-zZ9yY8xX7w.md");
    const out = JSON.stringify([
      { score: 0.93, file: "qmd://decisions/x-aB3cD4eF5g.md?index=t" },
      { score: 0.91, file: "qmd://decisions/nowhere-0000000000.md" },
    ]);
    const { env } = fake({ QMD_OUT: out });
    const hits = qmdBackend(RECALL, bank, env, noWarn).search([target, other], "orders");
    expect(hits).toEqual([{ record: target, score: 0.93 }]);
  });

  test("a filename containing ? still maps, with and without qmd's ?index= suffix", () => {
    const why = rec("_memory/decisions/why?not.md");
    const out = JSON.stringify([
      { score: 0.93, file: "qmd://decisions/why?not.md" },
      { score: 0.92, file: "qmd://decisions/why?not.md?index=t%20x" },
    ]);
    const { env } = fake({ QMD_OUT: out });
    expect(qmdBackend(RECALL, bank, env, noWarn).search([why], "why")).toEqual([
      { record: why, score: 0.93 },
      { record: why, score: 0.92 },
    ]);
  });

  test("output past Bun's default 1 MiB maxBuffer still maps", () => {
    const target = rec("_memory/decisions/x-aB3cD4eF5g.md");
    const hits = Array.from({ length: 12000 }, (_, i) => ({ score: 0.5, file: `qmd://decisions/crowding-record-${i}-${"p".repeat(60)}.md` }));
    hits.push({ score: 0.93, file: "qmd://decisions/x-aB3cD4eF5g.md" });
    const outFile = join(root, "big.json");
    writeFileSync(outFile, JSON.stringify(hits));
    expect(readFileSync(outFile).length).toBeGreaterThan(1024 * 1024);
    const { env } = fake({ QMD_OUT_FILE: outFile });
    expect(qmdBackend(RECALL, bank, env, noWarn).search([target], "orders")).toEqual([{ record: target, score: 0.93 }]);
  });

  // While _memory/decisions/topic.md is the query, nearDuplicate leaves it out of the candidates, so its self-hit must not land on nested/topic.md.
  const nested = rec("_memory/decisions/nested/topic.md");
  test("a self-hit for topic.md never maps to nested/topic.md", () => {
    const { env } = fake({ QMD_OUT: JSON.stringify([{ score: 0.97, file: "qmd://decisions/topic.md" }]) });
    expect(qmdBackend(RECALL, bank, env, noWarn).search([nested], "topic")).toEqual([]);
  });

  test("a hit for nested/topic.md maps to that candidate", () => {
    const { env } = fake({ QMD_OUT: JSON.stringify([{ score: 0.97, file: "qmd://decisions/nested/topic.md" }]) });
    expect(qmdBackend(RECALL, bank, env, noWarn).search([nested], "topic")).toEqual([{ record: nested, score: 0.97 }]);
  });

  test("no spawn for no records, a type with no collection, or text with no tokens", () => {
    const { env, argv } = fake();
    const backend = qmdBackend(RECALL, bank, env, noWarn);
    expect(backend.search([], "orders")).toEqual([]);
    expect(backend.search([rec("_memory/context/c.md", "Context", "Context")], "orders")).toEqual([]);
    expect(backend.search([rec("_memory/decisions/a.md")], "")).toEqual([]);
    expect(argv()).toBe("");
  });

  test("a nonzero exit throws RecallError with qmd's first stderr line", () => {
    const { env } = fake({ QMD_STATUS: "1", QMD_OUT: "", QMD_ERR: "Collection not found: decisions" });
    const run = () => qmdBackend(RECALL, bank, env, noWarn).search([rec("_memory/decisions/a.md")], "orders");
    expect(run).toThrow(RecallError);
    expect(run).toThrow("qmd search failed: Collection not found: decisions");
  });

  test("a stderr line on a zero exit warns once per backend", () => {
    const warning = "Warning: 9 documents (100%) need embeddings. Run 'qmd embed' for better results.";
    const { env } = fake({ QMD_ERR: warning });
    const warned: string[] = [];
    const backend = qmdBackend(RECALL, bank, env, (line) => warned.push(line));
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
      const run = () => qmdBackend(RECALL, bank, env, noWarn).search([rec("_memory/decisions/a.md")], "orders");
      expect(run).toThrow(RecallError);
      expect(run).toThrow(message);
    });
  }
});

describe("qmdBackend.preflight", () => {
  test("no qmd on PATH", () => {
    const { env } = fake();
    expect(qmdBackend(RECALL, bank, { ...env, PATH: emptyBin }, noWarn).preflight()).toBe("qmd not found on PATH");
  });

  test("a missing collection names its memory_type and name", () => {
    const { env, argv } = fake({ QMD_SHOW_STATUS: "1" });
    expect(qmdBackend(RECALL, bank, env, noWarn).preflight()).toBe("recall.collections.Decision: qmd has no collection 'decisions'");
    expect(argv()).toBe("collection\nshow\ndecisions\n--\n");
  });

  test("a collection show with no Path line names the collection", () => {
    const { env } = fake({ QMD_ROOT: "" });
    expect(qmdBackend(RECALL, bank, env, noWarn).preflight()).toBe(
      "recall.collections.Decision: qmd collection show 'decisions' printed no Path",
    );
    const run = () => qmdBackend(RECALL, bank, env, noWarn).search([rec("_memory/decisions/a.md")], "orders");
    expect(run).toThrow(RecallError);
    expect(run).toThrow("recall.collections.Decision: qmd collection show 'decisions' printed no Path");
  });

  test("a collection whose Path no longer exists names it instead of crashing", () => {
    const gone = join(root, "gone");
    const { env } = fake({ QMD_ROOT: gone });
    const message = `recall.collections.Decision: qmd collection 'decisions' points at ${gone}, which does not exist`;
    expect(qmdBackend(RECALL, bank, env, noWarn).preflight()).toBe(message);
    const run = () => qmdBackend(RECALL, bank, env, noWarn).search([rec("_memory/decisions/a.md")], "orders");
    expect(run).toThrow(RecallError);
    expect(run).toThrow(message);
  });

  test("search without preflight throws the missing-collection message", () => {
    const { env } = fake({ QMD_SHOW_STATUS: "1" });
    const run = () => qmdBackend(RECALL, bank, env, noWarn).search([rec("_memory/decisions/a.md")], "orders");
    expect(run).toThrow(RecallError);
    expect(run).toThrow("recall.collections.Decision: qmd has no collection 'decisions'");
  });

  test("every collection present gives null, checked in memory_type order", () => {
    const { env, argv } = fake();
    const recall: Recall = { ...RECALL, collections: { PolicyRule: "rules", Context: "ctx", Decision: "decisions" } };
    expect(qmdBackend(recall, bank, env, noWarn).preflight()).toBeNull();
    expect(argv()).toBe("collection\nshow\nctx\n--\ncollection\nshow\ndecisions\n--\ncollection\nshow\nrules\n--\n");
  });
});

describe("qmdBackend.indexed and collectionOf", () => {
  const backend = (env: Record<string, string>) => qmdBackend(RECALL, bank, env, noWarn);

  test("indexed joins each listed file onto the collection root and runs qmd ls", () => {
    const QMD_LS = "   1.2 KB  Nov  5 10:00  qmd://decisions/a.md\n  900 B  Nov  5 10:01  qmd://decisions/sub/b.md\n";
    const { env, argv } = fake({ QMD_LS });
    expect(backend(env).indexed("decisions")).toEqual(
      new Set([join(realpathSync(decisions), "a.md"), join(realpathSync(decisions), "sub/b.md")]),
    );
    expect(argv()).toContain("ls\ndecisions\n--\n");
  });

  test("an empty collection gives an empty set", () => {
    const { env } = fake({ QMD_LS: "No files found in collection: decisions\n" });
    expect(backend(env).indexed("decisions")).toEqual(new Set());
  });

  test("a failing qmd ls throws RecallError with qmd's message", () => {
    const { env } = fake({ QMD_LS_STATUS: "1", QMD_LS_ERR: "Collection not found: decisions" });
    const run = () => backend(env).indexed("decisions");
    expect(run).toThrow(RecallError);
    expect(run).toThrow("Collection not found");
  });

  test("collectionOf maps a Record's folder-derived memory_type to its collection", () => {
    const b = backend(fake().env);
    expect(b.collectionOf(rec("_memory/decisions/a.md"))).toBe("decisions");
    expect(b.collectionOf(rec("_memory/x.md", "Context", "Context"))).toBeUndefined();
  });

  test("collectionOf follows the folder, not a drifted frontmatter memory_type", () => {
    const b = backend(fake().env);
    expect(b.collectionOf(rec("_memory/decisions/a.md", "Context", "Decision"))).toBe("decisions");
    expect(b.collectionOf(rec("_memory/context/a.md", "Decision", "Context"))).toBeUndefined();
  });
});
