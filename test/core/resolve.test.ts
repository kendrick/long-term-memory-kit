import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../../src/core/bank.ts";
import {
  identityString,
  loadUserConfig,
  matchRule,
  noBankMessage,
  parseRemote,
  repoIdentity,
  resolveBankFlag,
  resolveBanks,
  userConfigPath,
} from "../../src/core/resolve.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

describe("parseRemote", () => {
  const want = { host: "github.com", org: "acme", repo: "order-service" };
  test.each([
    "git@github.com:acme/order-service.git",
    "git@github.com:acme/order-service",
    "https://github.com/acme/order-service",
    "https://github.com/acme/order-service.git",
    "https://github.com/acme/order-service/",
    "ssh://git@github.com/acme/order-service.git",
    "ssh://git@github.com:2222/acme/order-service.git",
    "http://github.com/acme/order-service",
    "https://GitHub.com/acme/order-service",
  ])("%s", (url) => {
    expect(parseRemote(url)).toEqual(want);
  });

  test.each(["ftp://x", "not a url", "", "https://github.com/acme"])("%p gives null", (url) => {
    expect(parseRemote(url)).toBeNull();
  });

  test.each([
    ["C:/acme/order-service", "linux"],
    ["C:/acme/order-service", "win32"],
    ["C:/x/y", "linux"],
    ["C:/x/y", "win32"],
    ["C:acme/order-service", "win32"],
    ["c:x/y", "win32"],
    ["x:grp/repo.git", "win32"],
  ])("%p gives null on %s", (url, platform) => {
    expect(parseRemote(url, platform)).toBeNull();
  });

  test.each([
    ["x:grp/repo.git", { host: "x", org: "grp", repo: "repo" }],
    ["C:acme/order-service", { host: "c", org: "acme", repo: "order-service" }],
  ])("%p parses as a host on linux", (url, want) => {
    expect(parseRemote(url, "linux")).toEqual(want);
  });

  test.each([
    ["git@gitlab.com:grp/sub/repo.git", { host: "gitlab.com", org: "grp/sub", repo: "repo" }],
    ["https://gitlab.com/grp/sub/repo", { host: "gitlab.com", org: "grp/sub", repo: "repo" }],
    ["github.com:acme/order-service.git", { host: "github.com", org: "acme", repo: "order-service" }],
    ["ssh://git@github.com/a/b/c/d.git", { host: "github.com", org: "a/b/c", repo: "d" }],
    ["https://github.com/a/b/c", { host: "github.com", org: "a/b", repo: "c" }],
    ["work:grp/repo.git", { host: "work", org: "grp", repo: "repo" }],
    ["gh:acme/order-service", { host: "gh", org: "acme", repo: "order-service" }],
    ["localhost:a/b", { host: "localhost", org: "a", repo: "b" }],
    ["https://h.com/a//b", null],
    ["https://h.com/only", null],
  ])("%s", (url, want) => {
    expect(parseRemote(url)).toEqual(want);
  });

  test("a subgroup identity keeps every org segment", () => {
    const id = parseRemote("git@gitlab.com:grp/sub/repo.git");
    expect(id && identityString(id)).toBe("gitlab.com/grp/sub/repo");
  });
});

describe("matchRule", () => {
  test("a * segment matches exactly one segment", () => {
    expect(matchRule("github.com/acme/*", "github.com/acme/x")).toBe(true);
    expect(matchRule("github.com/acme/*", "github.com/other/x")).toBe(false);
    expect(matchRule("github.com/acme/*", "github.com/acme/x/y")).toBe(false);
  });

  test("a lone * matches everything", () => {
    expect(matchRule("*", "github.com/acme/x")).toBe(true);
    expect(matchRule("*", "gitlab.example.com/a/b")).toBe(true);
  });

  test("a subgroup identity needs a pattern with as many segments", () => {
    expect(matchRule("gitlab.com/grp/*/*", "gitlab.com/grp/sub/repo")).toBe(true);
    expect(matchRule("gitlab.com/*/*", "gitlab.com/grp/sub/repo")).toBe(false);
  });
});

