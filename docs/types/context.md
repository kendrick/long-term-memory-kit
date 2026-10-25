# Context

A Context records what an agent needs to know to reason correctly when nothing was chosen and nothing is required. It describes how the org, a domain, or a system is arranged today.

## When to Pick a Context

Pick a Context for orientation: what a service owns, what a domain's terms mean, what the platform looks like. If a person chose between options, write a [Decision](decision.md). If the Record should tell an agent what to do, write a [PolicyRule](policy-rule.md). A Context has no instruction in it, so an agent that reads one still has to decide what to do.

## Worked Example

[order-service overview](../../fixtures/demo-bank/_memory/context/order-service-overview-gN5yD9sMe2.md) (`gN5yD9sMe2`) says what order-service owns and who consumes its events. It applies to the order service and to the commerce domain. [Commerce domain glossary](../../fixtures/demo-bank/_memory/context/commerce-domain-glossary-xO4bV1cPi0.md) (`xO4bV1cPi0`) fixes the meaning of cart, order, and fulfillment.

Field definitions live in [`schema/record.schema.json`](../../schema/record.schema.json). The [Retrieval Model](../retrieval-model.md) explains how an agent reaches these by Facet.

## Finding Contexts

This lists the Facets each Context applies to:

```sh
grep -rh '^applies_to:' _memory/context
```

## Common Mistakes

- Hiding a requirement in a Context. If the body says "services must", it is a PolicyRule, and an agent that skims Contexts for orientation will miss it.
- Recording a choice without its reasoning. "We use Kafka" with no why is a thin Decision. Write the Decision.
- Letting it go stale. A Context describes a system as it is, so it ages with the system. Update `last_confirmed` when you check it, and supersede it when the system changes shape.
- Copying content that already has a home. A Context that duplicates a README drifts from it. Summarize and link.
- Leaving `applies_to` empty by habit. An org-wide Context reaches every query, so use it only for what every repo needs to know.
