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
const ORG_RULE = "_memory/policy-rules/services-have-codeowners-aW7kC3oRf2.md";

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
  // The demo Bank's one org-wide Record is a PolicyRule with no applies_to key. These copies add
  // an org-wide Exception (applies_to: []) so a --type Exception fallback has a row to show.
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
      [`acme:${ORG_CTX}`, `acme:${ORG_EXC}`, `acme:${ORG_RULE}`, `personal:${ORG_RULE}`].sort(),
    );
    expect(out.notes).toHaveLength(2);
    expect(json.stderr).toBe("");
  });

  test("an origin spelled in another case still finds its consumers entry", async () => {
    setOrigin("git@github.com:acme/Order-Service.git");
    const r = await ltm(repo, "query", "--type", "Exception");
    expect(r.exitCode).toBe(0);
    expect(lines(r.stdout)).toContainEqual(expect.stringMatching(new RegExp(`^acme:${REDIS}  `)));
    expect(r.stderr).not.toContain("not mapped");
  });

  // --bank bypasses the case-sensitive routing rules, so the Acme owner still reaches the consumers lookup.
  test("an Acme/Order-Service origin finds the lowercase consumers key under --bank", async () => {
    setOrigin("git@github.com:Acme/Order-Service.git");
    const r = await ltm(repo, "query", "--bank", "acme", "--type", "Exception");
    expect(r.exitCode).toBe(0);
    expect(lines(r.stdout)).toContainEqual(expect.stringMatching(new RegExp(`^acme:${REDIS}  `)));
    expect(r.stderr).not.toContain("not mapped");
  });

  test("an unmapped repo gets the demo Bank's own org-wide Record, with the not-mapped note", async () => {
    setOrigin("https://github.com/acme/billing");
    const r = await ltm(repo, "query", "--json");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results.map((x: { bank: string; path: string }) => `${x.bank}:${x.path}`)).toContain(`acme:${ORG_RULE}`);
    expect(out.notes).toContain('acme/billing is not mapped in Bank "acme"; showing org-wide Records only');
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

  test("a mapped repo gets only its own Facets' Records, not every Record in the Bank", async () => {
    const r = await ltm(repo, "query", "--type", "Exception");
    expect(r.exitCode).toBe(0);
    const got = lines(r.stdout).map((l) => l.split("  ")[0]);
    expect(got).toContain(`acme:${REDIS}`);
    // Other services' Exceptions would all appear if the mapped Facets were dropped.
    expect(got.join("\n")).not.toContain("legacy-billing-mysql-until-2026-12-tZ6qL0vKd1.md");
    expect(got.join("\n")).not.toContain("search-service-plaintext-logs-bU2pR8aXf7.md");
    expect(r.stderr).toBe("");
  });

  test("a repo mapped to [] gets only org-wide Records, not the whole Bank", async () => {
    const acme = join(home, "banks", "acme");
    const cfg = join(acme, "memory-bank.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\n  acme/empty: []\n`);
    setOrigin("git@github.com:acme/empty.git");

    const r = await ltm(repo, "query", "--json");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    const acmePaths = out.results.filter((x: { bank: string }) => x.bank === "acme").map((x: { path: string }) => x.path);
    expect(acmePaths.sort()).toEqual([ORG_CTX, ORG_EXC, ORG_RULE].sort());
    // Mapped (to nothing) is not unmapped, so no "not mapped" note for acme.
    expect(out.notes.join("\n")).not.toContain('Bank "acme"');
    expect(r.stderr).toBe("");
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
    expect(out.results.map((x: { bank: string; path: string }) => `${x.bank}:${x.path}`)).toEqual([`personal:${ORG_RULE}`]);
    expect(out.notes).toEqual(['no git origin here; showing org-wide Records only from Bank "personal"']);
  });

  test("a GitLab subgroup Consumer repo gets its Facets from a deeper consumers key", async () => {
    const acme = join(home, "banks", "acme");
    const cfg = join(acme, "memory-bank.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\n  grp/sub/repo: [service:order-service]\n`);
    writeFileSync(configPath, "banks:\n  acme: { path: ~/banks/acme }\nrules:\n  - { match: gitlab.com/grp/*/*, bank: acme }\n");
    setOrigin("git@gitlab.com:grp/sub/repo.git");

    const r = await ltm(repo, "query", "--json", "--type", "Exception");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolved_by).toBe("rules");
    expect(out.notes).toEqual([]);
    expect(out.results.map((x: { bank: string; path: string }) => `${x.bank}:${x.path}`)).toContain(`acme:${REDIS}`);
    expect(r.stderr).toBe("");

    const human = await ltm(repo, "query", "--type", "Exception");
    expect(human.stderr).not.toContain("not mapped");

    const v = await ltm(acme, "validate");
    expect(v.exitCode).toBe(0);
  });

  test("--bank expands ~/ itself when the shell did not (=form and quoted form)", async () => {
    const scratchHome = { HOME: home };
    for (const argv of [
      ["query", "--bank=~/banks/acme", "--type", "Exception"],
      ["query", "--bank", "~/banks/acme", "--type", "Exception"],
    ]) {
      const r = await run({ argv, cwd: repo, env: scratchHome });
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(lines(r.stdout)).toContainEqual(expect.stringContaining(REDIS));
    }
  });

  test("--bank ~/x with HOME unset names --bank once", async () => {
    // Absolute paths only: a `~/` path in the user config would fail on HOME first.
    writeFileSync(configPath, `banks:\n  acme: { path: ${join(home, "banks", "acme")} }\n`);
    const r = await run({ argv: ["query", "--bank=~/banks/acme"], cwd: repo, env: { LTM_CONFIG: configPath } });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.trim().split("\n")).toEqual(["ltm query: --bank: '~/banks/acme' needs HOME or USERPROFILE, and neither is set"]);
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

describe("ltm query from a Consumer repo, under query.org_wide (#159)", () => {
  const exclude = (name: string) => {
    const cfg = join(home, "banks", name, "memory-bank.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\nquery:\n  org_wide: exclude\n`);
  };
  const orgWide = [ORG_RULE, ORG_EXC, ORG_CTX];

  // A mapped repo queries by its Facets, so exclude hides Org-wide Records from it too. That's
  // intended, since under exclude Facet matching reads only the Record's own applies_to.
  test("org_wide exclude: a mapped Consumer repo stops seeing Org-wide Records", async () => {
    exclude("acme");
    exclude("personal");
    const r = await ltm(repo, "query", "--json");
    expect(r.exitCode).toBe(0);
    const got = JSON.parse(r.stdout).results.map((x: { path: string }) => x.path) as string[];
    expect(got).toContain(REDIS);
    for (const p of orgWide) expect(got).not.toContain(p);
  });

  test("two Banks, two settings: each Bank's org_wide applies to its own rows", async () => {
    exclude("acme");
    const r = await ltm(repo, "query", "--json", "--facet", "service:order-service");
    expect(r.exitCode).toBe(0);
    const got = JSON.parse(r.stdout).results.map((x: { bank: string; path: string }) => `${x.bank}:${x.path}`) as string[];
    expect(got.filter((x) => x.endsWith(ORG_RULE))).toEqual([`personal:${ORG_RULE}`]);
    for (const p of orgWide) expect(got).not.toContain(`acme:${p}`);
    expect(got).toContain(`acme:${REDIS}`);
  });
});
