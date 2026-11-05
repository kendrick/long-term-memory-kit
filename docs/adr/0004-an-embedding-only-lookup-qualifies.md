# An Embedding-Only Lookup Qualifies

`recall.mode: vector` runs qmd's library `searchVector`, which calls only the embedding model and never runs qmd's query expansion, reranking, or text generation. An embedding is a ranked lookup, so it keeps [ADR 0001](0001-ltm-never-calls-a-model.md) under [ADR 0002](0002-a-ranked-lookup-is-not-a-model-call.md). `vsearch` and `query` stay refused, as [ADR 0003](0003-only-qmd-search-qualifies.md) says.

`ltm` imports the `@tobilu/qmd` package that the `qmd` command on `PATH` belongs to, and doesn't depend on it. Taking it as a dependency would add about 160 MB and native builds to every install, including Banks that never set `recall:`. An optional peer dependency would be a second qmd that can differ from the one that built the index. Importing the one on `PATH` means the lookup always runs the same qmd as `qmd embed`.

A `vector` score is cosine similarity and doesn't sit on `search`'s scale. In a 2026-11-04 spike on the demo Bank, a Record scored 0.49 to 0.81 against its own title and unrelated pairs scored 0.24 to 0.43. So `mode: vector` needs an explicit `doctor.near_duplicate_threshold` and has no default.
