import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_EMBED_MODEL = "fake-embed-model";
export const DEFAULT_RERANK_MODEL = "fake-rerank-model";
export const DEFAULT_QUERY_MODEL = "fake-query-model";
// qmd's getDefaultDbPath throws until the CLI (or the worker) turns production mode on; the fake keeps that trap.
let production = false;
export const enableProductionMode = () => {
  production = true;
};
export function getDefaultDbPath() {
  if (process.env.INDEX_PATH) return process.env.INDEX_PATH;
  if (!production) throw new Error("Database path not set.");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "qmd", "index.sqlite");
}
// A model with no vectors leaves every hash pending, as qmd keys each vector on its model.
export function getHashesNeedingEmbedding(_db, collection, model) {
  const s = JSON.parse(process.env.FAKE_STATUS ?? "{}")[collection] ?? {};
  return model === (s.model ?? "fake-embed-model") ? (s.pending ?? 0) : (s.hashes ?? s.active ?? 0);
}
