import { spawnSync } from "node:child_process";
import { isMapping, MEMORY_TYPES, type BankConfig, type MemoryType } from "./bank.ts";
import { tokenize, type Hit, type RecallBackend } from "./recall.ts";
import { byCodeUnit, firstLine } from "./text.ts";

// `query` isn't a mode: it reranks with a generative LLM, which ADR 0001 rules out (see ADR 0003).
export type Recall = {
  backend: "qmd";
  mode: "search" | "vsearch";
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
  if (mode !== "search" && mode !== "vsearch") {
    return { error: `recall.mode must be search or vsearch, not ${JSON.stringify(mode)}` };
  }
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
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): RecallBackend & { preflight(): string | null } {
  const { mode, collections } = recall;
  // The caller's env, not process.env: it decides which qmd runs and which index (XDG dirs) it reads.
  const qmd = (args: string[]) => spawnSync("qmd", args, { encoding: "utf8", env });
  const warned = new Set<string>();
  return {
    // Checks every collection up front, so a typo fails even when no type has two Records to compare.
    preflight() {
      for (const type of (Object.keys(collections) as MemoryType[]).sort(byCodeUnit)) {
        const name = collections[type]!;
        const r = qmd(["collection", "show", name]);
        if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "qmd not found on PATH";
        if (r.status !== 0) return `recall.collections.${type}: qmd has no collection '${name}'`;
      }
      return null;
    },
    search(records, text) {
      const type = records[0]?.frontmatter.memory_type;
      const collection = typeof type === "string" && Object.hasOwn(collections, type) ? collections[type as MemoryType] : undefined;
      // tokenize drops qmd's query syntax: a leading `-` negates a term, and an unbalanced `"` returns nothing.
      const tokens = tokenize(text);
      if (collection === undefined || tokens.length === 0) return [];
      const r = qmd([mode, tokens.join(" "), "--json", "--all", "-c", collection]);
      const stderr = (r.stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
      if (r.error) throw new RecallError(`qmd ${mode} failed: ${firstLine(r.error.message)}`);
      if (r.status !== 0) throw new RecallError(`qmd ${mode} failed: ${stderr[0] ?? `exit ${r.status}`}`);
      // An unembedded vsearch exits 0 with an empty result and says why only on stderr.
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
        const uri = file.replace(/\?.*$/s, "");
        if (!uri.startsWith(prefix)) continue;
        const rel = uri.slice(prefix.length);
        // qmd's path is relative to the collection root, which may sit anywhere under the Bank.
        const matches = records.filter((c) => c.path === rel || c.path.endsWith(`/${rel}`));
        if (matches.length === 1) hits.push({ record: matches[0]!, score });
      }
      return hits;
    },
  };
}
