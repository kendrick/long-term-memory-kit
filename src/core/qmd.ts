import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { isMapping, MEMORY_TYPES, type BankConfig, type MemoryType } from "./bank.ts";
import type { Query } from "./qmd-vector-worker.ts";
import type { ParsedRecord } from "./record.ts";
import { tokenize, type Hit, type RecallBackend } from "./recall.ts";
import { byCodeUnit, firstLine } from "./text.ts";

// `qmd vsearch` expands the query with a generative LLM and `qmd query` reranks with one, which ADR 0001 rules out (see ADR 0003).
// `vector` runs the library's searchVector, which only embeds (see ADR 0004).
export type Recall = {
  backend: "qmd";
  mode: "search" | "vector";
  collections: Partial<Record<MemoryType, string>>;
};

export class RecallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecallError";
  }
}

const RECALL_KEYS = ["backend", "mode", "collections"];

export function loadRecall(config: BankConfig): Recall | null | { error: string } {
  const raw = config.raw.recall;
  if (raw === undefined) return null;
  if (!isMapping(raw)) return { error: "recall is not a mapping" };
  for (const key of Object.keys(raw)) {
    if (!RECALL_KEYS.includes(key)) return { error: `recall.${key}: unknown key` };
  }
  if (raw.backend !== "qmd") return { error: "recall.backend must be qmd" };
  const mode = raw.mode;
  if (mode !== "search" && mode !== "vector") return { error: `recall.mode must be search or vector, not ${JSON.stringify(mode)}` };
  const collections = raw.collections;
  if (!isMapping(collections) || Object.keys(collections).length === 0) {
    return { error: "recall.collections must map a memory_type to a qmd collection" };
  }
  for (const key of Object.keys(collections)) {
    if (!(MEMORY_TYPES as readonly string[]).includes(key)) return { error: `recall.collections.${key}: unknown memory_type` };
  }
  for (const [key, name] of Object.entries(collections)) {
    if (typeof name !== "string" || name === "") return { error: `recall.collections.${key} must be a collection name` };
  }
  return { backend: "qmd", mode, collections: { ...(collections as Partial<Record<MemoryType, string>>) } };
}

// `prefetch` lets the vector backend batch every lookup into one model load before runDoctor calls `search`.
export type QmdBackend = RecallBackend & {
  preflight(): string | null;
  prefetch?(records: ParsedRecord[]): void;
  prefetchQueries?(queries: Query[]): void;
  collectionOf(record: ParsedRecord): string | undefined;
  // Absolute, realpath'd paths of every active file qmd has indexed in this collection.
  indexed(collection: string): Set<string>;
};

export type QmdCommand = { file: string; prefix: string[] } | { problem: string };

// Pinned to the shim text npm's cmd-shim (v6–v8) writes for a node bin; anything else isn't safe to run without cmd.exe.
export function npmShimTarget(text: string): string | null {
  if (!/SET "_prog=node"/i.test(text)) return null;
  return /"%_prog%"\s+"%dp0%\\([^"\r\n]+)"\s+%\*\s*$/m.exec(text)?.[1] ?? null;
}

// Bun spawns any .cmd through cmd.exe, which expands %VAR% in args, so run the shim's script under node instead.
function npmShimCommand(shim: string, PATH: string): QmdCommand {
  let target: string | null = null;
  try {
    target = npmShimTarget(readFileSync(shim, "utf8"));
  } catch {}
  if (target === null) return { problem: `${shim} is not an npm shim, and ltm won't run qmd through cmd.exe` };
  const dir = dirname(shim);
  const script = join(dir, target);
  if (!existsSync(script)) return { problem: `${shim} points at ${script}, which does not exist` };
  const local = join(dir, "node.exe");
  const node = existsSync(local) ? local : Bun.which("node", { PATH });
  if (node === null) return { problem: `${shim} needs node, which is not on PATH` };
  return { file: node, prefix: [script] };
}

export function qmdCommand(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): QmdCommand {
  if (platform !== "win32") return { file: "qmd", prefix: [] };
  // A plain object copied from Windows process.env keeps the `Path` key, and its lookups are case-sensitive.
  const PATH = env.PATH ?? env.Path ?? env.path ?? "";
  const found = Bun.which("qmd", { PATH });
  // Unresolved stays bare, so spawnSync's ENOENT still reads as "qmd not found on PATH".
  if (found === null) return { file: "qmd", prefix: [] };
  // npm also writes an extensionless sh script beside qmd.cmd, and Windows can't run it.
  const hit = extname(found) === "" && existsSync(`${found}.cmd`) ? `${found}.cmd` : found;
  return /\.(cmd|bat)$/i.test(hit) ? npmShimCommand(hit, PATH) : { file: hit, prefix: [] };
}

