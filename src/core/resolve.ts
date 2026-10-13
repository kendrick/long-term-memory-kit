import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";
import { ConfigError, isMapping, loadConfig, type BankConfig } from "./bank.ts";

// Callers pass env in, so `ltm mcp` can resolve for another environment and tests
// never read a developer's real HOME.
export type Env = Record<string, string | undefined>;

export type RemoteIdentity = { host: string; org: string; repo: string };

export type ResolvedBank = { name: string; root: string; url: string | null; config: BankConfig };

export type ResolvedBy = "flag" | "ltm.yaml" | "rules" | "default";

export type Resolution = {
  banks: ResolvedBank[];
  resolvedBy: ResolvedBy | null;
  checked: string[];
};

export type UserBank = { path: string; url: string | null; line: number | null };

export type UserConfig = {
  banks: Record<string, UserBank>;
  rules: { match: string; bank: string }[];
  default: string | null;
};

export type LoadedUserConfig = { path: string; config: UserConfig | null };

const REPO_CONFIG = ".ltm.yaml";
const BANK_CONFIG = "memory-bank.yaml";

const firstLine = (s: string): string => s.split("\n")[0] ?? s;

const stripGit = (s: string): string => (s.endsWith(".git") ? s.slice(0, -4) : s);

function identityFromPath(host: string, path: string): RemoteIdentity | null {
  const segs = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (segs.length !== 2) return null;
  const org = segs[0] ?? "";
  const repo = stripGit(segs[1] ?? "");
  if (host === "" || org === "" || repo === "") return null;
  return { host: host.toLowerCase(), org, repo };
}

export function parseRemote(url: string): RemoteIdentity | null {
  const s = url.trim();
  if (/\s/.test(s)) return null;
  // scp-like syntax has no scheme, so URL can't parse it. Requiring `user@` keeps a
  // Windows path such as C:/x from reading as host C.
  const scp = /^[^@/:]+@([^/:]+):(?!\/)(.+)$/.exec(s);
  if (scp) return identityFromPath(scp[1] ?? "", scp[2] ?? "");
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (!["ssh:", "https:", "http:"].includes(parsed.protocol)) return null;
  return identityFromPath(parsed.hostname, parsed.pathname);
}

export function identityString(id: RemoteIdentity): string {
  return `${id.host}/${id.org}/${id.repo}`;
}

export function matchRule(match: string, identity: string): boolean {
  if (match === "*") return true;
  const want = match.split("/");
  const have = identity.split("/");
  return want.length === have.length && want.every((seg, i) => seg === "*" || seg === have[i]);
}

function locateUserConfig(env: Env, platform: string): string | null {
  if (env.LTM_CONFIG) return resolve(env.LTM_CONFIG);
  if (platform === "win32" && env.APPDATA) return win32.join(env.APPDATA, "ltm", "config.yaml");
  // The XDG spec says to ignore an empty or relative XDG_CONFIG_HOME.
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "ltm", "config.yaml");
  if (env.HOME) return join(env.HOME, ".config", "ltm", "config.yaml");
  return null;
}

export function userConfigPath(env: Env, platform: string = process.platform): string {
  const path = locateUserConfig(env, platform);
  if (path === null) {
    throw new ConfigError("user config", null, "set LTM_CONFIG, XDG_CONFIG_HOME, or HOME so ltm can find its user config");
  }
  return path;
}

// Stands in for the path in "rules in ..." messages when nothing locates a config.
const UNLOCATED = "user config (LTM_CONFIG, XDG_CONFIG_HOME, and HOME are unset)";

// Same CJS default-import workaround as validate.ts.
const Ajv2020 = Ajv2020Module.default;

let compiled: ValidateFunction | null = null;
function userConfigSchema(): ValidateFunction {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ allErrors: true });
  const schema = JSON.parse(readFileSync(new URL("../../schema/user-config.schema.json", import.meta.url), "utf8"));
  compiled = ajv.compile(schema);
  return compiled;
}

// Line of the deepest key on `segs` that exists, so a typo'd nested key points at itself
// rather than at `banks:`.
function lineAt(doc: Document, lc: LineCounter, segs: string[]): number | null {
  let node: unknown = doc.contents;
  let offset: number | null = null;
  for (const seg of segs) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg);
      if (!pair) break;
      if (isScalar(pair.key) && pair.key.range) offset = pair.key.range[0];
      node = pair.value;
    } else if (isSeq(node)) {
      const item = node.items[Number(seg)];
      if (!item) break;
      const range = (item as { range?: [number, number, number] }).range;
      if (range) offset = range[0];
      node = item;
    } else break;
  }
  return offset === null ? null : lc.linePos(offset).line;
}