describe("userConfigPath", () => {
  test("LTM_CONFIG wins", () => {
    expect(userConfigPath({ LTM_CONFIG: "/c/ltm.yaml", XDG_CONFIG_HOME: "/x", HOME: "/h" }, "linux")).toBe("/c/ltm.yaml");
  });
  test("then XDG_CONFIG_HOME, then HOME", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" }, "linux")).toBe("/x/ltm/config.yaml");
    expect(userConfigPath({ HOME: "/h" }, "darwin")).toBe("/h/.config/ltm/config.yaml");
    expect(userConfigPath({ XDG_CONFIG_HOME: "", HOME: "/h" }, "linux")).toBe("/h/.config/ltm/config.yaml");
  });
  test("APPDATA on Windows", () => {
    expect(userConfigPath({ APPDATA: "C:\\Users\\k\\AppData\\Roaming", HOME: "/h" }, "win32")).toBe(
      "C:\\Users\\k\\AppData\\Roaming\\ltm\\config.yaml",
    );
  });
});

let tmp: string;
let home: string;
let configPath: string;
let repo: string;
let env: Record<string, string>;

const exampleConfig = `banks:
  acme:     { path: ~/banks/acme, url: git@github.com:acme/memory-bank.git }
  personal: { path: ~/banks/personal }
rules:
  - { match: github.com/acme/*, bank: acme }
  - { match: "*",               bank: personal }
default: personal
`;

