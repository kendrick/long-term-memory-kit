# Retrieval Model

An agent that needs a Bank's Records should read as little as it can and still be right. The retrieval model is a four-stage funnel that narrows the Bank to the few files worth reading. Each stage costs more per file than the one before, so each one runs on fewer files.

You can walk the funnel with plain shell tools. `ltm query` and the MCP `query` tool both run `selectRecords` to do stages 1 and 2 for you, and a Bank that sets `recall:` can rank `--text` through [Stage 0](#stage-0). None of it is required.

## The Four Stages

1. Glob. Pick the folder. A Record's memory type is its folder, so `_memory/policy-rules/` holds only PolicyRules. One path pattern drops three of the four types.
2. Frontmatter grep. Match lines in the headers of the files that remain.
3. Header read. Read only the frontmatter of each match. `ltm head <path>` prints it, or you can read the first 20 lines of the file.
4. Full read. Read the body of the few Records the header read kept.

Stage 2 needs frontmatter that grep can trust. Canonical form gives it that: every value is flat, every list sits on one line, and every key starts at the left edge. So `^status: accepted$` matches exactly the Records that are accepted, and no line is split across two. The header also closes within its first 20 lines, which caps stage 3 at 20 lines per Record however long the body runs. [`schema/record.schema.json`](../schema/record.schema.json) is the contract for which fields exist. This page doesn't repeat it.

## Stage 2 by Hand

Run these from a Bank root. Each prints the paths of the Records that match.

Records for one Facet. The `applies_to` list is on a single line, so a substring match finds the Facet:

```sh
grep -rlE '^applies_to: .*service:order-service' _memory
```

Records with no `applies_to` key, which are org-wide. The grep misses org-wide Records written as `applies_to: null` or `applies_to: []`, and it keeps retired ones:

```sh
grep -rc '^applies_to:' _memory | grep ':0$'
```

Accepted PolicyRules, which are the standards an agent has to follow:

```sh
grep -rl '^status: accepted$' _memory/policy-rules
```

Retired Records, meaning those with a `status` of `superseded`, `deprecated`, or `rejected`:

```sh
grep -rlE '^status: (superseded|deprecated|rejected)$' _memory
```

Proposals, which an agent may mention but never treats as a constraint:

```sh
grep -rl '^status: proposed$' _memory
```

Every Exception, whatever its status:

```sh
grep -rl '^memory_type: Exception$' _memory
```

The Exceptions tied to one PolicyRule, through the `constrained_by::<id>` entry in `related`:

```sh
grep -rl 'constrained_by::cA9wE6uJr3' _memory/exceptions
```

The one-line `summary` of each Context Record, which is often enough to skip the full read:

```sh
grep -rh '^summary:' _memory/context
```

A plain grep doesn't know that a retired Record is out of date, that a Proposal is only a suggestion, or which Facets your repo belongs to. Those rules live in `selectRecords` and `ltm query`.

## What `ltm query` Adds

That code sits in two layers.

`selectRecords` in `src/core/query.ts` holds the selection rules. `ltm query` and the MCP `query` tool both run it, so the two can't drift apart. It does this:

- It leaves retired Records out. Name a retired status with `--status`, or pass `--all`, to see them. `--status accepted` never lets a retired Record through.
- It filters Facets by overlap. A Record matches `--facet service:order-service` when its `applies_to` holds that Facet. Unless the Bank sets `query.org_wide: exclude`, an org-wide Record matches every Facet, because it applies everywhere. A Record with no `applies_to` is org-wide.
- It ranks `--text` on the header. It searches `title` and `summary`, not the body, so a passing mention in a body doesn't outrank a Record about the topic. Pass `--body` with `--text` to search the body too, for that query only. A Record that matches only in its body still ranks after every Record that matches in its header. A Bank that sets `recall:` ranks `--text` through qmd instead, as [Stage 0](#stage-0) describes.

`ltm query` adds three behaviors of its own around `selectRecords`.

- It labels Proposals. The text output marks them `(proposal)`, and the JSON output sets `is_proposal`. A reader can show one as context without presenting it as a rule.
- It reads Facets from the Bank. Outside a Bank, or with `--bank`, `ltm query` looks up the current repo's origin in the Bank's `consumers` map in `memory-bank.yaml` and uses the Facets listed there. An explicit `--facet` overrides the map.
- It narrows an unmapped repo to org-wide Records. When the map doesn't list the repo, or the repo has no git origin, `ltm query` shows org-wide Records only and adds a note. The text output prints the note on stderr. Under `--json` the note goes into the `notes` array.

## More Than One Bank

A repo can read from several Banks. `ltm query` resolves them, queries each on its own, and joins the results in resolution order. Each line starts with its Bank's name, and `--json` adds `resolved_by`, which says whether the flag, the repo's `.ltm.yaml`, a user rule, or the default picked them. Ranking under `--text` stays inside each Bank, so a strong match in the second Bank never jumps ahead of the first.

## Stage 0

Stage 0 ranks the Records the exact filters keep through the backend that `recall:` names in `memory-bank.yaml`. It runs only when two things hold: the Bank sets `recall:`, and the query passes `--text` with at least one word. A query without `--text`, or with `--text ""`, skips it, and so does a Bank without `recall:`. No flag or extra key turns it on. [ltm doctor](doctor.md) covers the `recall:` keys.

The filters run first. `--type`, `--facet`, `--status`, and the rest narrow the Bank, and the backend ranks only what is left. qmd still searches its whole collection, and `ltm query` ignores any hit for a Record the filters dropped.

qmd ranks the whole file, body included. Unless the query passes `--body`, the `lexical` matcher reads only `title` and `summary`, so a Record can rank under qmd on a word that appears only in its body. `--body` leaves qmd's results alone, since qmd already reads bodies. It widens `lexical` to the body for the rows `lexical` ranks under Stage 0: types with no entry in `recall.collections`, and every row when qmd can't run. Under `mode: search`, qmd returns a Record only when its text holds every word of the query.

`recall.collections` maps each memory type to one qmd collection, and Stage 0 searches the collection of each type that survives the filters. Without `--type`, that can mean up to four searches. The ranked rows from every collection merge by score, highest first, and break ties by path. A type with no entry in `recall.collections` ranks with `lexical`, and those rows follow the ranked ones. BM25 scores from different collections are not strictly comparable, because each collection scores against its own corpus, so a merged order across types is approximate.

`query.min_score` sets a floor. A Record that scores below it drops out, and a score equal to it stays. It sits in its own block beside `doctor:`:

```yaml
recall:
  backend: qmd
  mode: search
  collections:
    Decision: decisions
query:
  min_score: 0.3
```

Under `mode: search` the key is optional. Under `mode: vector` it is required, along with `doctor.near_duplicate_threshold`, because cosine similarity gives every document a score and only the floor makes `--text` narrow the list. `min_score` is a number from -1 to 1. When Stage 0 would run, `ltm query` exits 1 with a `memory-bank.yaml:` line if `recall:` or `query:` is malformed or a `vector` Bank leaves `min_score` out. Without `--text`, it reads only `query.org_wide`, and only on a Facet query.

`query.org_wide` decides whether an org-wide Record matches a Facet query. It takes `include`, the default, or `exclude`. Under `exclude`, a Record matches a Facet only when its own `applies_to` holds that Facet, so org-wide Records drop out of every `--facet` query. A query from a Consumer repo that the `consumers` map lists counts as a Facet query too, so that repo stops seeing org-wide Records. Org-wide Records still match `key=value` filters, `--type`, `--status`, `--text`, and any query with no Facet. An unmapped repo still gets org-wide Records only. `ltm query` reads the key on every Facet query and exits 1 with a `memory-bank.yaml:` line if the key holds any other value. With more than one Bank, each Bank's own setting applies to its own rows.

Each row gains two fields when Stage 0 runs. `score` is the number the matcher gave the Record. `ranked_by` is `qmd search`, `qmd vector`, or `lexical`, whichever produced that row's place in the order.

When the backend can't run, `ltm query` ranks with `lexical`, adds a note, and exits 0. That covers qmd missing from `PATH`, a missing collection, and a failed lookup. Every row then says `lexical` in `ranked_by`. [ADR 0006](adr/0006-stage-0-falls-back-to-lexical.md) explains why `ltm query` falls back where `ltm doctor` exits 1.

A Record can pass the filters and still be missing from its collection's index. `ltm query` adds a note such as `2 Records are not in qmd collection 'decisions'; run qmd update`, and under `vector` the note adds `qmd embed`. A file that changed after indexing still ranks on its old text, and the note doesn't catch that. Lines qmd itself prints on stderr appear as notes prefixed `qmd: `.

Inside a Bank, notes go to stderr, and `--json` prints a bare array. On the resolved path (outside a Bank, or with `--bank`), `--json` carries them in `notes`, prefixed `Bank "<name>": `, and text mode prints them on stderr. The MCP `query` tool returns the same notes, in `notes` on the resolved path and in `bank_notes` inside a Bank.

qmd searches its index, not the files, so run `qmd update` after you edit Records. The same Bank and the same index give the same output on every run, which is the promise [ADR 0002](adr/0002-a-ranked-lookup-is-not-a-model-call.md) makes for a ranked lookup. [ADR 0003](adr/0003-only-qmd-search-qualifies.md) and [ADR 0004](adr/0004-an-embedding-only-lookup-qualifies.md) say which qmd modes qualify. Precise questions don't need Stage 0, because the funnel is exact when the headers are canonical.

## Related Pages

- [Design Forces](design-forces.md) explains why the funnel needs no install and no model.
- [Supersession](supersession.md) explains how a Record becomes retired.
- [ltm doctor](doctor.md) reports Records that have gone stale.
- [ADR 0001](adr/0001-ltm-never-calls-a-model.md) is why `ltm` runs the funnel without judgment calls.
- [ADR 0002](adr/0002-a-ranked-lookup-is-not-a-model-call.md) is why a ranked lookup doesn't break that rule.
- [ADR 0003](adr/0003-only-qmd-search-qualifies.md) and [ADR 0004](adr/0004-an-embedding-only-lookup-qualifies.md) say which qmd modes qualify.
- [ADR 0006](adr/0006-stage-0-falls-back-to-lexical.md) is why Stage 0 ranks after the filters and falls back to `lexical`.
