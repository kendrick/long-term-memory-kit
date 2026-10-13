import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import pkg from "../../package.json" with { type: "json" };
import { ConfigError, loadConfig, MEMORY_TYPES, type BankConfig, type MemoryType } from "../core/bank.ts";
import { canonicalScalar } from "../core/canonical.ts";
import {
  CLAUDE_REGION,
  COPILOT_REGION,
  DEFAULT_FACET_PREFIXES,
  normalizeRegion,
  readRegion,
  renderAgentsRegion,
  replaceRegion,
  stringList,
} from "../core/init.ts";
import type { Command } from "./run.ts";

const CONFIG_FILE = "memory-bank.yaml";
const MEMORY_GLOB = "_memory/**/*.md";
// Every config file Prettier 3 searches that is not .prettierrc.json, from its own
// config-searcher. Each one is either read before .prettierrc.json or would be shadowed by
// a new one, so init writes no .prettierrc.json while any of them exists.
const OTHER_PRETTIER = [
  ".prettierrc",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  "prettier.config.js",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.mts",
  "prettier.config.mts",
  ".prettierrc.cjs",
  "prettier.config.cjs",
  ".prettierrc.cts",
  "prettier.config.cts",
  ".prettierrc.toml",
];
// Prettier reads these two before .prettierrc.json, but only when they carry a `prettier` key.
const KEYED_PRETTIER = [
  { file: "package.json", parse: (t: string): unknown => JSON.parse(t) },
  { file: "package.yaml", parse: (t: string): unknown => parseYaml(t) },
];

function hasPrettierKey(dir: string, file: string, parse: (t: string) => unknown): boolean {
  const abs = join(dir, file);
  if (!existsSync(abs)) return false;
  try {
    const doc = parse(readFileSync(abs, "utf8"));
    return typeof doc === "object" && doc !== null && Boolean((doc as { prettier?: unknown }).prettier);
  } catch {
    return false; // Prettier ignores an unparseable manifest too.
  }
}

// Why a .prettierrc.json that init owns would lose to, or be unsafe to write beside, another
// config in dir; null when .prettierrc.json is the one Prettier will read there.
function prettierBlocker(dir: string): string | null {
  for (const { file, parse } of KEYED_PRETTIER) {
    if (hasPrettierKey(dir, file, parse)) return `${file} has a prettier key; add the _memory override there by hand`;
  }
  const hasJson = existsSync(join(dir, ".prettierrc.json"));
  // .prettierrc outranks .prettierrc.json; every other name ranks below it.
  if (existsSync(join(dir, ".prettierrc"))) {
    return hasJson
      ? ".prettierrc is read before .prettierrc.json; add the _memory override to it by hand"
      : "init can't tell .prettierrc's format; add the _memory override by hand";
  }
  if (hasJson) return null;
  const other = OTHER_PRETTIER.find((f) => existsSync(join(dir, f)));
  if (other === undefined) return null;
  return other === ".prettierrc.json5"
    ? "init can't safely edit .prettierrc.json5; add the _memory override by hand"
    : `${other} is not JSON; add the _memory override by hand`;
}

// Prettier searches up to the filesystem root, but the walk stops at the repo root: a
// personal dotfile like ~/.prettierrc must not change what a Bank commits, or init would
// give different files to each developer and to CI. No .git above dir (or in dir) means no walk.
function ancestorPrettierConfig(dir: string): string | null {
  if (existsSync(join(dir, ".git"))) return null;
  const ups: string[] = [];
  for (let up = dirname(dir); ; up = dirname(up)) {
    ups.push(up);
    if (existsSync(join(up, ".git"))) break;
    if (dirname(up) === up) return null;
  }
  for (const up of ups) {
    for (const { file, parse } of KEYED_PRETTIER) {
      if (hasPrettierKey(up, file, parse)) return join(up, file);
    }
    const found = [".prettierrc", ".prettierrc.json", ...OTHER_PRETTIER].find((f) => existsSync(join(up, f)));
    if (found !== undefined) return join(up, found);
  }
  return null;
}

