import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isMapping, MEMORY_TYPES, type BankConfig, type MemoryType } from "./bank.ts";
import { tokenize, type Hit, type RecallBackend } from "./recall.ts";
import { byCodeUnit, firstLine } from "./text.ts";

// `qmd vsearch` expands the query with a generative LLM and `qmd query` reranks with one, which ADR 0001 rules out (see ADR 0003).
export type Recall = {
  backend: "qmd";
  mode: "search";
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
  if (mode !== "search") return { error: `recall.mode must be search, not ${JSON.stringify(mode)}` };
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

export function qmdBackend(
  recall: Recall,
  root: string,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): RecallBackend & { preflight(): string | null } {
  const { mode, collections } = recall;
  // The caller's env, not process.env: it decides which qmd runs and which index (XDG dirs) it reads.
  // `--all` can print more than Bun's ~1 MiB default maxBuffer, which would fail the run with ENOBUFS.
  const qmd = (args: string[]) => spawnSync("qmd", args, { encoding: "utf8", env, maxBuffer: Infinity });
  const warned = new Set<string>();
  // realpath on both sides, since qmd stores a resolved path (macOS /tmp is /private/tmp).
  let bankRoot: string | undefined;
  const collectionRoots = new Map<string, string>();
  const show = (type: MemoryType): string | null => {
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
  return {
    // Checks every collection up front, so a typo fails even when no type has two Records to compare.
    preflight() {
      for (const type of (Object.keys(collections) as MemoryType[]).sort(byCodeUnit)) {
        const problem = show(type);
        if (problem) return problem;
      }
      return null;
    },
    search(records, text) {
      const type = records[0]?.frontmatter.memory_type;
      const collection = typeof type === "string" && Object.hasOwn(collections, type) ? collections[type as MemoryType] : undefined;
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
      const prefix = `qmd://${collection}/`;
      const hits: Hit[] = [];
      for (const el of parsed) {
        if (!isMapping(el) || typeof el.file !== "string") throw new RecallError(`qmd ${mode} returned an unreadable result`);
        const { score, file } = el;
        if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
          throw new RecallError(`qmd ${mode} returned score ${JSON.stringify(score)} for ${file}`);
        }
        // qmd 2.8.3 appends `?index=<name>` only for a non-default index; any other `?` belongs to the filename.
        const uri = file.replace(/\?index=[\w.!~*'()%-]*$/, "");
        if (!uri.startsWith(prefix)) continue;
        const rel = uri.slice(prefix.length);
        // A suffix match would hand the queried Record's self-hit to a namesake in a subfolder, so paths must match exactly.
        const abs = join(collectionRoot, rel);
        const match = records.find((c) => join(bankRoot!, c.path) === abs);
        if (match) hits.push({ record: match, score });
      }
      return hits;
    },
  };
}
