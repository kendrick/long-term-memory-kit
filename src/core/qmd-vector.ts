import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { MemoryType } from "./bank.ts";
import { hitRecord, qmdCollections, RecallError, type QmdBackend, type Recall } from "./qmd.ts";
import type { Op, Query, Results, Status } from "./qmd-vector-worker.ts";
// Bun hands back a `with { type: "text" }` import as the file's source; tsc sees only the module, hence the cast.
import * as workerText from "./qmd-vector-worker.ts" with { type: "text" };
import type { Hit } from "./recall.ts";
import type { ParsedRecord } from "./record.ts";
import { byCodeUnit, firstLine } from "./text.ts";

const WORKER_SOURCE = (workerText as unknown as { default: string }).default;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function qmdVectorBackend(
  recall: Recall,
  root: string,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): QmdBackend & {
  prefetch(records: ParsedRecord[]): void;
  prefetchQueries(queries: Query[]): void;
} {
  const { collections } = recall;
  const { qmd, collectionRoots, checkAll, collectionOf, indexed } = qmdCollections(collections, env);
  const cache = new Map<string, Results["results"][number]>();
  let pkg: string | undefined;
  let bankRoot: string | undefined;

  const worker = <T>(request: Op): T | string => {
    // A compiled ltm can't resolve qmd's own dependencies from disk, but BUN_BE_BUN turns it back into plain bun, which can.
    // Real bun ignores the variable, and node-llama-cpp's forks inherit it, so they run as bun too instead of as ltm.
    const r = spawnSync(process.execPath, ["-e", WORKER_SOURCE], {
      input: JSON.stringify({ ...request, pkg }),
      env: { ...env, BUN_BE_BUN: "1" },
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

  const prefetchQueries = (queries: Query[]) => {
    if (queries.length === 0) return;
    const res = worker<Results>({ op: "search", queries });
    if (typeof res === "string") throw new RecallError(`qmd vector search failed: ${res}`);
    queries.forEach((q, i) => cache.set(`${q.collection}\0${q.text}`, res.results[i] ?? []));
  };

  return {
    queryText,
    collectionOf,
    indexed,
    preflight() {
      const located = qmd(["skills", "path"]);
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
      const problem = checkAll();
      if (problem) return problem;
      const types = (Object.keys(collections) as MemoryType[]).sort(byCodeUnit);
      const status = worker<Status>({ op: "status", collections: types.map((t) => collections[t]!) });
      if (typeof status === "string") return `qmd vector status failed: ${status}`;
      for (const type of types) {
        const name = collections[type]!;
        const { hashes, pending } = status.collections.find((c) => c.name === name) ?? { hashes: 0, pending: 0 };
        if (hashes === 0 || pending >= hashes) {
          return `recall.collections.${type}: qmd collection '${name}' has no embeddings for qmd's current embedding model; run qmd embed`;
        }
        if (pending > 0) warn(`collection '${name}': ${pending} of ${hashes} documents need embedding; run qmd embed`);
      }
      return null;
    },
    // One worker call for every lookup: the model load (seconds) dwarfs a lookup (~7 ms).
    prefetchQueries,
    prefetch(records) {
      const queries: Query[] = [];
      for (const r of records) {
        const collection = collectionOf(r);
        const text = queryText(r);
        if (collection !== undefined && text !== null) queries.push({ collection, text });
      }
      prefetchQueries(queries);
    },
    search(records, text) {
      const collection = records[0] && collectionOf(records[0]);
      if (collection === undefined) return [];
      const found = cache.get(`${collection}\0${text}`) ?? [];
      // preflight's checkAll filled collectionRoots for every configured collection.
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