type RecordSchema = { properties: Record<string, { description?: string }>; required: string[] };

let recordSchema: RecordSchema | undefined;
const loadRecordSchema = (): RecordSchema =>
  (recordSchema ??= JSON.parse(
    readFileSync(new URL("../../schema/record.schema.json", import.meta.url), "utf8"),
  ) as RecordSchema);

const loadTemplate = (name: string): { overrides: { files: unknown; options: unknown }[] } =>
  JSON.parse(readFileSync(new URL(`../../templates/formatters/${name}`, import.meta.url), "utf8"));

// `init --check` compares disk against this, so both paths render each region the same way.
export function renderRegions(config: BankConfig): { rel: string; region: string }[] {
  return [
    { rel: "AGENTS.md", region: renderAgentsRegion(config, loadRecordSchema()) },
    { rel: "CLAUDE.md", region: CLAUDE_REGION },
    { rel: ".github/copilot-instructions.md", region: COPILOT_REGION },
  ];
}

function folderProblem(value: string): string | undefined {
  const eq = value.indexOf("=");
  if (eq === -1) return `--folder '${value}' has no '=' (expected Type=path)`;
  const type = value.slice(0, eq);
  const path = value.slice(eq + 1);
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    return `--folder '${value}': '${type}' is not a memory type (expected ${MEMORY_TYPES.join(", ")})`;
  }
  if (path === "") return `--folder '${value}': path is empty`;
  // loadConfig refuses these too, but only after memory-bank.yaml is on disk; catching them
  // here keeps a bad flag from leaving a half-written Bank or writing outside dir.
  if (path.includes("\\")) return `--folder '${value}': path contains a backslash`;
  const norm = normalize(path);
  if (isAbsolute(path) || norm === ".." || norm.startsWith(`..${sep}`)) {
    return `--folder '${value}': path is outside the Bank root`;
  }
  return undefined;
}

let prefixPattern: RegExp | undefined;
// Read from the schema so this can't drift from what ltm validate enforces.
const loadPrefixPattern = (): RegExp =>
  (prefixPattern ??= new RegExp(
    (
      JSON.parse(readFileSync(new URL("../../schema/memory-bank.schema.json", import.meta.url), "utf8")) as {
        properties: { facet_prefixes: { items: { pattern: string } } };
      }
    ).properties.facet_prefixes.items.pattern,
  ));

function prefixProblem(values: string[]): string | undefined {
  const pattern = loadPrefixPattern();
  const seen = new Set<string>();
  for (const v of values) {
    if (!pattern.test(v)) return `--facet-prefix '${v}' doesn't match ${pattern.source}`;
    if (seen.has(v)) return `--facet-prefix '${v}' is given twice`;
    seen.add(v);
  }
  return undefined;
}

function folderOverrides(values: string[]): Partial<Record<MemoryType, string>> {
  const out: Partial<Record<MemoryType, string>> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    out[v.slice(0, eq) as MemoryType] = v.slice(eq + 1);
  }
  return out;
}

// Where a write to abs would really land: the nearest existing ancestor through realpath,
// plus the parts not created yet. null for a dangling link, which mkdir can't pass.
function realLocation(abs: string): string | null {
  const tail: string[] = [];
  for (let head = abs; ; head = dirname(head)) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      if (existsSync(head) || isLink(head) || dirname(head) === head) return null;
      tail.unshift(basename(head));
    }
  }
}

// Through a symlink, a write could land outside dir, and a CLAUDE.md -> AGENTS.md
// link (common) would get CLAUDE's region written over AGENTS'.
function isLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

function configText(name: string, prefixes: string[], folders: Partial<Record<MemoryType, string>>): string {
  // canonicalScalar only refuses non-scalars, and every value here is a string.
  const s = (v: string, inFlow: boolean) => canonicalScalar(v, inFlow) as string;
  const lines = ["schema: 1", `name: ${s(name, false)}`, `facet_prefixes: [${prefixes.map((p) => s(p, true)).join(", ")}]`];
  const set = MEMORY_TYPES.filter((t) => folders[t] !== undefined);
  if (set.length) lines.push("folders:", ...set.map((t) => `  ${t}: ${s(folders[t]!, false)}`));
  return `${lines.join("\n")}\n`;
}

