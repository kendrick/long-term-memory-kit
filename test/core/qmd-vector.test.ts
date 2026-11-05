import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecallError, type Recall } from "../../src/core/qmd.ts";
import { qmdVectorBackend } from "../../src/core/qmd-vector.ts";
import type { ParsedRecord } from "../../src/core/record.ts";

const fakePkg = fileURLToPath(new URL("../fixtures/fake-qmd-package", import.meta.url));

// A stand-in qmd on a test-owned PATH: `skills path` points at the fake package, `collection show` at the fake root.
const FAKE_QMD = `#!/bin/sh
if [ "$1" = skills ]; then printf '%s/skills\\n' "$FAKE_PKG"; exit 0; fi
if [ "$1" = collection ]; then printf 'Collection: %s\\n  Path:     %s\\n' "$3" "$FAKE_ROOT"; exit 0; fi
exit 1
`;

const root = mkdtempSync(join(tmpdir(), "ltm-qmd-vector-"));
const bin = join(root, "bin");
const bank = join(root, "bank");
const decisions = join(bank, "_memory/decisions");
mkdirSync(bin);
mkdirSync(decisions, { recursive: true });
writeFileSync(join(bin, "qmd"), FAKE_QMD);
chmodSync(join(bin, "qmd"), 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const RECALL: Recall = { backend: "qmd", mode: "vector", collections: { Decision: "decisions" } };
const noWarn = (line: string) => {
  throw new Error(`unexpected warning: ${line}`);
};
const rec = (path: string, fm: Record<string, unknown> = {}): ParsedRecord => ({
  path,
  memoryType: "Decision",
  frontmatter: { memory_type: "Decision", status: "accepted", ...fm },
});

let n = 0;
function setup(vars: { status?: object; vec?: object; pkg?: string; path?: string; qmdConfig?: string } = {}) {
  const pkg = vars.pkg ?? fakePkg;
  const log = join(root, `log-${n}`);
  // Own config dir per run, so neither the fake nor the worker reads the user's ~/.config/qmd.
  const config = join(root, `config-${n++}`);
  if (vars.qmdConfig !== undefined) {
    mkdirSync(join(config, "qmd"), { recursive: true });
    writeFileSync(join(config, "qmd/index.yml"), vars.qmdConfig);
  }
  const env = {
    XDG_CONFIG_HOME: config,
    PATH: vars.path ?? `${bin}:${process.env.PATH}`,
    FAKE_PKG: pkg,
    FAKE_ROOT: decisions,
    FAKE_VEC: JSON.stringify(vars.vec ?? {}),
    FAKE_STATUS: JSON.stringify(vars.status ?? { decisions: { active: 9, pending: 0 } }),
    FAKE_LOG: log,
  };
  const createStores = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("createStore")).length : 0);
  return { env, createStores };
}

