# Supersession

A Supersession retires one Record in favor of a newer one. It is always explicit. A person or an agent says which Record replaces which, and nothing in the kit guesses that two Records are about the same subject. That judgment stays with a human.

## The Two-Record Edit

A Supersession is written on both Records. The old Record gets `status: superseded` and a `superseded_by` field holding the new Record's id. The new Record gets the old id added to its `supersedes` list. Both sides matter, because a reader may arrive at either file first. The fields themselves are defined in [`schema/record.schema.json`](../schema/record.schema.json).

`ltm supersede <old-id> <new-id>` makes that edit. It plans both files first and writes them together, and if one write fails it restores the other, so a Supersession is never left half done. It refuses, and changes nothing, when:

- the two ids are the same, or either matches no Record or more than one
- the old Record already names a different successor
- the new Record isn't `accepted`, or is itself superseded
- the link would close a cycle
- the two Records share no Facet, as the next section explains

`ltm accept <id>` covers the other common case. A Proposal can list the Records it will retire in `supersedes`. Accepting it stamps its `status`, `date`, and `last_confirmed`, then makes each of those Supersessions in the same all-or-nothing write. If any one of them would be refused, the Proposal stays a Proposal.

You can also edit the two files by hand. `ltm validate` checks that the edit is complete.

Two greps show the pair in the demo Bank. First, the Record that supersedes the MySQL Decision:

```sh
grep -rl '^supersedes: .*mB3tR9wZe1' _memory
```

Then the successor named on the retired Record, and the file that holds that id:

```sh
grep -rh '^superseded_by:' _memory/decisions/mysql-for-new-services-mB3tR9wZe1.md
grep -rl '^id: kQ7vN2xLp4$' _memory
```

## The Shared-Facet Rule

Two Records can only supersede each other when their `applies_to` lists share at least one Facet. Without that, a Record about the order service could retire a Record about search, and a mistaken id would pass.

An org-wide Record, which has no `applies_to` or an empty one, applies everywhere. It overlaps with every Record, so it passes the check against any partner. [ltm doctor](doctor.md) flags the pairs where that overlap is empty in practice.

## What `ltm doctor` Reports

`ltm validate` rejects two non-empty lists that are disjoint. It can't judge a pair where one side is org-wide. Two doctor checks pick up what validate lets through.

- `long-chain` fires when a chain of Supersessions holds more Records than `doctor.max_chain_length`, which defaults to 3. A Decision that keeps changing is worth a look.
- `supersession-no-shared-facet` fires when one side is org-wide and the two Records still name no Facet in common. A broad Record replacing a narrow one, or the reverse, might be deliberate, and the finding lets a person confirm that.

Both checks only report. [ltm doctor](doctor.md) lists every check, with thresholds and how to clear each finding.

## The Reserved `subject` Key

The schema accepts a `subject` field, and v1 ignores it. A later option may let a Bank turn on an explicit subject slug so that Records about the same thing can be found without relying on a person's memory. Doctor's `supersession-no-shared-facet` findings are how that need would show up in real data. Until then, don't write a `subject` and don't expect it to do anything.

## Related Pages

- [Retrieval Model](retrieval-model.md) explains why queries leave retired Records out.
- [Design Forces](design-forces.md) explains why Supersession is explicit.
- [ADR 0001](adr/0001-ltm-never-calls-a-model.md) explains why `ltm` doesn't guess which Record is the successor.
