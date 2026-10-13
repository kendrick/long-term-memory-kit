import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as prettier from "prettier";
import { parse } from "yaml";
import pkg from "../../package.json" with { type: "json" };
import { defaultCommands } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/run.ts";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ltm-init-")));
  dir = join(tmp, "acme-memory");
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const init = (...argv: string[]) => run({ argv: ["init", ...argv], cwd: dir, env: {} });
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort();
}

function hashes(root: string): Record<string, string> {
  return Object.fromEntries(walk(root).map((rel) => [rel, createHash("sha256").update(readFileSync(join(root, rel))).digest("hex")]));
}

// The `sh` fence inside the generated region, i.e. what an agent would actually run.
function funnelLines(agents: string): string[] {
  const block = /```sh\n([\s\S]*?)```/.exec(agents);
  if (!block) throw new Error("no sh block in AGENTS.md");
  return block[1]!.trimEnd().split("\n");
}

describe("ltm init", () => {
  test("is no longer a hidden stub", () => {
    expect(defaultCommands.find((c) => c.name === "init")?.hidden).toBeUndefined();
  });

  test("an empty dir gets every file in the table, and ltm validate passes there", async () => {
    const r = await init();
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(walk(dir)).toEqual(
      [
        ".github/copilot-instructions.md",
        ".oxfmtrc.json",
        ".prettierrc.json",
        "AGENTS.md",
        "CLAUDE.md",
        "CODEOWNERS.example",
        "_memory/context/.gitkeep",
        "_memory/decisions/.gitkeep",
        "_memory/exceptions/.gitkeep",
        "_memory/policy-rules/.gitkeep",
        "memory-bank.yaml",
      ].sort(),
    );
    expect(parse(read("memory-bank.yaml"))).toEqual({
      schema: 1,
      name: "acme-memory",
      facet_prefixes: ["service", "domain", "system", "team", "platform"],
    });
    expect(read("CLAUDE.md")).toBe(`<!-- ltm:generated:begin v${pkg.version} -->\n@AGENTS.md\n<!-- ltm:generated:end -->\n`);
    expect(read(".github/copilot-instructions.md")).toBe(
      `<!-- ltm:generated:begin v${pkg.version} -->\nFollow AGENTS.md at the repo root to read and propose Bank memory.\n<!-- ltm:generated:end -->\n`,
    );
    expect(read("AGENTS.md")).toContain("This repo is the acme-memory Bank.");
    expect(read("CODEOWNERS.example")).toBe(
      [
        "/_memory/decisions/ @your-org/memory-maintainers",
        "/_memory/policy-rules/ @your-org/memory-maintainers",
        "/_memory/exceptions/ @your-org/memory-maintainers",
        "/_memory/context/ @your-org/memory-maintainers",
        "",
      ].join("\n"),
    );
    expect(JSON.parse(read(".oxfmtrc.json"))).toEqual({
      overrides: [{ files: ["_memory/**/*.md"], options: { embeddedLanguageFormatting: "off" } }],
    });
    const resolved = await prettier.resolveConfig(join(dir, "_memory/decisions/x.md"), { editorconfig: false });
    expect(resolved).toEqual({ embeddedLanguageFormatting: "off" });

    const v = await run({ argv: ["validate"], cwd: dir, env: {} });
    expect(v.stdout + v.stderr).toBe("");
    expect(v.exitCode).toBe(0);
  });

  test("a second run changes no file", async () => {
    expect((await init()).exitCode).toBe(0);
    const before = hashes(dir);
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(hashes(dir)).toEqual(before);
  });

  test("an existing .prettierrc.json keeps its keys and gains the memory override", async () => {
    writeFileSync(join(dir, ".prettierrc.json"), '{ "semi": false }\n');
    expect((await init()).exitCode).toBe(0);
    const cfg = JSON.parse(read(".prettierrc.json"));
    expect(cfg.semi).toBe(false);
    expect(cfg.overrides).toEqual([{ files: "_memory/**/*.md", options: { embeddedLanguageFormatting: "off" } }]);
    const resolved = await prettier.resolveConfig(join(dir, "_memory/context/x.md"), { editorconfig: false });
    expect(resolved).toEqual({ semi: false, embeddedLanguageFormatting: "off" });
  });

  test("an existing memory-bank.yaml stays byte-identical, and the region follows it", async () => {
    const yaml = "schema: 1\nname:   hand-written   # keep me\nfacet_prefixes: [team]\n";
    writeFileSync(join(dir, "memory-bank.yaml"), yaml);
    const r = await init("--name", "ignored");
    expect(r.exitCode).toBe(0);
    expect(read("memory-bank.yaml")).toBe(yaml);
    expect(read("AGENTS.md")).toContain("This repo is the hand-written Bank.");
    expect(funnelLines(read("AGENTS.md"))).toContain(
      "grep -rl 'applies_to:.*team:example' _memory/decisions _memory/policy-rules _memory/exceptions _memory/context",
    );
  });

  test("--folder Decision=docs/adr writes that override, leaves the ADR alone, and the greps use it", async () => {
    mkdirSync(join(dir, "docs/adr"), { recursive: true });
    const adr = "# 1. Record architecture decisions\n\nWe will.\n";
    writeFileSync(join(dir, "docs/adr/0001-x.md"), adr);
    const r = await init("--folder", "Decision=docs/adr");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(parse(read("memory-bank.yaml")).folders).toEqual({ Decision: "docs/adr" });
    expect(read("docs/adr/0001-x.md")).toBe(adr);
    expect(existsSync(join(dir, "docs/adr/.gitkeep"))).toBe(false);
    expect(existsSync(join(dir, "_memory/decisions"))).toBe(false);
    const greps = funnelLines(read("AGENTS.md")).filter((l) => l.startsWith("grep "));
    expect(greps.length).toBeGreaterThan(0);
    expect(greps.some((l) => l.split(" ").includes("docs/adr"))).toBe(true);
    expect(read("CODEOWNERS.example").split("\n")[0]).toBe("/docs/adr/ @your-org/memory-maintainers");
    const resolved = await prettier.resolveConfig(join(dir, "docs/adr/0001-x.md"), { editorconfig: false });
    expect(resolved).toEqual({ embeddedLanguageFormatting: "off" });
  });
});

