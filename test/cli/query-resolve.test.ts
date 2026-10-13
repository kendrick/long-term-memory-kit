import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/cli/run.ts";

const demo = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

const REDIS = "_memory/exceptions/order-service-redis-until-2027-03-wJ3nC7hTy4.md";
const ORG_EXC = "_memory/exceptions/org-wide-exception-oW1dE2xCp3.md";
const ORG_CTX = "_memory/context/org-wide-context-oW4cT5xTq6.md";

const exampleConfig = `banks:
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
let env: Record<string, string>;

const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env });
const lines = (s: string): string[] => s.split("\n").filter((l) => l !== "");

function makeBank(name: string): string {
  const dir = join(home, "banks", name);
  cpSync(demo, dir, { recursive: true });
  const cfg = join(dir, "memory-bank.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^name:.*$/m, `name: ${name}`));
  return dir;
}

// Rewrites by key, never by line number: a sibling lane reorders demo-bank keys.
function orgWideCopy(bank: string, from: string, to: string, id: string, appliesTo: string | null): void {
  let text = readFileSync(join(bank, from), "utf8").replace(/^id:.*$/m, `id: ${id}`);
  text = appliesTo === null ? text.replace(/^applies_to:.*\n/m, "") : text.replace(/^applies_to:.*$/m, `applies_to: ${appliesTo}`);
  writeFileSync(join(bank, to), text);
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function setOrigin(url: string): void {
  spawnSync("git", ["-C", repo, "remote", "remove", "origin"]);
  git(repo, "remote", "add", "origin", url);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ltm-query-resolve-")));
  home = join(tmp, "home");
  mkdirSync(home);
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, exampleConfig);
  env = { LTM_CONFIG: configPath, HOME: home };
  const acme = makeBank("acme");
  makeBank("personal");
  // The demo Bank has no org-wide Record, so the fallback would pass on an empty set.
  orgWideCopy(acme, REDIS, ORG_EXC, "oW1dE2xCp3", "[]");
  orgWideCopy(acme, "_memory/context/commerce-domain-glossary-xO4bV1cPi0.md", ORG_CTX, "oW4cT5xTq6", null);
  repo = join(tmp, "order-service");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "git@github.com:acme/order-service.git");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("ltm query from a Consumer repo", () => {
  test("falsifier: a mapped repo sees its Exception; an unmapped one falls back to org-wide", async () => {
    const mapped = await ltm(repo, "query", "--type", "Exception");
    expect(mapped.exitCode).toBe(0);
    expect(lines(mapped.stdout)).toContainEqual(expect.stringMatching(new RegExp(`^acme:${REDIS}  `)));
    expect(mapped.stderr).toBe("");

    setOrigin("https://github.com/acme/billing");
    const unmapped = await ltm(repo, "query", "--type", "Exception");
    expect(unmapped.exitCode).toBe(0);
    expect(lines(unmapped.stdout).map((l) => l.split("  ")[0])).toEqual([`acme:${ORG_EXC}`]);
    expect(lines(unmapped.stderr)).toEqual([
      'ltm query: acme/billing is not mapped in Bank "acme"; showing org-wide Records only',
      'ltm query: acme/billing is not mapped in Bank "personal"; showing org-wide Records only',
    ]);

    const json = await ltm(repo, "query", "--json");
    const out = JSON.parse(json.stdout);
    expect(out.results.map((r: { bank: string; path: string }) => `${r.bank}:${r.path}`).sort()).toEqual(
      [`acme:${ORG_CTX}`, `acme:${ORG_EXC}`].sort(),
    );
    expect(out.notes).toHaveLength(2);
    expect(json.stderr).toBe("");
  });

  test("a two-Bank run labels every human line and every JSON result with its Bank", async () => {
    const human = await ltm(repo, "query", "--all");
    expect(human.exitCode).toBe(0);
    const got = lines(human.stdout);
    expect(got.some((l) => l.startsWith("acme:"))).toBe(true);
    expect(got.some((l) => l.startsWith("personal:"))).toBe(true);
    for (const l of got) expect(l.startsWith("acme:") || l.startsWith("personal:")).toBe(true);
    // Resolution order is acme then personal, and results don't interleave.
    const firstPersonal = got.findIndex((l) => l.startsWith("personal:"));
    expect(got.slice(firstPersonal).every((l) => l.startsWith("personal:"))).toBe(true);

    const json = await ltm(repo, "query", "--json", "--all");
    const out = JSON.parse(json.stdout);
    expect(Object.keys(out)).toEqual(["results", "notes", "resolved_by"]);
    expect(out.resolved_by).toBe("rules");
    expect(out.notes).toEqual([]);
    expect(out.results.length).toBe(got.length);
    for (const r of out.results) {
      expect(Object.keys(r)[0]).toBe("bank");
      expect(Object.keys(r)[1]).toBe("path");
    }
    expect(new Set(out.results.map((r: { bank: string }) => r.bank))).toEqual(new Set(["acme", "personal"]));
  });

  test("--bank personal returns only personal, even with .ltm.yaml naming acme", async () => {
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [acme]\n");
    const viaYaml = await ltm(repo, "query", "--json");
    expect(JSON.parse(viaYaml.stdout).resolved_by).toBe("ltm.yaml");

    const human = await ltm(repo, "query", "--bank", "personal", "--all");
    expect(human.exitCode).toBe(0);
    expect(lines(human.stdout).length).toBeGreaterThan(0);
    for (const l of lines(human.stdout)) expect(l.startsWith("personal:")).toBe(true);

    const json = JSON.parse((await ltm(repo, "query", "--bank", "personal", "--json")).stdout);
    expect(json.resolved_by).toBe("flag");
    expect(new Set(json.results.map((r: { bank: string }) => r.bank))).toEqual(new Set(["personal"]));
  });

  test("--bank takes a path relative to cwd and works inside a Bank", async () => {
    const inBank = join(home, "banks", "acme");
    // The Bank dir has no origin, so --facet keeps the result set non-empty.
    const r = await ltm(inBank, "query", "--bank", "../personal", "--json", "--facet", "domain:commerce");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolved_by).toBe("flag");
    expect(new Set(out.results.map((x: { bank: string }) => x.bank))).toEqual(new Set(["personal"]));
  });

  test("with nothing resolvable, exits 1 naming the three places checked", async () => {
    writeFileSync(configPath, "banks:\n  acme: { path: ~/banks/acme }\n");
    const r = await ltm(repo, "query");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith("ltm query: no Bank for this repo; checked ")).toBe(true);
    expect(r.stderr).toContain(join(repo, ".ltm.yaml"));
    expect(r.stderr).toContain(`rules in ${configPath}`);
    expect(r.stderr).toContain(`default in ${configPath}`);
    expect(lines(r.stderr)).toHaveLength(1);
  });

  test("a bad user config exits 1 with one path:line line naming the key", async () => {
    writeFileSync(configPath, "banks:\n  acme: { pathh: x }\n");
    const r = await ltm(repo, "query");
    expect(r.exitCode).toBe(1);
    expect(r.stderr.startsWith(`ltm query: ${configPath}:2: `)).toBe(true);
    expect(r.stderr).toContain("pathh");
    expect(lines(r.stderr)).toHaveLength(1);
  });

  test("--facet overrides the mapping in every Bank and emits no note", async () => {
    setOrigin("https://github.com/acme/billing");
    const r = await ltm(repo, "query", "--json", "--facet", "service:order-service", "--type", "Exception");
    const out = JSON.parse(r.stdout);
    expect(out.notes).toEqual([]);
    const got = out.results.map((x: { bank: string; path: string }) => `${x.bank}:${x.path}`);
    expect(got).toContain(`acme:${REDIS}`);
    expect(got).toContain(`personal:${REDIS}`);
    expect(r.stderr).toBe("");
  });

  test("no origin falls back to org-wide Records with a note", async () => {
    git(repo, "remote", "remove", "origin");
    const r = await ltm(repo, "query", "--json");
    const out = JSON.parse(r.stdout);
    // No origin skips the rules, so default (personal) is the one Bank.
    expect(out.resolved_by).toBe("default");
    expect(out.results).toEqual([]);
    expect(out.notes).toEqual(['no git origin here; showing org-wide Records only from Bank "personal"']);
  });

  test("inside a Bank, a user config changes nothing", async () => {
    const inBank = join(home, "banks", "acme");
    for (const args of [["--all"], ["--json", "--all"], ["--type", "Exception"], ["--text", "redis"]]) {
      const withConfig = await run({ argv: ["query", ...args], cwd: inBank, env });
      const without = await run({ argv: ["query", ...args], cwd: inBank, env: {} });
      expect(withConfig).toEqual(without);
      expect(withConfig.stdout).not.toContain("acme:");
    }
  });
});
