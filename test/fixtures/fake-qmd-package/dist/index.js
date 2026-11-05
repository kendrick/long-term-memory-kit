// Stand-in for qmd's library, driven by env vars the test sets. Mirrors only the calls the vector worker makes.
import { appendFileSync, readFileSync } from "node:fs";

const status = () => JSON.parse(process.env.FAKE_STATUS ?? "{}");

// Async like qmd 2.8.3's createStore; the embed model resolves config first, then QMD_EMBED_MODEL, as qmd's resolveEmbedModel does.
export async function createStore({ dbPath, configPath, config }) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `createStore ${dbPath} ${configPath ?? (config ? "inline" : "-")}\n`);
  const configured = config ? config.models?.embed : configPath && /^\s+embed:\s*(\S+)/m.exec(readFileSync(configPath, "utf8"))?.[1];
  const embedModelName = configured || process.env.QMD_EMBED_MODEL || "fake-embed-model";
  return {
    searchVector: async (q, { collection }) => (JSON.parse(process.env.FAKE_VEC ?? "{}")[collection] ?? {})[q] ?? [],
    internal: {
      // Counts rows as SQLite would: DISTINCT hash gives `hashes` (defaulting to `active` for a collection with no shared content), a plain count gives `active`.
      db: {
        prepare: (sql) => ({
          get: (name) => ({ count: (/COUNT\(DISTINCT hash\)/i.test(sql) ? status()[name]?.hashes : undefined) ?? status()[name]?.active ?? 0 }),
        }),
      },
      // Like LlamaCpp.embed, a model that won't load logs and returns null.
      llm: {
        embedModelName,
        embed: async () => {
          if (embedModelName !== process.env.FAKE_UNLOADABLE) return { embedding: [1] };
          console.error("Embedding error:", new Error(`No model file found at "${embedModelName}"`));
          return null;
        },
      },
    },
    close: async () => {},
  };
}