const decodePointer = (seg: string): string => seg.replace(/~1/g, "/").replace(/~0/g, "~");

function errorPath(e: ErrorObject): string[] {
  const segs = e.instancePath === "" ? [] : e.instancePath.slice(1).split("/").map(decodePointer);
  if (e.keyword === "additionalProperties") segs.push(String(e.params.additionalProperty));
  return segs;
}

type ParsedYaml = { data: unknown; doc: Document; lc: LineCounter };

function parseYamlFile(path: string, text: string): ParsedYaml {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const err = doc.errors[0];
  if (err) throw new ConfigError(path, err.linePos?.[0]?.line ?? null, firstLine(err.message));
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (e) {
    // yaml enforces its alias-expansion limit only here, after a clean parse.
    if (e instanceof ReferenceError && e.message.includes("alias")) {
      throw new ConfigError(path, null, firstLine(e.message));
    }
    throw e;
  }
  return { data, doc, lc };
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(path, null, firstLine((e as Error).message));
  }
}

function expandPath(p: string, configPath: string, env: Env): string | null {
  if (p === "~" || p.startsWith("~/")) {
    if (!env.HOME) return null;
    return join(env.HOME, p.slice(1));
  }
  return resolve(dirname(configPath), p);
}

// An env with nothing to locate a config by (cron, a bare `env -i`) reads like a
// missing file: no user config. Throwing here would make `ltm query` outside a Bank
// fail on the env instead of naming the cwd it searched.
export function loadUserConfig(env: Env): LoadedUserConfig {
  const path = locateUserConfig(env, process.platform);
  if (path === null) return { path: UNLOCATED, config: null };
  const text = readOptional(path);
  if (text === null) return { path, config: null };
  const { data: parsed, doc, lc } = parseYamlFile(path, text);
  // An empty file sets nothing, which is valid.
  const data = parsed === null || parsed === undefined ? {} : parsed;

  const validate = userConfigSchema();
  if (!validate(data)) {
    // A typo'd key usually also trips `required` on its parent ({ pathh: x } lacks
    // `path`), so unknown keys go first: they name the actual mistake.
    const errors = [...(validate.errors ?? [])].sort(
      (a, b) => Number(b.keyword === "additionalProperties") - Number(a.keyword === "additionalProperties"),
    );
    const first = errors[0];
    const line = first ? lineAt(doc, lc, errorPath(first)) : null;
    const message = errors.map((e) => `${errorPath(e).join(".") || "(root)"}: ${e.message ?? e.keyword}`).join("; ");
    throw new ConfigError(path, line, message);
  }

  const raw = data as {
    banks?: Record<string, { path: string; url?: string }>;
    rules?: { match: string; bank: string }[];
    default?: string;
  };
  const banks: Record<string, UserBank> = {};
  for (const [name, b] of Object.entries(raw.banks ?? {})) {
    const line = lineAt(doc, lc, ["banks", name, "path"]);
    const root = expandPath(b.path, path, env);
    if (root === null) throw new ConfigError(path, line, `banks.${name}.path: '${b.path}' needs HOME, which is not set`);
    banks[name] = { path: root, url: b.url ?? null, line };
  }
  const known = (name: string): boolean => Object.hasOwn(banks, name);
  const rules = raw.rules ?? [];
  rules.forEach((r, i) => {
    if (!known(r.bank)) {
      const key = ["rules", String(i), "bank"];
      throw new ConfigError(path, lineAt(doc, lc, key), `${key.join(".")}: Bank '${r.bank}' is not in banks`);
    }
  });
  if (raw.default !== undefined && !known(raw.default)) {
    throw new ConfigError(path, lineAt(doc, lc, ["default"]), `default: Bank '${raw.default}' is not in banks`);
  }
  return { path, config: { banks, rules, default: raw.default ?? null } };
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const out = r.stdout.trim();
  return out === "" ? null : out;
}