export function qmdCollections(collections: Partial<Record<MemoryType, string>>, env: Record<string, string | undefined>) {
  // The caller's env, not process.env: it decides which qmd runs and which index (XDG dirs) it reads.
  const program = qmdCommand(env);
  const spawn = (args: string[], spawnEnv: Record<string, string | undefined>) => {
    if ("problem" in program) throw new RecallError(program.problem);
    // `--all` can print more than Bun's ~1 MiB default maxBuffer, which would fail the run with ENOBUFS.
    return spawnSync(program.file, [...program.prefix, ...args], { encoding: "utf8", env: spawnEnv, maxBuffer: Infinity });
  };
  const qmd = (args: string[]) => spawn(args, env);
  // realpath on both sides, since qmd stores a resolved path (macOS /tmp is /private/tmp).
  const collectionRoots = new Map<string, string>();
  const show = (type: MemoryType): string | null => {
    if ("problem" in program) return program.problem;
    const name = collections[type]!;
    const r = qmd(["collection", "show", name]);
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "qmd not found on PATH";
    if (r.status !== 0) return `recall.collections.${type}: qmd has no collection '${name}'`;
    const path = /^\s*Path:\s+(.+?)\s*$/m.exec(r.stdout ?? "")?.[1];
    if (path === undefined) return `recall.collections.${type}: qmd collection show '${name}' printed no Path`;
    try {
      collectionRoots.set(name, realpathSync(path));
    } catch {
      return `recall.collections.${type}: qmd collection '${name}' points at ${path}, which does not exist`;
    }
    return null;
  };
  // Checks every collection up front, so a typo fails even when no type has two Records to compare.
  const checkAll = (): string | null => {
    for (const type of (Object.keys(collections) as MemoryType[]).sort(byCodeUnit)) {
      const problem = show(type);
      if (problem) return problem;
    }
    return null;
  };
  const collectionOf = (record: ParsedRecord): string | undefined => {
    // The folder decides memory_type (see matches() in query.ts); a drifted header must not pick the collection.
    const type = record.memoryType;
    return Object.hasOwn(collections, type) ? collections[type] : undefined;
  };
  const indexed = (name: string): Set<string> => {
    if (!collectionRoots.has(name)) {
      const type = (Object.keys(collections) as MemoryType[]).find((t) => collections[t] === name);
      const problem = type === undefined ? null : show(type);
      if (problem) throw new RecallError(problem);
    }
    const collectionRoot = collectionRoots.get(name);
    // NO_COLOR keeps qmd from wrapping the path in escape codes when stdout is a TTY.
    const r = spawn(["ls", name], { ...env, NO_COLOR: "1" });
    if (r.error) throw new RecallError(`qmd ls ${name} failed: ${firstLine(r.error.message)}`);
    if (r.status !== 0) {
      const first = (r.stderr ?? "").split("\n").find((l) => l.trim() !== "")?.trim();
      throw new RecallError(`qmd ls ${name} failed: ${first ?? `exit ${r.status}`}`);
    }
    const prefix = `qmd://${name}/`;
    const files = new Set<string>();
    for (const line of (r.stdout ?? "").split("\n")) {
      const at = line.indexOf(` ${prefix}`);
      if (at >= 0 && collectionRoot !== undefined) files.add(join(collectionRoot, line.slice(at + 1 + prefix.length).trimEnd()));
    }
    return files;
  };
  const problem = "problem" in program ? program.problem : null;
  return { qmd, problem, collectionRoots, show, checkAll, collectionOf, indexed };
}

export function hitRecord(
  file: string,
  collection: string,
  collectionRoot: string,
  bankRoot: string,
  records: ParsedRecord[],
): ParsedRecord | undefined {
  // qmd 2.8.3 appends `?index=<name>` only for a non-default index; any other `?` belongs to the filename.
  const uri = file.replace(/\?index=[\w.!~*'()%-]*$/, "");
  const prefix = `qmd://${collection}/`;
  if (!uri.startsWith(prefix)) return undefined;
  // A suffix match would hand the queried Record's self-hit to a namesake in a subfolder, so paths must match exactly.
  const abs = join(collectionRoot, uri.slice(prefix.length));
  return records.find((c) => join(bankRoot, c.path) === abs);
}

export function qmdBackend(
  recall: Recall,
  root: string,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): QmdBackend {
  const { mode, collections } = recall;
  const warned = new Set<string>();
  const { qmd, collectionRoots, show, checkAll, collectionOf, indexed } = qmdCollections(collections, env);
  let bankRoot: string | undefined;
  return {
    preflight: checkAll,
    collectionOf,
    indexed,
    search(records, text) {
      const type = records[0]?.memoryType;
      const collection = records[0] && collectionOf(records[0]);
      // tokenize drops qmd's query syntax: a leading `-` negates a term, and an unbalanced `"` returns nothing.
      const tokens = tokenize(text);
      if (collection === undefined || tokens.length === 0) return [];
      if (!collectionRoots.has(collection)) {
        const problem = show(type as MemoryType);
        if (problem) throw new RecallError(problem);
      }
      const collectionRoot = collectionRoots.get(collection)!;
      bankRoot ??= realpathSync(root);
      const r = qmd([mode, tokens.join(" "), "--json", "--all", "-c", collection]);
      const stderr = (r.stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
      if (r.error) throw new RecallError(`qmd ${mode} failed: ${firstLine(r.error.message)}`);
      if (r.status !== 0) throw new RecallError(`qmd ${mode} failed: ${stderr[0] ?? `exit ${r.status}`}`);
      // qmd can exit 0 and still explain itself on stderr, so warn with each stderr line once.
      for (const line of stderr) {
        if (!warned.has(line)) {
          warned.add(line);
          warn(line);
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        parsed = undefined;
      }
      if (!Array.isArray(parsed)) throw new RecallError(`qmd ${mode} returned an unreadable result`);
      const hits: Hit[] = [];
      for (const el of parsed) {
        if (!isMapping(el) || typeof el.file !== "string") throw new RecallError(`qmd ${mode} returned an unreadable result`);
        const { score, file } = el;
        if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
          throw new RecallError(`qmd ${mode} returned score ${JSON.stringify(score)} for ${file}`);
        }
        const match = hitRecord(file, collection, collectionRoot, bankRoot, records);
        if (match) hits.push({ record: match, score });
      }
      return hits;
    },
  };
}