// A modified copy of the fake package, so the version and name checks run against real files.
function packageWith(manifest: object): string {
  const dir = join(root, `pkg-${n++}`);
  cpSync(fakePkg, dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  return dir;
}

describe("qmdVectorBackend.preflight", () => {
  test("returns null when every document is embedded", () => {
    expect(qmdVectorBackend(RECALL, bank, setup().env, noWarn).preflight()).toBeNull();
  });

  test("names the missing embeddings when pending equals active", () => {
    const { env } = setup({ status: { decisions: { active: 9, pending: 9 } } });
    expect(qmdVectorBackend(RECALL, bank, env, noWarn).preflight()).toBe(
      "recall.collections.Decision: qmd collection 'decisions' has no embeddings for qmd's current embedding model; run qmd embed",
    );
  });

  test("two documents sharing one unembedded hash count as no embeddings, not 1 of 2", () => {
    const { env } = setup({ status: { decisions: { active: 2, hashes: 1, pending: 1 } } });
    expect(qmdVectorBackend(RECALL, bank, env, noWarn).preflight()).toContain("has no embeddings");
  });

  test("checks embeddings against the model in qmd's config, as qmd embed does", () => {
    const status = { decisions: { active: 9, pending: 0, model: "hf:custom/embed.gguf" } };
    expect(qmdVectorBackend(RECALL, bank, setup({ status }).env, noWarn).preflight()).toContain("has no embeddings");
    const configured = setup({ status, qmdConfig: "models:\n  embed: hf:custom/embed.gguf\n" });
    expect(qmdVectorBackend(RECALL, bank, configured.env, noWarn).preflight()).toBeNull();
  });

  test("an empty collection gets the same message", () => {
    const { env } = setup({ status: { decisions: { active: 0, pending: 0 } } });
    expect(qmdVectorBackend(RECALL, bank, env, noWarn).preflight()).toContain("has no embeddings");
  });

  test("warns and goes on when only some documents need embedding", () => {
    const { env } = setup({ status: { decisions: { active: 9, pending: 2 } } });
    const warned: string[] = [];
    expect(qmdVectorBackend(RECALL, bank, env, (l) => warned.push(l)).preflight()).toBeNull();
    expect(warned).toEqual(["collection 'decisions': 2 of 9 documents need embedding; run qmd embed"]);
  });

  test("rejects a package that is not @tobilu/qmd", () => {
    const pkg = packageWith({ name: "other", version: "2.8.3" });
    expect(qmdVectorBackend(RECALL, bank, setup({ pkg }).env, noWarn).preflight()).toBe(`qmd at ${pkg} is not @tobilu/qmd`);
  });

  test("rejects a major version other than 2", () => {
    const pkg = packageWith({ name: "@tobilu/qmd", version: "3.0.0" });
    expect(qmdVectorBackend(RECALL, bank, setup({ pkg }).env, noWarn).preflight()).toBe(
      "recall.mode vector needs qmd 2.x, found 3.0.0",
    );
  });

  test("reports a qmd missing from PATH", () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    expect(qmdVectorBackend(RECALL, bank, setup({ path: empty }).env, noWarn).preflight()).toBe("qmd not found on PATH");
  });
});

describe("qmdVectorBackend.queryText", () => {
  const backend = qmdVectorBackend(RECALL, bank, setup().env, noWarn);
  test.each([
    [{ title: "Use Postgres", summary: "Because ACID" }, "Use Postgres. Because ACID"],
    [{ title: "Use Postgres" }, "Use Postgres"],
    [{ summary: "Because ACID" }, "Because ACID"],
    [{ title: "", summary: "  " }, null],
    [{}, null],
  ])("%j", (fm, expected) => {
    expect(backend.queryText!(rec("a.md", fm))).toBe(expected);
  });
});

describe("qmdVectorBackend.prefetch and search", () => {
  // preflight locates the package root the worker needs, as runDoctor will run it first.
  const ready = (vars: Parameters<typeof setup>[0] = {}) => {
    const s = setup(vars);
    const backend = qmdVectorBackend(RECALL, bank, s.env, noWarn);
    expect(backend.preflight()).toBeNull();
    return { ...s, backend };
  };
  const a = rec("_memory/decisions/a.md", { title: "Use Postgres", summary: "Because ACID" });
  const b = rec("_memory/decisions/b.md", { title: "Use SQLite" });
  const text = "Use Postgres. Because ACID";

  test("maps a hit to its candidate and drops one outside the collection", () => {
    const vec = { decisions: { [text]: [{ filepath: "qmd://decisions/b.md", score: 0.62 }, { filepath: "qmd://elsewhere/a.md", score: 0.9 }] } };
    const { backend } = ready({ vec });
    backend.prefetch([a, b]);
    expect(backend.search([a, b], text)).toEqual([{ record: b, score: 0.62 }]);
  });

  test("a query nobody prefetched is a miss", () => {
    const { backend } = ready();
    backend.prefetch([a]);
    expect(backend.search([a, b], "nothing")).toEqual([]);
  });

  test("a score outside -1..1 throws RecallError", () => {
    const vec = { decisions: { [text]: [{ filepath: "qmd://decisions/b.md", score: 1.5 }] } };
    const { backend } = ready({ vec });
    backend.prefetch([a, b]);
    expect(() => backend.search([a, b], text)).toThrow(RecallError);
  });

  test("runs the worker once for all Records", () => {
    const { backend, createStores } = ready();
    const before = createStores();
    backend.prefetch([a, b]);
    expect(createStores() - before).toBe(1);
  });
});