// No repo and no origin are ordinary states for a scratch dir, so both come back as null.
export function repoIdentity(cwd: string): { root: string | null; remote: RemoteIdentity | null } {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return { root: null, remote: null };
  // --local: an unscoped lookup falls through to global/system config, which would give
  // every origin-less repo the same unrelated identity.
  const url = git(cwd, ["config", "--local", "--get", "remote.origin.url"]);
  return { root, remote: url === null ? null : parseRemote(url) };
}

function openBank(name: string, b: UserBank, configPath: string): ResolvedBank {
  const cfg = join(b.path, BANK_CONFIG);
  try {
    lstatSync(cfg);
  } catch {
    throw new ConfigError(configPath, b.line, `banks.${name}.path: no ${BANK_CONFIG} in ${b.path}`);
  }
  return { name, root: b.path, url: b.url, config: loadConfig(b.path) };
}

// .ltm.yaml lives in a Consumer repo that may be shared, so a typo there fails loudly
// instead of quietly falling through to rules and picking a different Bank.
function readRepoConfig(path: string, user: LoadedUserConfig): string[] | null {
  const text = readOptional(path);
  if (text === null) return null;
  const { data, doc, lc } = parseYamlFile(path, text);
  if (!isMapping(data)) throw new ConfigError(path, null, `${REPO_CONFIG} is not a YAML mapping`);
  for (const key of Object.keys(data)) {
    if (key !== "banks") throw new ConfigError(path, lineAt(doc, lc, [key]), `${key}: unknown key; ${REPO_CONFIG} takes only banks`);
  }
  const list = data.banks;
  const line = lineAt(doc, lc, ["banks"]);
  if (!Array.isArray(list) || list.length === 0 || !list.every((n) => typeof n === "string")) {
    throw new ConfigError(path, line, "banks: must list at least one Bank name");
  }
  for (const [i, name] of (list as string[]).entries()) {
    if (!user.config || !Object.hasOwn(user.config.banks, name)) {
      throw new ConfigError(path, lineAt(doc, lc, ["banks", String(i)]), `banks: Bank '${name}' is not in banks in ${user.path}`);
    }
  }
  return [...new Set(list as string[])];
}

export function resolveBanks(cwd: string, env: Env): Resolution {
  const user = loadUserConfig(env);
  const repo = repoIdentity(cwd);
  const repoConfig = repo.root === null ? null : join(repo.root, REPO_CONFIG);
  const checked = [
    repoConfig ?? `${REPO_CONFIG} (${cwd} is not in a git repo)`,
    `rules in ${user.path}`,
    `default in ${user.path}`,
  ];
  const open = (names: string[], resolvedBy: ResolvedBy): Resolution => {
    const banks = user.config?.banks ?? {};
    return {
      banks: names.map((n) => openBank(n, banks[n] as UserBank, user.path)),
      resolvedBy,
      checked,
    };
  };

  const fromRepo = repoConfig === null ? null : readRepoConfig(repoConfig, user);
  if (fromRepo !== null) return open(fromRepo, "ltm.yaml");
  if (user.config === null) return { banks: [], resolvedBy: null, checked };

  // Rules match an origin identity, so a repo without a parseable origin skips them.
  if (repo.remote !== null) {
    const id = identityString(repo.remote);
    const matched = user.config.rules.filter((r) => matchRule(r.match, id)).map((r) => r.bank);
    if (matched.length > 0) return open([...new Set(matched)], "rules");
  }
  if (user.config.default !== null) return open([user.config.default], "default");
  return { banks: [], resolvedBy: null, checked };
}

export function resolveBankFlag(value: string, cwd: string, env: Env): ResolvedBank {
  const user = loadUserConfig(env);
  const banks = user.config?.banks ?? {};
  if (Object.hasOwn(banks, value)) return openBank(value, banks[value] as UserBank, user.path);
  const root = resolve(cwd, value);
  const cfg = join(root, BANK_CONFIG);
  try {
    lstatSync(cfg);
  } catch {
    throw new ConfigError(cfg, null, `--bank '${value}' is neither a Bank in ${user.path} nor a directory holding ${BANK_CONFIG}`);
  }
  const config = loadConfig(root);
  const name = typeof config.raw.name === "string" && config.raw.name !== "" ? config.raw.name : basename(root);
  return { name, root, url: null, config };
}

export function noBankMessage(checked: string[]): string {
  const list =
    checked.length <= 2
      ? checked.join(" and ")
      : `${checked.slice(0, -1).join(", ")}, and ${checked[checked.length - 1]}`;
  return `no Bank for this repo; checked ${list}`;
}