function overrideFiles(config: BankConfig, templateFiles: unknown): unknown {
  const folders = MEMORY_TYPES.map((t) => config.folders[t]);
  if (folders.every((f) => f.startsWith("_memory/"))) return templateFiles;
  return [...new Set(folders.map((f) => `${f.replace(/\/+$/, "")}/**/*.md`))];
}

// An entry for the same `files` gets merged in place, so a rerun converges instead of stacking
// duplicates. The merge keeps the user's own keys, such as `excludeFiles` or `proseWrap`, and the
// template's options win on conflict, so `embeddedLanguageFormatting` stays "off".
function mergeOverrides(existing: string | null, entry: { files: unknown; options: unknown }): string {
  const cfg: unknown = existing === null ? {} : JSON.parse(existing);
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw new Error("not a JSON object");
  const obj = cfg as Record<string, unknown>;
  const overrides = obj.overrides ?? [];
  if (!Array.isArray(overrides)) throw new Error("`overrides` is not an array");
  const key = JSON.stringify(entry.files);
  const i = overrides.findIndex((o) => typeof o === "object" && o !== null && JSON.stringify((o as { files?: unknown }).files) === key);
  if (i === -1) overrides.push(entry);
  else {
    const existingEntry = overrides[i] as { options?: unknown };
    const prior = existingEntry.options;
    const existingOptions = typeof prior === "object" && prior !== null && !Array.isArray(prior) ? prior : {};
    overrides[i] = { ...existingEntry, options: { ...existingOptions, ...(entry.options as object) } };
  }
  return `${JSON.stringify({ ...obj, overrides }, null, 2)}\n`;
}

