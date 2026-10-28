import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const repo = new URL("..", import.meta.url).pathname;
const page = join(repo, "guide/getting-started.md");

// Same fence rule as docs-greps.test.ts: a fence counts only when its opening line is exactly ```<lang>.
function fences(text: string, lang: string): string[] {
  const blocks: string[] = [];
  let lines: string[] | null = null;
  let other = false;
  for (const line of text.split("\n")) {
    if (lines === null && !other) {
      if (line === "```" + lang) lines = [];
      else if (line.startsWith("```")) other = true;
    } else if (line.trim() === "```") {
      if (lines !== null) blocks.push(lines.join("\n"));
      lines = null;
      other = false;
    } else lines?.push(line);
  }
  return blocks;
}

// Only bare ```sh fences run, so ```bash steps (download, push, plugin install) stay reader-only.
const shFences = (text: string) => fences(text, "sh");

const recordsUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".md"))
    .map((p) => join(dir, p));

const frontmatter = (path: string): Record<string, unknown> =>
  parse(readFileSync(path, "utf8").split("\n---\n")[0]!.replace(/^---\n/, "")) as Record<string, unknown>;

// The bash fences never run, so nothing else notices one that leaves the reader in the wrong directory for the steps after it.
test("every bash fence on guide/getting-started.md returns to the directory it started in", () => {
  const blocks = fences(readFileSync(page, "utf8"), "bash");
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    const cds = block.split("\n").filter((l) => /^cd\s/.test(l));
    const up = cds.filter((l) => /^cd \.\.$/.test(l)).length;
    expect(cds.length - up, `cd into a directory without cd .. back out:\n${block}`).toBe(up);
  }
});

test("guide/getting-started.md, run literally, ends with a valid Bank a Consumer repo can query", () => {
  const runnable = shFences(readFileSync(page, "utf8"));
  expect(runnable.length).toBeGreaterThan(0);

  // Realpath'd because macOS tmpdir() is a symlink and the page writes $PWD into the user config.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ltm-getting-started-")));
  try {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "home"));
    // The local build stands in for the installed binary.
    writeFileSync(join(dir, "bin/ltm"), `#!/bin/sh\nexec bun ${join(repo, "src/cli/bin.ts")} "$@"\n`, { mode: 0o755 });
    // Built from scratch, not from process.env, so a developer's LTM_CONFIG, XDG_CONFIG_HOME, or git config can't leak in.
    const env = {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      HOME: join(dir, "home"),
      TMPDIR: tmpdir(),
      LTM_TODAY: "2026-10-26",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "ltm test",
      GIT_AUTHOR_EMAIL: "ltm@example.invalid",
      GIT_COMMITTER_NAME: "ltm test",
      GIT_COMMITTER_EMAIL: "ltm@example.invalid",
    };
    const sh = (cwd: string, script: string) => spawnSync("sh", ["-e", "-c", script], { cwd, env, encoding: "utf8" });

    const walk = sh(dir, runnable.join("\n"));
    expect(walk.status, `the page's sh fences failed:\n${walk.stdout}\n${walk.stderr}`).toBe(0);

    const bank = join(dir, "acme-bank");
    const records = recordsUnder(join(bank, "_memory"));
    expect(records).toHaveLength(1);
    const first = frontmatter(records[0]!);
    expect(typeof first.id).toBe("string");

    const validate = sh(bank, "ltm validate --json");
    expect(validate.status, validate.stderr).toBe(0);
    // Warnings don't fail validate, but the page shouldn't teach a Record that draws one.
    expect(JSON.parse(validate.stdout)).toEqual([]);

    const query = sh(join(dir, "order-service"), "ltm query --json");
    expect(query.status, query.stderr).toBe(0);
    const out = JSON.parse(query.stdout) as { results: { id: string }[]; resolved_by: string };
    expect(out.results.map((r) => r.id)).toContain(first.id as string);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