describe("ltm init edges", () => {
  test("text outside the markers survives, and only the region changes", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# House rules\n\nBe kind.\n");
    expect((await init()).exitCode).toBe(0);
    expect(read("AGENTS.md").startsWith("# House rules\n\nBe kind.\n\n<!-- ltm:generated:begin ")).toBe(true);
  });

  test("a non-JSON Prettier config is skipped with a warning", async () => {
    writeFileSync(join(dir, ".prettierrc.yaml"), "semi: false\n");
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe(
      "ltm init: warning: .prettierrc.yaml is not JSON; add the _memory override by hand (see templates/formatters/prettierrc.json)\n",
    );
    expect(existsSync(join(dir, ".prettierrc.json"))).toBe(false);
    expect(read(".prettierrc.yaml")).toBe("semi: false\n");
  });

  test("an existing CODEOWNERS.example is never overwritten", async () => {
    writeFileSync(join(dir, "CODEOWNERS.example"), "mine\n");
    expect((await init()).exitCode).toBe(0);
    expect(read("CODEOWNERS.example")).toBe("mine\n");
  });

  test("a begin marker with no end exits 1 naming the file, and writes the rest", async () => {
    const broken = "<!-- ltm:generated:begin v0.0.0 -->\nhalf a region\n";
    writeFileSync(join(dir, "AGENTS.md"), broken);
    const r = await init();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^ltm init: AGENTS\.md: .*no matching.*\n$/);
    expect(read("AGENTS.md")).toBe(broken);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });

  test("a positional dir is resolved from cwd and created", async () => {
    const r = await run({ argv: ["init", "nested/bank"], cwd: dir, env: {} });
    expect(r.exitCode).toBe(0);
    expect(parse(readFileSync(join(dir, "nested/bank/memory-bank.yaml"), "utf8")).name).toBe("bank");
  });

  test("--name and --facet-prefix land in the new config in order", async () => {
    expect((await init("--name", "123", "--facet-prefix", "team", "--facet-prefix", "service")).exitCode).toBe(0);
    expect(parse(read("memory-bank.yaml"))).toEqual({ schema: 1, name: "123", facet_prefixes: ["team", "service"] });
  });

  test.each([
    ["Decision", "has no '='"],
    ["Bogus=x", "not a memory type"],
    ["Decision=", "empty"],
    ["Decision=../out", "outside"],
    ["Decision=/abs", "outside"],
    ["Decision=a\\b", "backslash"],
  ])("--folder %s is a usage error (exit 2) and writes nothing", async (value, reason) => {
    const r = await init("--folder", value);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(reason);
    expect(walk(tmp)).toEqual([]);
  });
});
