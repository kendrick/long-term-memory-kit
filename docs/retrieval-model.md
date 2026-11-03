# Retrieval Model

An agent that needs a Bank's Records should read as little as it can and still be right. The retrieval model is a four-stage funnel that narrows the Bank to the few files worth reading. Each stage costs more per file than the one before, so each one runs on fewer files.

You can walk the funnel with plain shell tools. `ltm query` and the MCP `query` tool both run `selectRecords` to do stages 1 and 2 for you. Neither is required.

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
- It filters Facets by overlap. A Record matches `--facet service:order-service` when its `applies_to` holds that Facet. An org-wide Record matches every Facet, because it applies everywhere. A Record with no `applies_to` is org-wide.
- It ranks `--text` on the header. It searches `title` and `summary`, not the body, so a passing mention in a body doesn't outrank a Record about the topic.

`ltm query` adds three behaviors of its own around `selectRecords`.

- It labels Proposals. The text output marks them `(proposal)`, and the JSON output sets `is_proposal`. A reader can show one as context without presenting it as a rule.
- It reads Facets from the Bank. Outside a Bank, or with `--bank`, `ltm query` looks up the current repo's origin in the Bank's `consumers` map in `memory-bank.yaml` and uses the Facets listed there. An explicit `--facet` overrides the map.
- It narrows an unmapped repo to org-wide Records. When the map doesn't list the repo, or the repo has no git origin, `ltm query` shows org-wide Records only and adds a note. The text output prints the note on stderr. Under `--json` the note goes into the `notes` array.

## More Than One Bank

A repo can read from several Banks. `ltm query` resolves them, queries each on its own, and joins the results in resolution order. Each line starts with its Bank's name, and `--json` adds `resolved_by`, which says whether the flag, the repo's `.ltm.yaml`, a user rule, or the default picked them. Ranking under `--text` stays inside each Bank, so a strong match in the second Bank never jumps ahead of the first.

## Stage 0 Is Reserved

Semantic recall would run before stage 1, as a ranked search over meaning. It's planned for v1.1. A ranked backend can plug in through the `RecallBackend` interface in `src/core/recall.ts`. Today only a plain lexical match is wired in, and the `recall:` key in `memory-bank.yaml` changes nothing. `ltm doctor`'s `near-duplicate` check waits on the same backend. Precise questions don't need it, because the funnel is exact when the headers are canonical.

## Related Pages

- [Design Forces](design-forces.md) explains why the funnel needs no install and no model.
- [Supersession](supersession.md) explains how a Record becomes retired.
- [ltm doctor](doctor.md) reports Records that have gone stale.
- [ADR 0001](adr/0001-ltm-never-calls-a-model.md) is why `ltm` runs the funnel without judgment calls.
- [ADR 0002](adr/0002-a-ranked-lookup-is-not-a-model-call.md) is why a ranked lookup doesn't break that rule.