function makeBank(name: string): string {
  const dir = join(home, "banks", name);
  cpSync(demoBank, dir, { recursive: true });
  const cfg = join(dir, "memory-bank.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^name:.*$/m, `name: ${name}`));
  return dir;
}

function sh(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function setOrigin(url: string): void {
  spawnSync("git", ["-C", repo, "remote", "remove", "origin"]);
  sh(repo, "remote", "add", "origin", url);
}

const names = (r: { banks: { name: string }[] }): string[] => r.banks.map((b) => b.name);

function configErrorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConfigError");
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ltm-resolve-")));
  home = join(tmp, "home");
  mkdirSync(home);
  configPath = join(tmp, "config.yaml");
  env = { LTM_CONFIG: configPath, HOME: home };
  makeBank("acme");
  makeBank("personal");
  repo = join(tmp, "order-service");
  mkdirSync(repo);
  sh(repo, "init", "-q");
  sh(repo, "remote", "add", "origin", "git@github.com:acme/order-service.git");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadUserConfig", () => {
  test("a missing file is no config, not an error", () => {
    expect(loadUserConfig(env)).toEqual({ path: configPath, config: null });
  });

  test("no variable that locates a config is no config, not an error", () => {
    expect(loadUserConfig({})).toEqual({
      path: "user config (LTM_CONFIG, XDG_CONFIG_HOME, and HOME are unset)",
      config: null,
    });
  });

  test("resolution with no locatable config names the cwd and fails without throwing", () => {
    const outside = join(tmp, "not-a-repo");
    mkdirSync(outside);
    const r = resolveBanks(outside, {});
    expect(r.banks).toEqual([]);
    expect(r.resolvedBy).toBeNull();
    expect(r.checked).toHaveLength(3);
    expect(r.checked[0]).toContain(outside);
  });

  test("expands ~/ with the given HOME and keeps url", () => {
    writeFileSync(configPath, exampleConfig);
    const { config } = loadUserConfig(env);
    expect(config?.banks.acme?.path).toBe(join(home, "banks", "acme"));
    expect(config?.banks.acme?.url).toBe("git@github.com:acme/memory-bank.git");
    expect(config?.banks.personal?.url).toBeNull();
    expect(config?.default).toBe("personal");
  });

  test("a ~/ path falls back to USERPROFILE when HOME is unset", () => {
    writeFileSync(configPath, exampleConfig);
    const { config } = loadUserConfig({ LTM_CONFIG: configPath, USERPROFILE: home });
    expect(config?.banks.acme?.path).toBe(join(home, "banks", "acme"));
  });

  test("HOME wins over USERPROFILE for a ~/ path", () => {
    writeFileSync(configPath, exampleConfig);
    const { config } = loadUserConfig({ LTM_CONFIG: configPath, HOME: home, USERPROFILE: join(tmp, "decoy") });
    expect(config?.banks.acme?.path).toBe(join(home, "banks", "acme"));
  });

  test("a ~/ path with neither HOME nor USERPROFILE throws ConfigError", () => {
    writeFileSync(configPath, exampleConfig);
    const e = configErrorOf(() => loadUserConfig({ LTM_CONFIG: configPath }));
    expect(e.path).toBe(configPath);
    expect(e.message).toContain("needs HOME or USERPROFILE, and neither is set");
  });

  test("a relative path resolves against the config file's directory", () => {
    writeFileSync(configPath, "banks:\n  acme: { path: home/banks/acme }\n");
    expect(loadUserConfig(env).config?.banks.acme?.path).toBe(join(tmp, "home", "banks", "acme"));
  });

  test("an unknown nested key names the file, the key, and its line", () => {
    writeFileSync(configPath, "banks:\n  acme:\n    pathh: x\n");
    const e = configErrorOf(() => loadUserConfig(env));
    expect(e.path).toBe(configPath);
    expect(e.message).toContain("banks.acme.pathh");
    expect(e.line).toBe(3);
  });

  test("the issue's one-line form of the typo also fails", () => {
    writeFileSync(configPath, "banks: { acme: { pathh: x } }\n");
    const e = configErrorOf(() => loadUserConfig(env));
    expect(e.path).toBe(configPath);
    expect(e.message).toContain("pathh");
  });

  test("a rule naming an unknown Bank fails, naming rules", () => {
    writeFileSync(configPath, 'banks:\n  acme: { path: x }\nrules:\n  - { match: "*", bank: nope }\n');
    const e = configErrorOf(() => loadUserConfig(env));
    expect(e.path).toBe(configPath);
    expect(e.message).toContain("rules");
    expect(e.message).toContain("nope");
    expect(e.line).toBe(4);
  });

  // A four-segment match can match a subgroup identity, so it is not on this list.
  test.each(["github.com/acme", "github.com//order-service", "a/b/", "gitlab.com/grp//repo"])(
    "a rule match that can never match (%s) fails, naming rules.0.match",
    (match) => {
      writeFileSync(configPath, `banks:\n  acme: { path: x }\nrules:\n  - { match: "${match}", bank: acme }\n`);
      const e = configErrorOf(() => loadUserConfig(env));
      expect(e.path).toBe(configPath);
      expect(e.message).toContain("rules.0.match");
    },
  );

  test("a lone * and a three-segment wildcard pattern still load", () => {
    writeFileSync(configPath, 'banks:\n  acme: { path: x }\nrules:\n  - { match: "*", bank: acme }\n  - { match: "github.com/*/order-*", bank: acme }\n');
    expect(loadUserConfig(env).config?.rules).toHaveLength(2);
  });

  test.each(["gitlab.com/grp/sub/repo", "gitlab.com/grp/*/*"])("a subgroup match (%s) loads", (match) => {
    writeFileSync(configPath, `banks:\n  acme: { path: x }\nrules:\n  - { match: "${match}", bank: acme }\n`);
    expect(loadUserConfig(env).config?.rules).toEqual([{ match, bank: "acme" }]);
  });

  test("a default naming an unknown Bank fails, naming default", () => {
    writeFileSync(configPath, "banks:\n  acme: { path: x }\ndefault: nope\n");
    expect(configErrorOf(() => loadUserConfig(env)).message).toContain("default");
  });

  test("an alias bomb is a ConfigError, not a crash", () => {
    const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    const ids = "abcdefghi";
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1];
      lines.push(`${ids[i]}: &${ids[i]} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]`);
    }
    writeFileSync(configPath, `${lines.join("\n")}\n`);
    const e = configErrorOf(() => loadUserConfig(env));
    expect(e.path).toBe(configPath);
    expect(e.message).toContain("alias");
  });
});

