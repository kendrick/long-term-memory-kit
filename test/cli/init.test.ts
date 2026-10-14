import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as prettier from "prettier";
import { parse } from "yaml";
import pkg from "../../package.json" with { type: "json" };
import { defaultCommands } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/run.ts";
import { BEGIN, END } from "../../src/core/init.ts";
import { withScratch } from "../helpers/scratch.ts";

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
    expect(read("CLAUDE.md")).toBe(`<!-- ltm:generated:begin v${pkg.version} -->\n\n@AGENTS.md\n\n<!-- ltm:generated:end -->\n`);
    expect(read(".github/copilot-instructions.md")).toBe(
      `<!-- ltm:generated:begin v${pkg.version} -->\n\nFollow AGENTS.md at the repo root to read and propose Bank memory.\n\n<!-- ltm:generated:end -->\n`,
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

  test("a matching prettier override keeps the user's options and gains the template's", async () => {
    writeFileSync(
      join(dir, ".prettierrc.json"),
      '{"overrides":[{"files":"_memory/**/*.md","options":{"proseWrap":"never"}}]}',
    );
    expect((await init()).exitCode).toBe(0);
    const cfg = JSON.parse(read(".prettierrc.json"));
    expect(cfg.overrides).toEqual([
      { files: "_memory/**/*.md", options: { proseWrap: "never", embeddedLanguageFormatting: "off" } },
    ]);
  });

  test("a matching oxfmt override keeps its other keys, like excludeFiles", async () => {
    writeFileSync(
      join(dir, ".oxfmtrc.json"),
      JSON.stringify({ overrides: [{ files: ["_memory/**/*.md"], excludeFiles: ["x.md"] }] }),
    );
    expect((await init()).exitCode).toBe(0);
    const cfg = JSON.parse(read(".oxfmtrc.json"));
    expect(cfg.overrides).toEqual([
      { files: ["_memory/**/*.md"], excludeFiles: ["x.md"], options: { embeddedLanguageFormatting: "off" } },
    ]);
  });

  test("the template's embeddedLanguageFormatting wins over an existing value", async () => {
    writeFileSync(
      join(dir, ".prettierrc.json"),
      '{"overrides":[{"files":"_memory/**/*.md","options":{"embeddedLanguageFormatting":"auto"}}]}',
    );
    expect((await init()).exitCode).toBe(0);
    expect(JSON.parse(read(".prettierrc.json")).overrides[0].options.embeddedLanguageFormatting).toBe("off");
  });

  test("a matching override whose options is not an object gets the template's options", async () => {
    writeFileSync(join(dir, ".prettierrc.json"), '{"overrides":[{"files":"_memory/**/*.md","options":"oops"}]}');
    expect((await init()).exitCode).toBe(0);
    expect(JSON.parse(read(".prettierrc.json")).overrides).toEqual([
      { files: "_memory/**/*.md", options: { embeddedLanguageFormatting: "off" } },
    ]);
  });

  test("a second init leaves merged formatter configs byte-identical", async () => {
    writeFileSync(
      join(dir, ".prettierrc.json"),
      '{"overrides":[{"files":"_memory/**/*.md","options":{"proseWrap":"never"}}]}',
    );
    writeFileSync(
      join(dir, ".oxfmtrc.json"),
      JSON.stringify({ overrides: [{ files: ["_memory/**/*.md"], excludeFiles: ["x.md"] }] }),
    );
    expect((await init()).exitCode).toBe(0);
    const first = [read(".prettierrc.json"), read(".oxfmtrc.json")];
    expect((await init()).exitCode).toBe(0);
    expect([read(".prettierrc.json"), read(".oxfmtrc.json")]).toEqual(first);
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

describe("ltm init formatter globs", () => {
  const files = [".prettierrc.json", ".oxfmtrc.json"];
  const overrideGlobs = (file: string) =>
    (JSON.parse(read(file)).overrides as { files: string | string[] }[]).flatMap((o) => o.files);

  test.each(files)("--folder through _memory/.. gets the glob of where the Records live (%s)", async (file) => {
    const r = await init("--folder", "Decision=_memory/../docs/adr");
    expect(r.exitCode).toBe(0);
    expect(overrideGlobs(file)).toContain("docs/adr/**/*.md");
    expect(overrideGlobs(file).filter((g) => g.includes(".."))).toEqual([]);
  });

  test("--folder through _memory/.. also lands in CODEOWNERS.example as the real path", async () => {
    const r = await init("--folder", "Decision=_memory/../docs/adr");
    expect(r.exitCode).toBe(0);
    expect(read("CODEOWNERS.example").split("\n")[0]).toBe("/docs/adr/ @your-org/memory-maintainers");
  });

  test("a type folder that normalizes to the Bank root gets /** in CODEOWNERS.example, not /./", async () => {
    const r = await init("--folder", "Decision=_memory/..");
    expect(r.exitCode).toBe(0);
    const lines = read("CODEOWNERS.example").split("\n");
    expect(lines).toContain("/** @your-org/memory-maintainers");
    expect(lines.filter((l) => l.startsWith("/./"))).toEqual([]);
  });

  test.each(files)("a . segment under _memory/ keeps the template glob (%s)", async (file) => {
    const r = await init("--folder", "Decision=_memory/./adr");
    expect(r.exitCode).toBe(0);
    expect(overrideGlobs(file)).toEqual(["_memory/**/*.md"]);
  });

  test.each(files)("a hand-written memory-bank.yaml folder through _memory/.. gets the same glob (%s)", async (file) => {
    writeFileSync(join(dir, "memory-bank.yaml"), "schema: 1\nname: acme\nfacet_prefixes: [team]\nfolders:\n  Decision: _memory/../docs/adr\n");
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(overrideGlobs(file)).toContain("docs/adr/**/*.md");
    expect(overrideGlobs(file).filter((g) => g.includes(".."))).toEqual([]);
  });

  test.each(files)("the default layout keeps the template glob (%s)", async (file) => {
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(overrideGlobs(file)).toEqual(["_memory/**/*.md"]);
  });

  // Asserts the formatters' output, not the resolved config: the glob is only right if a root Record's
  // fenced block survives. The default-layout control keeps this from passing on a formatter that formats nothing.
  test("a Bank-root type folder (_memory/..) keeps a root Record's code block intact in Prettier and oxfmt", async () => {
    const root = join(import.meta.dir, "../..");
    const oxfmt = join(root, "node_modules/.bin/oxfmt");
    const block = "# x\n\n```js\nconst   a  =  {b:1}\n```\n";
    const control = join(tmp, "control");
    mkdirSync(control);

    expect((await init("--folder", "Decision=_memory/..")).exitCode).toBe(0);
    expect((await run({ argv: ["init"], cwd: control, env: {} })).exitCode).toBe(0);

    const formatted = async (cwd: string) => {
      writeFileSync(join(cwd, "x.md"), block);
      const options = await prettier.resolveConfig(join(cwd, "x.md"), { editorconfig: false });
      const viaPrettier = await prettier.format(block, { ...options, filepath: join(cwd, "x.md") });
      const ox = spawnSync(oxfmt, ["-c", ".oxfmtrc.json", "x.md"], { cwd, encoding: "utf8" });
      expect(ox.status).toBe(0);
      return { viaPrettier, viaOxfmt: readFileSync(join(cwd, "x.md"), "utf8") };
    };

    expect(await formatted(dir)).toEqual({ viaPrettier: block, viaOxfmt: block });
    const ctl = await formatted(control);
    expect(ctl.viaPrettier).toContain("const a = { b: 1 };");
    expect(ctl.viaOxfmt).toContain("const a = { b: 1 };");
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

  const WARN = (f: string) =>
    `ltm init: warning: ${f} is not JSON; add the _memory override by hand (see templates/formatters/prettierrc.json)\n`;

  test("a .prettierrc.json5 is described as unsafe to edit, not as non-JSON", async () => {
    writeFileSync(join(dir, ".prettierrc.json5"), "x\n");
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe(
      "ltm init: warning: init can't safely edit .prettierrc.json5; add the _memory override by hand (see templates/formatters/prettierrc.json)\n",
    );
    expect(existsSync(join(dir, ".prettierrc.json"))).toBe(false);
  });

  test("a bare .prettierrc with no .prettierrc.json says init can't tell its format", async () => {
    writeFileSync(join(dir, ".prettierrc"), "semi: false\n");
    const r = await init();
    expect(r.stderr).toBe(
      "ltm init: warning: init can't tell .prettierrc's format; add the _memory override by hand (see templates/formatters/prettierrc.json)\n",
    );
    expect(existsSync(join(dir, ".prettierrc.json"))).toBe(false);
  });

  test.each(["prettier.config.mjs", ".prettierrc.toml", ".prettierrc.cjs", "prettier.config.ts"])(
    "an existing %s means no .prettierrc.json is created, with a warning and exit 0",
    async (file) => {
      writeFileSync(join(dir, file), "x\n");
      const r = await init();
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe(WARN(file));
      expect(existsSync(join(dir, ".prettierrc.json"))).toBe(false);
      expect(read(file)).toBe("x\n");
    },
  );

  test("a package.json prettier key means no .prettierrc.json, and package.json is untouched", async () => {
    const pj = '{ "name": "x", "prettier": { "semi": false } }\n';
    writeFileSync(join(dir, "package.json"), pj);
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe(
      "ltm init: warning: package.json has a prettier key; add the _memory override there by hand (see templates/formatters/prettierrc.json)\n",
    );
    expect(existsSync(join(dir, ".prettierrc.json"))).toBe(false);
    expect(read("package.json")).toBe(pj);
  });

  test("a package.json without a prettier key still gets .prettierrc.json", async () => {
    writeFileSync(join(dir, "package.json"), '{ "name": "x" }\n');
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(existsSync(join(dir, ".prettierrc.json"))).toBe(true);
  });

  test("a .prettierrc is read before .prettierrc.json, so init warns and leaves the JSON file alone", async () => {
    writeFileSync(join(dir, ".prettierrc"), "semi: false\n");
    writeFileSync(join(dir, ".prettierrc.json"), '{ "semi": true }\n');
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(".prettierrc");
    expect(r.stderr).toContain("warning");
    expect(read(".prettierrc.json")).toBe('{ "semi": true }\n');
  });

  test("a .prettierrc.json beside a lower-precedence config is still merged, quietly", async () => {
    writeFileSync(join(dir, "prettier.config.mjs"), "x\n");
    writeFileSync(join(dir, ".prettierrc.json"), '{ "semi": false }\n');
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(read(".prettierrc.json")).semi).toBe(false);
    expect(JSON.parse(read(".prettierrc.json")).overrides).toHaveLength(1);
  });

  test("a package.json prettier key shadows an existing .prettierrc.json, so init warns and skips it", async () => {
    writeFileSync(join(dir, "package.json"), '{ "prettier": { "semi": true }, "x": 1 }\n');
    writeFileSync(join(dir, ".prettierrc.json"), '{ "semi": false }\n');
    const r = await init();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("package.json");
    expect(read(".prettierrc.json")).toBe('{ "semi": false }\n');
  });

  describe("a Prettier config in an ancestor of the Bank", () => {
    const prettierBin = join(import.meta.dir, "../../node_modules/.bin/prettier");
    const findConfig = (cwd: string) =>
      spawnSync(prettierBin, ["--find-config-path", "a.ts"], { cwd, encoding: "utf8" });
    let bank: string;
    const initBank = () => run({ argv: ["init", bank], cwd: tmp, env: {} });

    beforeEach(() => {
      bank = join(tmp, "mono", "bank");
      mkdirSync(bank, { recursive: true });
      // The walk stops at the repo root, so mono is the project and nothing above it is read.
      mkdirSync(join(tmp, "mono", ".git"));
    });

    test("would be shadowed by a new .prettierrc.json, so init warns and writes none", async () => {
      writeFileSync(join(tmp, "mono", "prettier.config.mjs"), "export default { semi: false };\n");
      const r = await initBank();
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe(
        "ltm init: warning: ../prettier.config.mjs would be shadowed by a new .prettierrc.json here; add the _memory override to it by hand (see templates/formatters/prettierrc.json)\n",
      );
      expect(existsSync(join(bank, ".prettierrc.json"))).toBe(false);
      expect(findConfig(bank).stdout.trim()).toBe("../prettier.config.mjs");
    });

    test("a package.json prettier key counts, and one without the key does not", async () => {
      writeFileSync(join(tmp, "mono", "package.json"), '{ "prettier": { "semi": false } }\n');
      expect((await initBank()).stderr).toContain("../package.json would be shadowed");
      expect(existsSync(join(bank, ".prettierrc.json"))).toBe(false);
      writeFileSync(join(tmp, "mono", "package.json"), '{ "name": "x" }\n');
      const r = await initBank();
      expect(r.stderr).toBe("");
      expect(existsSync(join(bank, ".prettierrc.json"))).toBe(true);
    });

    test("an existing .prettierrc.json in the Bank is still merged, quietly", async () => {
      writeFileSync(join(tmp, "mono", "prettier.config.mjs"), "export default {};\n");
      writeFileSync(join(bank, ".prettierrc.json"), '{ "semi": false }\n');
      const r = await initBank();
      expect(r.stderr).toBe("");
      expect(JSON.parse(readFileSync(join(bank, ".prettierrc.json"), "utf8")).semi).toBe(false);
    });

    test("a config above the repo root is ignored, so init writes .prettierrc.json quietly", async () => {
      const repo = join(tmp, "outer", "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "bank"));
      writeFileSync(join(tmp, "outer", ".prettierrc"), "semi: false\n");
      const r = await run({ argv: ["init", join(repo, "bank")], cwd: tmp, env: {} });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      expect(existsSync(join(repo, "bank", ".prettierrc.json"))).toBe(true);
    });

    test("with no .git anywhere, an ancestor config is not consulted", async () => {
      const loose = join(tmp, "loose");
      mkdirSync(join(loose, "bank"), { recursive: true });
      writeFileSync(join(loose, ".prettierrc"), "semi: false\n");
      const r = await run({ argv: ["init", join(loose, "bank")], cwd: tmp, env: {} });
      expect(r.stderr).toBe("");
      expect(existsSync(join(loose, "bank", ".prettierrc.json"))).toBe(true);
    });

    test("a .git file (linked worktree) marks the repo root too", async () => {
      rmSync(join(tmp, "mono", ".git"), { recursive: true });
      writeFileSync(join(tmp, "mono", ".git"), "gitdir: elsewhere\n");
      writeFileSync(join(tmp, "mono", "prettier.config.mjs"), "export default {};\n");
      expect((await initBank()).stderr).toContain("../prettier.config.mjs would be shadowed");
    });

    test("control: with no config in the repo, it gets .prettierrc.json", async () => {
      // The walk ends at mono's .git, so a config in a real ancestor of the OS temp dir can't reach this.
      const r = await initBank();
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      expect(existsSync(join(bank, ".prettierrc.json"))).toBe(true);
    });
  });

  test("a bad --facet-prefix is a usage error naming the value, and nothing is written", async () => {
    for (const bad of ["", "Svc", "a_b", "a.b", "-a", "1a", "a b"]) {
      const r = await init(`--facet-prefix=${bad}`);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`'${bad}'`);
      expect(walk(dir)).toEqual([]);
    }
  });

  test("a repeated --facet-prefix is a usage error and nothing is written", async () => {
    const r = await init("--facet-prefix", "svc", "--facet-prefix", "svc");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("'svc'");
    expect(walk(dir)).toEqual([]);
  });

  test("two generated blocks in one file exit 1 naming it, and the other files are still written", async () => {
    const two = `${BEGIN(pkg.version)}\n\nold\n${END}\n\n${BEGIN(pkg.version)}\n\nold\n${END}\n`;
    writeFileSync(join(dir, "AGENTS.md"), two);
    const r = await init();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^ltm init: AGENTS\.md: /);
    expect(read("AGENTS.md")).toBe(two);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
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

  test("a symlinked parent pointing outside dir is refused, and nothing lands outside", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    symlinkSync("../outside", join(dir, ".github"));
    symlinkSync("../outside", join(dir, "_memory"));
    const r = await init();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.split("\n").filter(Boolean).sort()).toEqual(
      [
        `ltm init: .github/copilot-instructions.md: resolves outside ${dir}, not written`,
        ...["context", "decisions", "exceptions", "policy-rules"].map(
          (f) => `ltm init: _memory/${f}: resolves outside ${dir}, not written`,
        ),
      ].sort(),
    );
    expect(walk(outside)).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });

  test("a --folder through a symlinked parent is refused, and nothing lands outside", async () => {
    const out2 = join(tmp, "out2");
    mkdirSync(out2);
    symlinkSync("../out2", join(dir, "link"));
    const r = await init("--folder", "Decision=link/adr");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(`ltm init: link/adr: resolves outside ${dir}, not written\n`);
    expect(readdirSync(out2)).toEqual([]);
    expect(existsSync(join(dir, "_memory/context/.gitkeep"))).toBe(true);
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

describe("ltm init --check", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const demoBank = join(repoRoot, "fixtures/demo-bank");
  const at = (d: string, ...argv: string[]) => run({ argv: ["init", ...argv], cwd: d, env: {} });

  test("the staleness falsifier: all five steps, in order, and --check writes nothing", async () => {
    await withScratch(demoBank, async (d) => {
      expect((await at(d)).exitCode).toBe(0);

      const clean = hashes(d);
      const ok = await at(d, "--check");
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toBe("");
      expect(hashes(d)).toEqual(clean);

      const cfg = join(d, "memory-bank.yaml");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/facet_prefixes: \[/, "facet_prefixes: [widget, "));
      const stale = hashes(d);
      const r2 = await at(d, "--check");
      expect(r2.exitCode).toBe(1);
      expect(r2.stdout.split("\n")).toContain("AGENTS.md");
      expect(r2.stdout).not.toContain("CLAUDE.md");
      expect(hashes(d)).toEqual(stale);

      expect((await at(d)).exitCode).toBe(0);
      const r3 = await at(d, "--check");
      expect(r3.exitCode).toBe(0);
      expect(r3.stdout).toBe("");

      const agents = join(d, "AGENTS.md");
      writeFileSync(agents, `# Mine\n\nhand-written\n\n${readFileSync(agents, "utf8")}\ntrailing prose\n`);
      const outside = hashes(d);
      const r4 = await at(d, "--check");
      expect(r4.exitCode).toBe(0);
      expect(hashes(d)).toEqual(outside);

      const text = readFileSync(agents, "utf8");
      const at1 = text.indexOf("\n", text.indexOf("ltm:generated:begin")) + 1;
      writeFileSync(agents, text.slice(0, at1) + (text[at1] === "X" ? "Y" : "X") + text.slice(at1 + 1));
      const inside = hashes(d);
      const r5 = await at(d, "--check");
      expect(r5.exitCode).toBe(1);
      expect(r5.stdout.split("\n")).toContain("AGENTS.md");
      expect(hashes(d)).toEqual(inside);
    });
  });

  // Both tools pad the markers with blank lines, and a Bank that formats its root Markdown
  // must still pass --check and see a rerun change nothing.
  test.each(["prettier", "oxfmt"] as const)("after %s formats the region files, --check passes and init changes nothing", async (tool) => {
    await withScratch(demoBank, async (d) => {
      expect((await at(d)).exitCode).toBe(0);
      const files = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
      const cfgDir = mkdtempSync(join(tmpdir(), "ltm-fmtcfg-"));
      try {
        writeFileSync(join(cfgDir, "empty.json"), "{}\n");
        const args =
          tool === "prettier"
            ? ["--no-config", "--no-editorconfig", "--write", ...files]
            : ["-c", join(cfgDir, "empty.json"), ...files];
        const f = spawnSync(join(repoRoot, "node_modules/.bin", tool), args, { cwd: d, encoding: "utf8" });
        expect({ status: f.status, stderr: f.stderr }).toEqual({ status: 0, stderr: "" });
      } finally {
        rmSync(cfgDir, { recursive: true, force: true });
      }
      const formatted = hashes(d);
      const c = await at(d, "--check");
      expect({ code: c.exitCode, out: c.stdout }).toEqual({ code: 0, out: "" });
      const again = await at(d);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toBe("");
      expect(hashes(d)).toEqual(formatted);
    });
  });

  test("a missing region file is named, and not created", async () => {
    await withScratch(demoBank, async (d) => {
      await at(d);
      rmSync(join(d, ".github"), { recursive: true });
      const before = hashes(d);
      const r = await at(d, "--check");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe(".github/copilot-instructions.md\n");
      expect(hashes(d)).toEqual(before);
    });
  });

  test("a file with two generated blocks is stale", async () => {
    await withScratch(demoBank, async (d) => {
      await at(d);
      const text = readFileSync(join(d, "CLAUDE.md"), "utf8");
      writeFileSync(join(d, "CLAUDE.md"), `${text}\n${text}`);
      const r = await at(d, "--check");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("CLAUDE.md\n");
    });
  });

  test("a file with no markers is stale", async () => {
    await withScratch(demoBank, async (d) => {
      await at(d);
      writeFileSync(join(d, "CLAUDE.md"), "just prose\n");
      const r = await at(d, "--check");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("CLAUDE.md\n");
    });
  });

  test("no memory-bank.yaml is exit 1 and writes nothing", async () => {
    const r = await at(dir, "--check");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(`ltm init --check: no memory-bank.yaml in ${dir}\n`);
    expect(walk(dir)).toEqual([]);
  });

  test("combined with --name, --folder or --facet-prefix it is a usage error", async () => {
    for (const extra of [["--name", "x"], ["--folder", "Decision=docs/adr"], ["--facet-prefix", "a"]]) {
      const r = await at(dir, "--check", ...extra);
      expect(r.exitCode).toBe(2);
    }
    expect(walk(dir)).toEqual([]);
  });
});
