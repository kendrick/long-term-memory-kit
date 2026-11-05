import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryType } from "./bank.ts";
import { collectionCheck, hitRecord, RecallError, type Recall } from "./qmd.ts";
import type { Hit, RecallBackend } from "./recall.ts";
import type { ParsedRecord } from "./record.ts";
import { byCodeUnit, firstLine } from "./text.ts";

const WORKER = fileURLToPath(new URL("./qmd-vector-worker.ts", import.meta.url));

type Status = { collections: { name: string; active: number; pending: number }[] };
type Results = { results: { filepath: string; score: number }[][] };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function qmdVectorBackend(
  recall: Recall,
  root: string,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): RecallBackend & { preflight(): string | null; prefetch(records: ParsedRecord[]): void } {
  const { collections } = recall;
  const qmd = (args: string[]) => spawnSync("qmd", args, { encoding: "utf8", env, maxBuffer: Infinity });
  const { collectionRoots, show } = collectionCheck(collections, qmd);
  const cache = new Map<string, Results["results"][number]>();
  let pkg: string | undefined;
  let bankRoot: string | undefined;

  // Returns the parsed response, or the worker's first stderr line.
  const worker = <T>(request: object): T | string => {
    const r = spawnSync(process.execPath, [WORKER], {
      input: JSON.stringify({ ...request, pkg }),
      env,
      encoding: "utf8",
      maxBuffer: Infinity,
    });
    if (r.error) return firstLine(r.error.message);
    if (r.status !== 0) return (r.stderr ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? `exit ${r.status}`;
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      return "unreadable worker output";
    }
  };

  const queryText = (record: ParsedRecord): string | null => {
    const { title, summary } = record.frontmatter;
    const parts = [title, summary].filter(nonEmpty).map((s) => s.trim());
    return parts.length === 0 ? null : parts.join(". ");
  };
  const collectionOf = (record: ParsedRecord): string | undefined => {
    const type = record.frontmatter.memory_type;
    return typeof type === "string" && Object.hasOwn(collections, type) ? collections[type as MemoryType] : undefined;
  };

  return {
    queryText,
    preflight() {
      const located = spawnSync("qmd", ["skills", "path"], { encoding: "utf8", env });
      if ((located.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "qmd not found on PATH";
      const printed = (located.stdout ?? "").trim();
      if (located.status !== 0 || basename(printed) !== "skills") return "qmd skills path printed no package path";
      pkg = dirname(printed);
      let manifest: { name?: unknown; version?: unknown };
      try {
        manifest = JSON.parse(readFileSync(`${pkg}/package.json`, "utf8"));
      } catch {
        return `qmd at ${pkg} is not @tobilu/qmd`;
      }
      if (manifest.name !== "@tobilu/qmd") return `qmd at ${pkg} is not @tobilu/qmd`;
      if (String(manifest.version).split(".")[0] !== "2") {
        return `recall.mode vector needs qmd 2.x, found ${String(manifest.version)}`;
      }
      const types = (Object.keys(collections) as MemoryType[]).sort(byCodeUnit);
      for (const type of types) {
        const problem = show(type);
        if (problem) return problem;
      }
      const status = worker<Status>({ op: "status", collections: types.map((t) => collections[t]!) });
      if (typeof status === "string") return `qmd vector status failed: ${status}`;
      for (const type of types) {
        const name = collections[type]!;
        const { active, pending } = status.collections.find((c) => c.name === name) ?? { active: 0, pending: 0 };
        if (active === 0 || pending >= active) {
          return `recall.collections.${type}: qmd collection '${name}' has no embeddings for qmd's current embedding model; run qmd embed`;
        }
        if (pending > 0) warn(`collection '${name}': ${pending} of ${active} documents need embedding; run qmd embed`);
      }
      return null;
    },
    // One worker call for every lookup: the model load (seconds) dwarfs a lookup (~7 ms).
    prefetch(records) {
      const queries: { collection: string; text: string }[] = [];
      for (const r of records) {
        const collection = collectionOf(r);
        const text = queryText(r);
        if (collection !== undefined && text !== null) queries.push({ collection, text });
      }
      if (queries.length === 0) return;
      const res = worker<Results>({ op: "search", queries });
      if (typeof res === "string") throw new RecallError(`qmd vector search failed: ${res}`);
      queries.forEach((q, i) => cache.set(`${q.collection}\0${q.text}`, res.results[i] ?? []));
    },
    search(records, text) {
      const collection = records[0] && collectionOf(records[0]);
      if (collection === undefined) return [];
      const found = cache.get(`${collection}\0${text}`) ?? [];
      if (!collectionRoots.has(collection)) {
        const problem = show(records[0]!.frontmatter.memory_type as MemoryType);
        if (problem) throw new RecallError(problem);
      }
      const collectionRoot = collectionRoots.get(collection)!;
      bankRoot ??= realpathSync(root);
      const hits: Hit[] = [];
      for (const { filepath, score } of found) {
        // Cosine similarity: anything else means the library changed under us.
        if (typeof score !== "number" || !Number.isFinite(score) || score < -1 || score > 1) {
          throw new RecallError(`qmd vector returned score ${JSON.stringify(score)} for ${filepath}`);
        }
        const match = hitRecord(filepath, collection, collectionRoot, bankRoot, records);
        if (match) hits.push({ record: match, score });
      }
      return hits;
    },
  };
}
