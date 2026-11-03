# qmd search and vsearch Qualify, qmd query Does Not

`qmd search` is BM25 and runs no model. `qmd vsearch` embeds the query with a local embedding model that the Bank opted into through `recall:`. An embedding maps text to a fixed vector and generates nothing, so the same index and model give the same ranking. That is what [ADR 0002](0002-a-ranked-lookup-is-not-a-model-call.md) requires, so both modes keep the determinism ADR 0001 protects.

`qmd query` expands and reranks with generative LLMs, which is what [ADR 0001](0001-ltm-never-calls-a-model.md) rules out. `recall:` accepts only `search` and `vsearch`, and `ltm doctor` exits 1 on any other mode.
