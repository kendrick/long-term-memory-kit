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
  const { configExists, getConfigPath, findLocalConfigPath, getLocalDbPath, setConfigSource, loadConfig } = await import(pathToFileURL(join(req.pkg, "dist/collections.js")).href);
  const trust = await import(pathToFileURL(join(req.pkg, "dist/trust.js")).href);
  // Pick the index and config as qmd's CLI does without --index, from the same cwd `qmd collection show` ran in: a project-local .qmd/ config brings its own index and outranks INDEX_PATH, else the global ones.
  // getDefaultDbPath() throws until enableProductionMode(), which qmd's CLI calls on startup.
  qmdStore.enableProductionMode();
  const local: string | undefined = findLocalConfigPath();
  const dbPath = local ? getLocalDbPath(local) : qmdStore.getDefaultDbPath();
  // Without configPath the library ignores `models.embed` in qmd's YAML, which `qmd embed` honours, so the two would disagree on the model.
  const configPath: string | undefined = local ?? (configExists() ? getConfigPath() : undefined);
  let config: { collections?: Record<string, { path: string; update?: string }>; models?: Record<string, string | undefined> } | undefined;
  if (configPath) {
    setConfigSource({ configPath });
    config = loadConfig();
  }
  // Copies qmd 2.8.3's unexported localConfigIsFullyTrusted and collectSensitiveSnapshot (cli/qmd.js), so a cloned repo's .qmd/ can't choose a model file for this process to load (qmd #889).
  const fullyTrusted = (): boolean => {
    if (!configPath || !trust.isLocalConfigPath(configPath) || trust.isLocalConfigTrustOptedIn()) return true;
    const cols = Object.entries(config?.collections ?? {});
    const snapshot = {
      hooks: cols.filter(([, col]) => !!col.update).map(([name, col]) => ({ collection: name, command: col.update })),
      paths: cols.map(([name, col]) => ({ collection: name, path: col.path })),
      models: { embed: config?.models?.embed, rerank: config?.models?.rerank, generate: config?.models?.generate },
    };
    const builtins = { embed: qmdStore.DEFAULT_EMBED_MODEL, rerank: qmdStore.DEFAULT_RERANK_MODEL, generate: qmdStore.DEFAULT_QUERY_MODEL };
    if (!trust.hasGatedItems(trust.gatedItems(configPath, snapshot, builtins))) return true;
    return trust.isTrusted(configPath, trust.sensitiveDigest(snapshot, configPath, builtins));
  };
  // For an untrusted config qmd's CLI loads resolveModels() (env, then built-in), and the library does the same for a config without `models`.
  const store = await lib.createStore(
    configPath && !fullyTrusted() ? { dbPath, config: { ...config, models: undefined } } : { dbPath, configPath },
  );
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
    // searchVec returns [] when it can't embed the query, e.g. when the model won't load, and doctor would report that as no near-duplicates.
    // LlamaCpp.embed logs its error, code frame first, instead of throwing; capture the Error for a one-line message.
    const model = store.internal.llm.embedModelName;
    const logged: unknown[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => void logged.push(...args);
    let probe: unknown;
    try {
      probe = await store.internal.llm.embed("probe", { model, isQuery: true });
    } finally {
      console.error = consoleError;
    }
    if (!probe) {
      const cause = logged.find((a): a is Error => a instanceof Error);
      throw new Error(`qmd could not embed a query with model ${model}${cause ? `: ${cause.message}` : ""}`);
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
