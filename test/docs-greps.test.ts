import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const demo = join(repo, "fixtures/demo-bank");
const FALSIFIER_PREFIX = "_grep-falsifier-";
const MIN_GREPS = 8;

type Grep = { file: string; line: number; command: string };

function markdownUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownUnder(p));
    // The falsifier test writes and removes one of these; skipping them keeps a leftover from a
    // crashed run (or a concurrent one) out of the real collection.
    else if (e.name.endsWith(".md") && !e.name.startsWith(FALSIFIER_PREFIX)) out.push(p);
  }
  return out;
}

// Only a bare ```sh fence counts, and any other fence (```text, ```json) hides its lines, so
// a doc can show a failing grep as an example without the test running it.
function collect(path: string, text: string): Grep[] {
  const found: Grep[] = [];
  let fence: "sh" | "other" | null = null;
  text.split("\n").forEach((line, i) => {
    if (fence === null) {
      if (line === "```sh") fence = "sh";
      else if (line.startsWith("```")) fence = "other";
      return;
    }
    if (line.trim() === "```") fence = null;
    else if (fence === "sh" && line.startsWith("grep ")) {
      found.push({ file: relative(repo, path), line: i + 1, command: line });
    }
  });
  return found;
}

const collectAll = (): Grep[] =>
  ["docs", "guide", "skills"].flatMap((d) => markdownUnder(join(repo, d))).flatMap((f) =>
    collect(f, readFileSync(f, "utf8")),
  );

let scratch: string;
beforeAll(() => {
  // One copy per file: greps only read, so they can share it.
  scratch = mkdtempSync(join(tmpdir(), "ltm-docs-greps-"));
  cpSync(demo, scratch, { recursive: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Empty stdout fails even on exit 0: an example that prints nothing teaches nothing, and
// usually means a fixture id or path went stale.
function failure(g: Grep): string | null {
  const r = spawnSync("sh", ["-c", g.command], { cwd: scratch, encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim() !== "") return null;
  return `${g.file}:${g.line}: ${g.command}\nexit ${r.status}, stdout ${r.stdout.trim() === "" ? "empty" : "non-empty"}\n${r.stderr}`;
}

function withFalsifier<T>(body: string, fn: (greps: Grep[]) => T): T {
  const path = join(repo, "docs", `${FALSIFIER_PREFIX}${process.pid}.md`);
  writeFileSync(path, body);
  try {
    return fn(collect(path, readFileSync(path, "utf8")));
  } finally {
    rmSync(path, { force: true });
  }
}

const ARCHIVED = "grep -rl '^status: archived$' _memory";
const SUPERSEDED = "grep -rl '^status: superseded$' _memory";

describe("doc greps", () => {
  test(`docs/ shows at least ${MIN_GREPS} greps`, () => {
    const inDocs = collectAll().filter((g) => g.file.startsWith("docs/"));
    expect(inDocs.length).toBeGreaterThanOrEqual(MIN_GREPS);
  });

  test("every doc grep matches something in the demo Bank", () => {
    const failures = collectAll().flatMap((g) => failure(g) ?? []);
    expect(failures.join("\n")).toBe("");
  });
});

describe("the grep test's falsifier", () => {
  test("a grep that matches nothing fails", () => {
    withFalsifier(`\`\`\`sh\n${ARCHIVED}\n\`\`\`\n`, (greps) => {
      expect(greps).toHaveLength(1);
      expect(failure(greps[0]!)).not.toBeNull();
    });
  });

  test("the same grep with a status the fixture has passes", () => {
    withFalsifier(`\`\`\`sh\n${SUPERSEDED}\n\`\`\`\n`, (greps) => {
      expect(greps).toHaveLength(1);
      expect(failure(greps[0]!)).toBeNull();
    });
  });

  test("a grep outside any fence isn't collected", () => {
    withFalsifier(`${ARCHIVED}\n`, (greps) => expect(greps).toHaveLength(0));
  });

  test("a grep inside a text fence isn't collected", () => {
    withFalsifier(`\`\`\`text\n${ARCHIVED}\n\`\`\`\n`, (greps) => expect(greps).toHaveLength(0));
  });

  test("the main collection never reads a falsifier file", () => {
    const path = join(repo, "docs", `${FALSIFIER_PREFIX}leftover.md`);
    writeFileSync(path, `\`\`\`sh\n${ARCHIVED}\n\`\`\`\n`);
    try {
      expect(collectAll().some((g) => g.command === ARCHIVED)).toBe(false);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
