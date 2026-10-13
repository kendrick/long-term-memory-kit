import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, YAMLParseError } from "yaml";

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
  if (isLink) throw new ConfigError(path, null, "memory-bank.yaml is a symlink, not followed");
}

function isFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

export function findBank(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    refuseSymlink(candidate);
    if (isFile(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
    raw = parse(text);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      throw new ConfigError(path, e.linePos?.[0]?.line ?? null, e.message);
    }
    // yaml throws a bare ReferenceError once alias expansion passes its limit. Keying on
    // "alias" keeps any other ReferenceError (a real bug) from being reported as a bad config.
    if (e instanceof ReferenceError && e.message.includes("alias")) {
      throw new ConfigError(path, null, e.message.split("\n")[0] ?? e.message);
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
