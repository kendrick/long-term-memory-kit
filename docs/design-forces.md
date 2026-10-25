# Design Forces

Seven principles shaped the Long-Term Memory Kit. Each one ruled something out. This page names the decision each principle forced, so a later change can tell whether it breaks a principle on purpose or by accident. The full list is in the "Principles" section of [the design plan](plans/2026-10-08-long-term-memory-kit-design.md).

## A Bank Is Useful With Zero Installs

A Bank is plain markdown. An agent in any language, on any platform, can read it with the shell tools it already has. That forced canonical form: flat values, one-line lists, and a header that closes early, so plain grep stays accurate. A layout that needed a parser would have made the CLI mandatory. See [Retrieval Model](retrieval-model.md) for what grep can then do.

## Tooling Speeds Things Up and Is Never Required

Every rung above plain files is optional: JSON Schema, then the `ltm` CLI, then the MCP server, then the plugin. The decision it forced is that each `ltm` operation has a manual equivalent that a person can do with an editor. The same goes for [Supersession](supersession.md), which is two hand edits that `ltm supersede` makes safe.

## Host Neutral

Git is the only assumption. Anything that depends on a forge, such as a GitHub Action or an issue form, is an adapter around a core that doesn't know which forge it runs on. Acceptance is a reviewed edit in a merged change, and the forge's own rules decide who may merge.

## ADRs Come In as They Are

A Nygard or MADR ADR with ordinary frontmatter is already a valid Decision, or one deterministic `ltm fmt` away from one. The decision it forced is to adopt the ADRs people already wrote, so no team has to rewrite its history to join a Bank. Bodies are convention, not contract. `ltm validate` warns about a Decision without recognizable sections and never fails it.

## `ltm` Never Calls a Model

Judgment comes from the agent that is already running, and `ltm` does every mechanical step the same way every time. That ruled out an `ltm hydrate` command that calls a provider. It would need API keys and a provider choice, and its output would change between runs. [ADR 0001](adr/0001-ltm-never-calls-a-model.md) records the choice. The same force keeps Supersession explicit, because deciding that two Records cover one subject is a judgment.

## The Bright Line

A Record belongs in a Bank when it applies to more than one repo, or when someone outside a repo's team governs it. An Exception to a Bank PolicyRule for one service qualifies, because the PolicyRule's owners grant it. Everything else is working memory and stays in its repo. `ltm promote` moves a Decision that turns out to matter beyond its first repo into a Bank as a Proposal. The line keeps a Bank small enough that its Records stay true.

## Lean Over Comprehensive

Adoption matters more than completeness. The required fields are few, and a field earns a place by observed need. That is why `subject` is reserved and not built, and why [ltm doctor](doctor.md) reports instead of editing. The record contract lives in [`schema/record.schema.json`](../schema/record.schema.json), not in prose, so there is one place to add a field when the need appears.

## Related Pages

- [Retrieval Model](retrieval-model.md) shows the funnel that the first two principles allow.
- [Supersession](supersession.md) shows the fifth principle applied to retiring Records.
