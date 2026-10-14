import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCommands } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/run.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

const config = `banks:
  acme:     { path: ~/banks/acme, url: git@github.com:acme/memory-bank.git }
  personal: { path: ~/banks/personal }
rules:
  - { match: github.com/acme/*, bank: acme }
  - { match: "*",               bank: personal }
default: personal
`;

let tmp: string;
let home: string;
let configPath: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function makeBank(name: string): void {
  const dir = join(home, "banks", name);
  cpSync(demoBank, dir, { recursive: true });
  const cfg = join(dir, "memory-bank.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^name:.*$/m, `name: ${name}`));
}

const connect = (...argv: string[]) =>
  run({ argv: ["connect", ...argv], cwd: repo, env: { LTM_CONFIG: configPath, HOME: home } });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ltm-connect-")));
  home = join(tmp, "home");
  mkdirSync(home);
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, config);
  makeBank("acme");
  makeBank("personal");
  repo = join(tmp, "order-service");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "git@github.com:acme/order-service.git");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("ltm connect", () => {
  test("is no longer a hidden stub", () => {
    expect(defaultCommands.find((c) => c.name === "connect")?.hidden).toBeUndefined();
  });

  test("names both resolved Banks once under one heading and leaves the repo clean", async () => {
    const r = await connect();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      [
        "## Org memory",
        "Org-level decisions, policies, and exceptions live in the acme Bank at git@github.com:acme/memory-bank.git.",
        `Org-level decisions, policies, and exceptions live in the personal Bank at ${join(home, "banks", "personal")}.`,
        "Before making an architectural choice, follow that Bank's AGENTS.md to query it, or run `ltm query` from this repo.",
        "",
      ].join("\n"),
    );
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  test("a single Bank prints the same shape with one line", async () => {
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [personal]\n");
    const before = git(repo, "status", "--porcelain");
    const r = await connect();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l.includes("Bank at "))).toHaveLength(1);
    expect(r.stdout).toContain(" the personal Bank at ");
    expect(git(repo, "status", "--porcelain")).toBe(before);
  });

  test("--bank personal names only personal, even with .ltm.yaml naming acme", async () => {
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [acme]\n");
    const r = await connect("--bank", "personal");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the personal Bank at");
    expect(r.stdout).not.toContain("acme");
  });

  test("nothing resolvable exits 1 and names the three places", async () => {
    writeFileSync(configPath, `banks:\n  personal: { path: ~/banks/personal }\n`);
    const r = await connect();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^ltm connect: no Bank for this repo; checked /);
    expect(r.stderr).toContain(join(repo, ".ltm.yaml"));
    expect(r.stderr).toContain(`rules in ${configPath}`);
    expect(r.stderr).toContain(`default in ${configPath}`);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  test("a bad user config prints one path:line line, no stack", async () => {
    writeFileSync(configPath, "banks:\n  acme:\n    pathh: x\n");
    const r = await connect();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`^ltm connect: ${configPath}:\\d+: .*pathh.*\\n$`));
  });

  test("--bank <path> to a directory with no memory-bank.yaml names the file it looked for", async () => {
    const r = await connect("--bank", "./nowhere");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith(`ltm connect: ${join(repo, "nowhere", "memory-bank.yaml")}: --bank './nowhere' is neither a Bank in `);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  test("a malformed .ltm.yaml fails loudly with its path and line instead of falling through to rules", async () => {
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [acme]\nextra: 1\n");
    const r = await connect();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith(`ltm connect: ${join(repo, ".ltm.yaml")}:2: extra: unknown key`);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  test("a Bank whose memory-bank.yaml has a YAML syntax error is reported at that file and line, first line only", async () => {
    const bankCfg = join(home, "banks", "personal", "memory-bank.yaml");
    writeFileSync(bankCfg, "name: personal\nfolders: [unclosed\n");
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [personal]\n");
    const r = await connect();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(new RegExp(`^ltm connect: ${bankCfg}:\\d+: [^\\n]+\\n$`));
  });

  test("a ConfigError with no line prints the path alone, never ':null'", async () => {
    // Valid YAML that isn't a mapping: loadConfig has no line to attribute, so line is null.
    const bankCfg = join(home, "banks", "personal", "memory-bank.yaml");
    writeFileSync(bankCfg, "- not\n- a mapping\n");
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [personal]\n");
    const r = await connect();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`ltm connect: ${bankCfg}: config is not a YAML mapping\n`);
    expect(r.stderr).not.toContain("null");
  });
});
