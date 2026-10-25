# PolicyRule

A PolicyRule states a standard that applies across its Facets. It tells an agent what to do or avoid, in a form short enough to read at the header stage of the [Retrieval Model](../retrieval-model.md). It holds the instruction. The reasoning goes in a Decision.

## When to Pick a PolicyRule

Pick a PolicyRule when someone should be able to check work against the Record and say whether it complies. If the useful content is the reasoning for a choice, write a [Decision](decision.md) and link the PolicyRule to it. If a team needs a bounded departure from an existing PolicyRule, write an [Exception](exception.md) and leave the PolicyRule alone.

A PolicyRule has no end date. When the standard changes, supersede it with a new PolicyRule. When one service needs a temporary pass, grant an Exception.

## Worked Example

[Relational stores use PostgreSQL](../../fixtures/demo-bank/_memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md) (`nR5hB2yTq8`) applies to the commerce domain and the data platform. Its body is two sentences: the instruction, and a pointer to the Postgres everywhere Decision for the reasoning. [Billing-service's Exception](../../fixtures/demo-bank/_memory/exceptions/legacy-billing-mysql-until-2026-12-tZ6qL0vKd1.md) departs from it until the end of 2026.

Field definitions live in [`schema/record.schema.json`](../../schema/record.schema.json).

## Finding PolicyRules

An agent working in a Facet asks for the accepted PolicyRules that apply to it. This lists every accepted PolicyRule in the demo Bank:

```sh
grep -rl '^status: accepted$' _memory/policy-rules
```

## Common Mistakes

- Writing the rationale into the body. A long body pushes the instruction out of the first read. Put the reasoning in a Decision and link it with `related`.
- Making the `applies_to` list wider than the standard. A PolicyRule about commerce services that lists no Facets reaches every repo in the org. Leave `applies_to` empty only when the standard really is org-wide.
- Editing a PolicyRule to fit one team. A one-service departure is an Exception, which names its own end date and review date.
- Never confirming it. A PolicyRule nobody has reviewed for a year looks as current as one reviewed last week. Update `last_confirmed` when you check it.
- Phrasing it as a preference. "Prefer Postgres" gives an agent nothing to check. State what to do and where it applies.
