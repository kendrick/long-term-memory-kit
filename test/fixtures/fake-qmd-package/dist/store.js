// A model with no vectors leaves every hash pending, as qmd keys each vector on its model.
export function getHashesNeedingEmbedding(_db, collection, model) {
  const s = JSON.parse(process.env.FAKE_STATUS ?? "{}")[collection] ?? {};
  return model === (s.model ?? "fake-embed-model") ? (s.pending ?? 0) : (s.hashes ?? s.active ?? 0);
}
