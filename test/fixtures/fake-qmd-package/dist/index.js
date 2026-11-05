// Stand-in for qmd's library, driven by env vars the test sets. Mirrors only the calls the vector worker makes.
import { appendFileSync, readFileSync } from "node:fs";

const status = () => JSON.parse(process.env.FAKE_STATUS ?? "{}");

// Async like qmd 2.8.3's createStore; the embed model resolves config first, then QMD_EMBED_MODEL, as qmd's resolveEmbedModel does.
export async function createStore({ dbPath, configPath }) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `createStore ${dbPath} ${configPath ?? "-"}\n`);
  const configured = configPath && /^\s+embed:\s*(\S+)/m.exec(readFileSync(configPath, "utf8"))?.[1];
  return {
    searchVector: async (q, { collection }) => (JSON.parse(process.env.FAKE_VEC ?? "{}")[collection] ?? {})[q] ?? [],
    internal: {
      // Answers the worker's distinct-hash count; `hashes` defaults to `active` for a collection with no shared content.
      db: { prepare: () => ({ get: (name) => ({ count: status()[name]?.hashes ?? status()[name]?.active ?? 0 }) }) },
      llm: { embedModelName: configured || process.env.QMD_EMBED_MODEL || "fake-embed-model" },
    },
    close: async () => {},
  };
}
