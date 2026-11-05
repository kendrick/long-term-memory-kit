// Runs as a child of `ltm`, never in-process: qmd's library reads process.env (index, model dirs) directly, and ltm runs on the caller's env.
// qmd-vector.ts passes this file's source to `bun -e`, so it runs on load and imports only node builtins. One request on stdin, one JSON response on stdout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Query = { collection: string; text: string };
export type Op = { op: "status"; collections: string[] } | { op: "search"; queries: Query[] };
export type Request = { pkg: string } & Op;
// `hashes` and `pending` both count distinct content hashes, since that is the unit getHashesNeedingEmbedding reports in.
export type Status = { collections: { name: string; hashes: number; pending: number }[] };
export type Results = { results: { filepath: string; score: number }[][] };

async function handle(req: Request): Promise<Status | Results> {
  const manifest = JSON.parse(readFileSync(join(req.pkg, "package.json"), "utf8"));
  const lib = await import(pathToFileURL(join(req.pkg, manifest.exports["."].import)).href);
  const qmdStore = await import(pathToFileURL(join(req.pkg, "dist/store.js")).href);
  const { configExists, getConfigPath, findLocalConfigPath, getLocalDbPath } = await import(pathToFileURL(join(req.pkg, "dist/collections.js")).href);
  // Pick the index and config as qmd's CLI does without --index, from the same cwd `qmd collection show` ran in: a project-local .qmd/ config brings its own index and outranks INDEX_PATH, else the global ones.
  // getDefaultDbPath() throws until enableProductionMode(), which qmd's CLI calls on startup.
  qmdStore.enableProductionMode();
  const local: string | undefined = findLocalConfigPath();
  const dbPath = local ? getLocalDbPath(local) : qmdStore.getDefaultDbPath();
  // Without configPath the library ignores `models.embed` in qmd's YAML, which `qmd embed` honours, so the two would disagree on the model.
  const store = await lib.createStore({ dbPath, configPath: local ?? (configExists() ? getConfigPath() : undefined) });
  try {
    if (req.op === "status") {
      // The public internal.getHashesNeedingEmbedding counts the whole index, never one collection.
      const { getHashesNeedingEmbedding } = qmdStore;
      const model = store.internal.llm.embedModelName;
      const distinct = store.internal.db.prepare("SELECT COUNT(DISTINCT hash) AS count FROM documents WHERE active = 1 AND collection = ?");
      return {
        collections: req.collections.map((name) => ({
          name,
          hashes: distinct.get(name).count,
          pending: getHashesNeedingEmbedding(store.internal.db, name, model),
        })),
      };
    }
    const results = [];
    for (const { collection, text } of req.queries) {
      const hits: { filepath: string; score: number }[] = await store.searchVector(text, { collection, limit: 10000 });
      results.push(hits.map(({ filepath, score }) => ({ filepath, score })));
    }
    return { results };
  } finally {
    await store.close();
  }
}

try {
  process.stdout.write(JSON.stringify(await handle(JSON.parse(readFileSync(0, "utf8")))));
} catch (e) {
  process.stderr.write(`${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`);
  process.exit(1);
}
