// Runs as a child of `ltm`, never in-process: qmd's library reads process.env (index, model dirs) directly,
// and ltm runs on the caller's env. One request on stdin, one JSON response on stdout (see qmd-vector.ts).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Query = { collection: string; text: string };
type Request =
  | { op: "status"; pkg: string; collections: string[] }
  | { op: "search"; pkg: string; queries: Query[] };

async function run(req: Request): Promise<unknown> {
  const manifest = JSON.parse(readFileSync(join(req.pkg, "package.json"), "utf8"));
  const lib = await import(pathToFileURL(join(req.pkg, manifest.exports["."].import)).href);
  // The library's own getDefaultDbPath() throws outside qmd's CLI, so compute the path the way qmd does.
  const dbPath = process.env.INDEX_PATH || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "qmd", "index.sqlite");
  const store = lib.createStore({ dbPath });
  try {
    if (req.op === "status") {
      // The public internal.getHashesNeedingEmbedding counts the whole index, never one collection.
      const { getHashesNeedingEmbedding } = await import(pathToFileURL(join(req.pkg, "dist/store.js")).href);
      const model = store.internal.llm.embedModelName;
      const listed: { name: string; active_count: number }[] = await store.listCollections();
      return {
        collections: req.collections.map((name) => ({
          name,
          active: listed.find((c) => c.name === name)?.active_count ?? 0,
          pending: listed.some((c) => c.name === name) ? getHashesNeedingEmbedding(store.internal.db, name, model) : 0,
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
  process.stdout.write(JSON.stringify(await run(JSON.parse(readFileSync(0, "utf8")))));
} catch (e) {
  process.stderr.write(`${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`);
  process.exit(1);
}