describe("repoIdentity", () => {
  test("reads the repo root and parses origin", () => {
    expect(repoIdentity(repo)).toEqual({ root: repo, remote: { host: "github.com", org: "acme", repo: "order-service" } });
  });

  test("outside a repo, both are null", () => {
    expect(repoIdentity(home)).toEqual({ root: null, remote: null });
  });

  test("an origin in global git config does not leak into an origin-less repo", () => {
    const globalCfg = join(tmp, "gitconfig");
    writeFileSync(globalCfg, '[remote "origin"]\n\turl = git@github.com:elsewhere/unrelated.git\n');
    const bare = join(tmp, "no-origin");
    mkdirSync(bare);
    sh(bare, "init", "-q");
    // Bun does not forward process.env writes to child processes, so run repoIdentity in a
    // child that really sees the global config.
    const resolveTs = fileURLToPath(new URL("../../src/core/resolve.ts", import.meta.url));
    const childEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg };
    const probe = spawnSync("git", ["-C", bare, "config", "--get", "remote.origin.url"], { encoding: "utf8", env: childEnv });
    expect(probe.stdout).toContain("elsewhere");
    const r = spawnSync(
      process.execPath,
      ["-e", `import { repoIdentity } from ${JSON.stringify(resolveTs)}; console.log(JSON.stringify(repoIdentity(${JSON.stringify(bare)})))`],
      { encoding: "utf8", env: childEnv },
    );
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ root: bare, remote: null });
  });
});

describe("resolveBanks", () => {
  // The falsifier from #17: each row changes the setup and checks which step fired.
  test("first source that yields Banks wins", () => {
    writeFileSync(configPath, exampleConfig);
    let r = resolveBanks(repo, env);
    expect(names(r)).toEqual(["acme", "personal"]);
    expect(r.resolvedBy).toBe("rules");

    writeFileSync(join(repo, ".ltm.yaml"), "banks: [personal]\n");
    r = resolveBanks(repo, env);
    expect(names(r)).toEqual(["personal"]);
    expect(r.resolvedBy).toBe("ltm.yaml");

    rmSync(join(repo, ".ltm.yaml"));
    writeFileSync(configPath, exampleConfig.replace(/^rules:\n(  - .*\n)+/m, ""));
    r = resolveBanks(repo, env);
    expect(names(r)).toEqual(["personal"]);
    expect(r.resolvedBy).toBe("default");

    writeFileSync(configPath, exampleConfig);
    setOrigin("https://github.com/other/x");
    r = resolveBanks(repo, env);
    expect(names(r)).toEqual(["personal"]);
    expect(r.resolvedBy).toBe("rules");
  });

  test("nothing resolvable lists the three places checked", () => {
    writeFileSync(configPath, "banks:\n  acme: { path: ~/banks/acme }\n");
    const r = resolveBanks(repo, env);
    expect(r.banks).toEqual([]);
    expect(r.checked).toEqual([join(repo, ".ltm.yaml"), `rules in ${configPath}`, `default in ${configPath}`]);
    expect(noBankMessage(r.checked)).toBe(
      `no Bank for this repo; checked ${join(repo, ".ltm.yaml")}, rules in ${configPath}, and default in ${configPath}`,
    );
  });

  test("with no user config file, the message names the path that would have been read", () => {
    const r = resolveBanks(repo, env);
    expect(r.banks).toEqual([]);
    expect(r.checked).toHaveLength(3);
    expect(r.checked[1]).toBe(`rules in ${configPath}`);
  });

  test("a resolved Bank carries its root, url, and loaded config", () => {
    writeFileSync(configPath, exampleConfig);
    const [acme] = resolveBanks(repo, env).banks;
    expect(acme?.root).toBe(join(home, "banks", "acme"));
    expect(acme?.url).toBe("git@github.com:acme/memory-bank.git");
    expect(acme?.config.raw.consumers).toEqual({ "acme/order-service": ["service:order-service", "domain:commerce"] });
  });

  test(".ltm.yaml naming a Bank missing from user config fails, naming the file", () => {
    writeFileSync(configPath, exampleConfig);
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [nope]\n");
    const e = configErrorOf(() => resolveBanks(repo, env));
    expect(e.path).toBe(join(repo, ".ltm.yaml"));
    expect(e.message).toContain("nope");
  });

  test("a resolved Bank whose path holds no memory-bank.yaml fails, naming the user config", () => {
    writeFileSync(configPath, "banks:\n  gone: { path: ~/nowhere }\ndefault: gone\n");
    const e = configErrorOf(() => resolveBanks(repo, env));
    expect(e.path).toBe(configPath);
    expect(e.message).toContain("banks.gone.path");
  });
});

