# Exception

An Exception grants a bounded departure from a PolicyRule. It lets a team break a standard on purpose, for a stated period and a stated place, without weakening the PolicyRule for everyone else.

## When to Pick an Exception

Pick an Exception when a [PolicyRule](policy-rule.md) still holds for the org but one service or team can't meet it yet. If the standard itself has changed, supersede the PolicyRule instead. If you are explaining a choice, write a [Decision](decision.md). An Exception has an end, so a departure with no foreseeable end is a sign the PolicyRule needs to change.

## Worked Example

[order-service may use Redis until 2027-03](../../fixtures/demo-bank/_memory/exceptions/order-service-redis-until-2027-03-wJ3nC7hTy4.md) (`wJ3nC7hTy4`) lets one service read stock levels straight from inventory's Redis. It names the PolicyRule it departs from in `related`, as `constrained_by::cA9wE6uJr3`, and it sets `effective_to` and `review_by` dates. Every other service still follows [no cross-service DB reads](../../fixtures/demo-bank/_memory/policy-rules/no-cross-service-db-reads-cA9wE6uJr3.md).

The `related` and `effective_to` fields are defined in [`schema/record.schema.json`](../../schema/record.schema.json).

## Finding Exceptions

To list the Exceptions tied to one PolicyRule, grep for its id in `related`:

```sh
grep -rl 'constrained_by::cA9wE6uJr3' _memory/exceptions
```

To see when each one ends:

```sh
grep -rh '^effective_to:' _memory/exceptions
```

`effective_to` records the intended end for readers and agents, and nothing enforces it: no query drops an Exception after that date, and [ltm doctor](../doctor.md) never reads the field. The doctor's `review-due` check reads `review_by` on every live Record, Exceptions included, and reports each one whose date has passed.

## Common Mistakes

- Leaving out `effective_to` and `review_by`. Without an end date, readers and agents can't tell when the departure should stop. Without a review date, `ltm doctor` has nothing to report when someone should recheck it.
- Leaving out the `related` link to its PolicyRule. The Exception then reads as a free-standing note. A query for the PolicyRule can't find it, and an agent could follow the PolicyRule and miss the pass.
- Linking the wrong PolicyRule. Check that the id in `constrained_by::` is the PolicyRule the Exception departs from. A mistyped id passes a glance and fails a lookup.
- Writing one Exception for several services. Each Exception applies to its own `applies_to` Facets, so give each service its own end date and review date.
- Treating a proposed Exception as granted. [search-service plaintext logs](../../fixtures/demo-bank/_memory/exceptions/search-service-plaintext-logs-bU2pR8aXf7.md) (`bU2pR8aXf7`) is still `proposed`. Agents surface it and never treat it as a constraint until someone accepts it.
