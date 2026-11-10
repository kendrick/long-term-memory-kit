import { lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { firstLine } from "./text.ts";

export type MemoryType = "Decision" | "PolicyRule" | "Exception" | "Context";

export const MEMORY_TYPES: readonly MemoryType[] = ["Decision", "PolicyRule", "Exception", "Context"];

// The schema states these only in prose (folders.description), not as a `default`
// keyword, so they live here; bank.test.ts checks the two still agree.
export const DEFAULT_FOLDERS: Record<MemoryType, string> = {
  Decision: "_memory/decisions",
  PolicyRule: "_memory/policy-rules",
  Exception: "_memory/exceptions",
  Context: "_memory/context",
};

export type BankConfig = {
  root: string;
  folders: Record<MemoryType, string>;
  raw: Record<string, unknown>;
};

export class ConfigError extends Error {
  constructor(
    public path: string,
    public line: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

const CONFIG_FILE = "memory-bank.yaml";
const SYMLINK_REFUSAL = "memory-bank.yaml is a symlink, not followed";

// A symlinked config lets a cloned, untrusted Bank point the CLI at a file outside
// it (or at a parent Bank's config), so it's refused outright. Stopping instead of
// continuing upward matters: skipping it would silently adopt a different Bank.
function refuseSymlink(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return;
  }
  if (isLink) throw new ConfigError(path, null, SYMLINK_REFUSAL);
}

// One lstat per candidate, so the symlink check and the file check can't disagree.
// Only ENOENT/ENOTDIR mean "no config here"; any other failure (EACCES on an
// unreadable directory) must stop the walk, or it would silently adopt a parent Bank.
export function findBank(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    let stat: Stats | undefined;
    try {
      stat = lstatSync(candidate);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new ConfigError(candidate, null, firstLine((e as Error).message));
      }
    }
    if (stat?.isSymbolicLink()) throw new ConfigError(candidate, null, SYMLINK_REFUSAL);
    if (stat?.isFile()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Forges treat owner and repo names case-insensitively, and the origin URL keeps whatever case the user cloned with.
export function consumerEntry(consumers: unknown, repo: string): unknown {
  if (!isMapping(consumers)) return undefined;
  if (Object.hasOwn(consumers, repo)) return consumers[repo];
  const lower = repo.toLowerCase();
  const key = Object.keys(consumers).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : consumers[key];
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Validation beyond "is it a YAML mapping" is `ltm validate`'s job (#9), so unknown
// keys and non-string folder values are ignored here rather than rejected. The one
// exception is a folder that escapes the Bank root: a cloned, untrusted Bank could
// otherwise point `query --json` at files outside it and print their frontmatter,
// and that can't wait for a separate validate run. A backslash is refused too: Bun's
// fs reads it as a separator in some calls and not others, so one value can name two paths.
export function loadConfig(root: string): BankConfig {
  const path = join(root, CONFIG_FILE);
  refuseSymlink(path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(path, null, (e as Error).message);
  }
  let raw: unknown;
  try {
    raw = parse(text, { logLevel: "error" });
  } catch (e) {
    if (e instanceof YAMLParseError) {
      throw new ConfigError(path, e.linePos?.[0]?.line ?? null, e.message);
    }
    // yaml throws a bare ReferenceError once alias expansion passes its limit. Keying on
    // "alias" keeps any other ReferenceError (a real bug) from being reported as a bad config.
    if (e instanceof ReferenceError && e.message.includes("alias")) {
      throw new ConfigError(path, null, firstLine(e.message));
    }
    throw e;
  }
  if (!isMapping(raw)) throw new ConfigError(path, null, "config is not a YAML mapping");
  const folders = { ...DEFAULT_FOLDERS };
  const override = raw.folders;
  if (isMapping(override)) {
    for (const type of MEMORY_TYPES) {
      const v = override[type];
      if (typeof v !== "string") continue;
      if (v.includes("\\")) {
        throw new ConfigError(path, null, `folders.${type} '${v}' contains a backslash`);
      }
      if (isAbsolute(v) || !isInside(root, resolve(root, v))) {
        throw new ConfigError(path, null, `folders.${type} '${v}' is outside the Bank root`);
      }
      folders[type] = v;
    }
  }
  return { root, folders, raw };
}

export type CustomKeyType = "string" | "boolean" | "integer" | "date";

export type CustomKey = { type: CustomKeyType; enum?: (string | number | boolean)[]; memory_types?: MemoryType[] };

const CUSTOM_KEY_TYPES: readonly string[] = ["string", "boolean", "integer", "date"];

const isNonEmptyList = <T>(v: unknown, ok: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.length > 0 && v.every(ok);

const isScalar = (x: unknown): x is string | number | boolean =>
  typeof x === "string" || typeof x === "number" || typeof x === "boolean";

const isMemoryType = (x: unknown): x is MemoryType => MEMORY_TYPES.includes(x as MemoryType);

// checkConfig reports a malformed entry, so skip it here. Checking Records against a broken declaration would bury that one finding under many.
export function customKeys(config: BankConfig): Map<string, CustomKey> {
  const out = new Map<string, CustomKey>();
  const raw = config.raw.custom_keys;
  if (!isMapping(raw)) return out;
  for (const [name, v] of Object.entries(raw)) {
    if (!isMapping(v) || typeof v.type !== "string" || !CUSTOM_KEY_TYPES.includes(v.type)) continue;
    if (Object.keys(v).some((k) => k !== "type" && k !== "enum" && k !== "memory_types")) continue;
    if (v.enum !== undefined && !isNonEmptyList(v.enum, isScalar)) continue;
    if (v.memory_types !== undefined && !isNonEmptyList(v.memory_types, isMemoryType)) continue;
    out.set(name, v as CustomKey);
  }
  return out;
}
