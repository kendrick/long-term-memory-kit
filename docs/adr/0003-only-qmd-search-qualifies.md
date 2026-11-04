# Only qmd search Qualifies

`qmd search` is BM25 and runs no model, so it keeps the rule in [ADR 0001](0001-ltm-never-calls-a-model.md).

In qmd 2.8.3, `qmd vsearch` calls `store.expandQuery` before its vector lookup, and that generates query variants with a language model. `qmd query` expands and reranks with one too. So `recall:` accepts only `search`. An embedding-only lookup would still qualify under [ADR 0002](0002-a-ranked-lookup-is-not-a-model-call.md), because an embedding generates nothing. #136 tracks one through qmd's library API.
