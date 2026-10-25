import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";

const repo = new URL("../..", import.meta.url).pathname;

// Parsed from what a user sees, so a command hidden from --help counts as missing.
async function helpCommands(): Promise<Set<string>> {
  const { stdout } = await run({ argv: ["--help"], cwd: repo, env: {} });
  return new Set([...stdout.matchAll(/^ {2}(\S+) {2}/gm)].map((m) => m[1]!));
}

function mentions(text: string): string[] {
  return [...text.matchAll(/\bltm ([a-z][a-z-]*)\b/g)].map((m) => m[1]!);
}

function pluginProse(): { path: string; text: string }[] {
  const paths = [
    ...readdirSync(join(repo, "skills")).map((d) => `skills/${d}/SKILL.md`),
    ...readdirSync(join(repo, "agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `agents/${f}`),
  ];
  return paths.map((path) => ({ path, text: readFileSync(join(repo, path), "utf8") }));
}

describe("ltm commands named in the plugin", () => {
  test("every `ltm <subcommand>` in a skill or agent is listed by ltm --help", async () => {
    const listed = await helpCommands();
    const files = pluginProse();
    const found = files.flatMap((f) => mentions(f.text).map((cmd) => ({ path: f.path, cmd })));
    // Guards against a regex that silently matches nothing.
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found.filter((m) => !listed.has(m.cmd))).toEqual([]);
  });

  test("the agent runs the hydrate skill", () => {
    const agent = pluginProse().find((f) => f.path === "agents/hydrator.md");
    expect(agent?.text).toContain("hydrate");
  });
});

describe("the command check's falsifier", () => {
  test("--help yields the real command list", async () => {
    const listed = await helpCommands();
    for (const cmd of ["discover", "query", "validate", "propose", "promote", "head", "mcp"]) expect(listed.has(cmd)).toBe(true);
  });

  test("a command --help doesn't list is caught", async () => {
    const listed = await helpCommands();
    expect(mentions("Run `ltm hydrate ./docs` first.").filter((c) => !listed.has(c))).toEqual(["hydrate"]);
  });
});