export const init: Command = {
  name: "init",
  summary: "Scaffold a Bank and its generated agent instructions (--check: report stale ones)",
  options: {
    name: { type: "string" },
    folder: { type: "string", multiple: true },
    "facet-prefix": { type: "string", multiple: true },
    check: { type: "boolean" },
  },
  positionals: [{ name: "dir", required: false }],
  checkArgs(_positionals, values) {
    // --check never writes, so a flag that shapes a new memory-bank.yaml has nothing to act on.
    if (values.check === true) {
      const given = (["name", "folder", "facet-prefix"] as const).find((k) => values[k] !== undefined);
      return given === undefined ? undefined : `--check can't be combined with --${given}`;
    }
    for (const v of stringList(values.folder)) {
      const problem = folderProblem(v);
      if (problem !== undefined) return problem;
    }
    return prefixProblem(stringList(values["facet-prefix"]));
  },
  async run(ctx) {
    const dir = resolve(ctx.cwd, ctx.positionals[0] ?? ".");
    const show = (abs: string) => abs.slice(dir.length + 1);

    if (ctx.values.check === true) {
      let config: BankConfig;
      if (!existsSync(join(dir, CONFIG_FILE))) {
        ctx.err(`ltm init --check: no ${CONFIG_FILE} in ${dir}\n`);
        return 1;
      }
      try {
        config = loadConfig(dir);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        ctx.err(`ltm init --check: ${e.path}${e.line === null ? "" : `:${e.line}`}: ${e.message.split("\n")[0]}\n`);
        return 1;
      }
      let stale = false;
      for (const { rel, region } of renderRegions(config)) {
        const abs = join(dir, rel);
        const onDisk = existsSync(abs) ? readRegion(readFileSync(abs, "utf8")) : null;
        if (onDisk !== normalizeRegion(region)) {
          ctx.out(`${rel}\n`);
          stale = true;
        }
      }
      return stale ? 1 : 0;
    }
    let failed = false;
    const fail = (abs: string, why: string) => {
      ctx.err(`ltm init: ${show(abs)}: ${why}\n`);
      failed = true;
    };

    // isLink sees only the last component, so a linked parent like `.github -> ../x` needs
    // the realpath check too.
    const realDir = realLocation(dir);
    const inside = (abs: string): boolean => {
      const real = realLocation(abs);
      if (realDir !== null && real !== null && (real === realDir || real.startsWith(realDir + sep))) return true;
      fail(abs, `resolves outside ${dir}, not written`);
      return false;
    };
    const writable = (abs: string): boolean => {
      if (!isLink(abs)) return inside(abs);
      fail(abs, "is a symlink, not written");
      return false;
    };
    const readOrNull = (abs: string): string | null => (existsSync(abs) ? readFileSync(abs, "utf8") : null);
    const writeIfChanged = (abs: string, text: string, before: string | null) => {
      if (text === before) return;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      ctx.out(`${before === null ? "created" : "updated"} ${show(abs)}\n`);
    };

    const configPath = join(dir, CONFIG_FILE);
    if (!existsSync(configPath) && !isLink(configPath)) {
      const prefixes = stringList(ctx.values["facet-prefix"]);
      const text = configText(
        typeof ctx.values.name === "string" ? ctx.values.name : basename(dir),
        prefixes.length ? prefixes : [...DEFAULT_FACET_PREFIXES],
        folderOverrides(stringList(ctx.values.folder)),
      );
      writeIfChanged(configPath, text, null);
    }

    let config: BankConfig;
    try {
      config = loadConfig(dir);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // yaml appends a multi-line code frame; the first line is the diagnosis.
      ctx.err(`ltm init: ${e.path}${e.line === null ? "" : `:${e.line}`}: ${e.message.split("\n")[0]}\n`);
      return 1;
    }

    for (const type of MEMORY_TYPES) {
      const folder = join(dir, config.folders[type]);
      // A linked memory folder is fine so long as it stays in dir.
      if (!inside(folder)) continue;
      if (!existsSync(folder)) {
        mkdirSync(folder, { recursive: true });
        ctx.out(`created ${show(folder)}/\n`);
      }
      if (readdirSync(folder).length === 0) writeIfChanged(join(folder, ".gitkeep"), "", null);
    }

    for (const { rel, region } of renderRegions(config)) {
      const abs = join(dir, rel);
      if (!writable(abs)) continue;
      const before = readOrNull(abs);
      let next: string;
      try {
        next = replaceRegion(before, region, pkg.version);
      } catch (e) {
        fail(abs, (e as Error).message);
        continue;
      }
      writeIfChanged(abs, next, before);
    }

    const formatters: { rel: string; template: string }[] = [{ rel: ".oxfmtrc.json", template: "oxfmtrc.json" }];
    let blocker = prettierBlocker(dir);
    if (blocker === null && !existsSync(join(dir, ".prettierrc.json"))) {
      const above = ancestorPrettierConfig(dir);
      if (above !== null) {
        blocker = `${relative(dir, above)} would be shadowed by a new .prettierrc.json here; add the _memory override to it by hand`;
      }
    }
    if (blocker === null) formatters.unshift({ rel: ".prettierrc.json", template: "prettierrc.json" });
    else ctx.err(`ltm init: warning: ${blocker} (see templates/formatters/prettierrc.json)\n`);
    for (const { rel, template } of formatters) {
      const abs = join(dir, rel);
      if (!writable(abs)) continue;
      const entry = loadTemplate(template).overrides[0]!;
      const before = readOrNull(abs);
      try {
        writeIfChanged(abs, mergeOverrides(before, { ...entry, files: overrideFiles(config, entry.files) }), before);
      } catch (e) {
        fail(abs, `can't merge the _memory override: ${(e as Error).message}`);
      }
    }

    const owners = join(dir, "CODEOWNERS.example");
    if (!existsSync(owners) && !isLink(owners)) {
      const lines = MEMORY_TYPES.map((t) => `/${config.folders[t].replace(/\/+$/, "")}/ @your-org/memory-maintainers\n`);
      writeIfChanged(owners, [...new Set(lines)].join(""), null);
    }

    return failed ? 1 : 0;
  },
};
