# Decision

A Decision records a choice and the reasoning behind it. It answers "why do we do it this way?" for the engineer who shows up after the people who chose have moved on. A Nygard-style ADR with frontmatter is already a Decision, and so is a MADR file.

## When to Pick a Decision

Pick a Decision when the value is the reasoning: the options considered, the forces that decided it, and the consequences you accepted. If the Record should tell an agent what it must do, write a [PolicyRule](policy-rule.md) and let the Decision hold the why. If you are describing how a system works today and nothing was chosen, write a [Context](context.md).

A Decision and a PolicyRule often travel as a pair. The Postgres everywhere Decision gives the reasoning, and the relational stores PolicyRule gives the instruction that follows from it.

## Worked Example

[Postgres everywhere](../../fixtures/demo-bank/_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md) (`kQ7vN2xLp4`) is an accepted Decision. Its body follows the Context, Decision, and Consequences sections. It lists the MySQL Decision in `supersedes`, and [MySQL for new services](../../fixtures/demo-bank/_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md) (`mB3tR9wZe1`) carries `superseded_by` pointing back. [Supersession](../supersession.md) explains why both sides are written.

The fields every Record carries are defined in [`schema/record.schema.json`](../../schema/record.schema.json). This page doesn't repeat them.

## Finding Decisions

Retired Decisions stay in the Bank as history. This lists the ones that were superseded:

```sh
grep -rl '^status: superseded$' _memory/decisions
```

The [Retrieval Model](../retrieval-model.md) shows how queries leave them out by default.

## Common Mistakes

- Writing a Decision when you meant a PolicyRule. If the body says "all services must", an agent needs a PolicyRule it can follow, and the Decision should link to it.
- Editing an accepted Decision when the choice changes. Write a new Decision and supersede the old one with `ltm supersede`, so the history of the choice survives.
- Leaving out the consequences. A Decision that gives only the outcome can't be weighed against a later change. `ltm validate` warns, and doesn't fail, when a Decision lacks recognizable sections.
- Recording a repo-local choice. A choice that only one repo's team governs belongs in that repo's working memory. A Bank holds Records that apply to more than one repo.
- Filing a time-limited departure from a PolicyRule as a Decision. That is an [Exception](exception.md), and it needs an end date.