describe("resolveBankFlag", () => {
  test("a name in user config wins", () => {
    writeFileSync(configPath, exampleConfig);
    const b = resolveBankFlag("personal", repo, env);
    expect(b.name).toBe("personal");
    expect(b.root).toBe(join(home, "banks", "personal"));
  });

  test("otherwise the value is a path relative to cwd, named by memory-bank.yaml", () => {
    const b = resolveBankFlag("../home/banks/acme", repo, env);
    expect(b.name).toBe("acme");
    expect(b.root).toBe(join(home, "banks", "acme"));
    expect(b.url).toBeNull();
  });

  test("a path Bank with no name falls back to the root's basename", () => {
    const dir = makeBank("unnamed-dir");
    const cfg = join(dir, "memory-bank.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^name:.*\n/m, ""));
    expect(readFileSync(cfg, "utf8")).not.toContain("name:");
    expect(resolveBankFlag(dir, repo, env).name).toBe("unnamed-dir");
  });

  test("neither a name nor a Bank path throws ConfigError", () => {
    expect(() => resolveBankFlag("nope", repo, env)).toThrow(ConfigError);
  });

  test("a leading ~/ expands under HOME, as user-config paths do", () => {
    const b = resolveBankFlag("~/banks/acme", repo, env);
    expect(b.name).toBe("acme");
    expect(b.root).toBe(join(home, "banks", "acme"));
  });

  test("a bare ~ resolves HOME itself", () => {
    writeFileSync(join(home, "memory-bank.yaml"), readFileSync(join(home, "banks", "acme", "memory-bank.yaml"), "utf8"));
    expect(resolveBankFlag("~", repo, env).root).toBe(home);
  });

  test("~ with HOME unset throws ConfigError naming --bank once", () => {
    const e = configErrorOf(() => resolveBankFlag("~/banks/acme", repo, { LTM_CONFIG: configPath }));
    expect(e.path).toBe("--bank");
    expect(e.message).toBe("'~/banks/acme' needs HOME or USERPROFILE, and neither is set");
  });

  test("~/ falls back to USERPROFILE when HOME is unset", () => {
    const b = resolveBankFlag("~/banks/acme", repo, { LTM_CONFIG: configPath, USERPROFILE: home });
    expect(b.root).toBe(join(home, "banks", "acme"));
  });

  test("~/ falls back to USERPROFILE when HOME is empty", () => {
    const b = resolveBankFlag("~/banks/acme", repo, { LTM_CONFIG: configPath, HOME: "", USERPROFILE: home });
    expect(b.root).toBe(join(home, "banks", "acme"));
  });

  test("HOME wins over USERPROFILE", () => {
    const decoy = join(tmp, "decoy");
    const b = resolveBankFlag("~/banks/acme", repo, { LTM_CONFIG: configPath, HOME: home, USERPROFILE: decoy });
    expect(b.root).toBe(join(home, "banks", "acme"));
  });

  test("~user/x is not expanded, matching user-config paths", () => {
    const e = configErrorOf(() => resolveBankFlag("~user/x", repo, env));
    expect(e.message).toContain("neither a Bank");
  });

  test("a user-config Bank literally named ~x resolves by name before any expansion", () => {
    writeFileSync(configPath, "banks:\n  ~x: { path: ~/banks/acme }\n");
    const b = resolveBankFlag("~x", repo, env);
    expect(b.root).toBe(join(home, "banks", "acme"));
  });

  // These names would expand, so only the lookup-before-expansion order lets them win.
  test.each(["~", "~/banks/acme"])("a user-config Bank named %p resolves by name, not under HOME", (name) => {
    const other = makeBank("other");
    writeFileSync(configPath, `banks:\n  "${name}": { path: ${other} }\n`);
    expect(resolveBankFlag(name, repo, env).root).toBe(other);
  });
});
