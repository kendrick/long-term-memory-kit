---
name: query-memory
description: Use before making or reviewing a choice that an org-level standard might govern, such as a datastore, a logging format, a deployment practice, or a service boundary, or when someone asks what the Bank says about a topic. Finds the Records that apply to this repo and cites them.
---
<!-- VENDORED-FROM: kendrick/long-term-memory-kit skills/query-memory -->
<!-- VERSION: 0.0.0 -->

# Query Memory

A Bank holds the decisions, standards, and exceptions that apply beyond one repo. Read as little of it as you can and still get the answer right. Use a four-stage funnel, where each stage reads fewer files than the one before:

1. Glob. Pick the folder for the memory type you need.
2. Grep the frontmatter of the files in that folder.
3. Read the header of each match.
4. Read the whole file for the few Records that are left.

## With `ltm` or the MCP Tools

If `ltm` is on your `PATH`, or the `ltm` MCP server is connected, let it run stages 1 and 2:

```text
ltm query --type PolicyRule --text "logging"
```

The MCP `query` tool takes the same filters. `ltm query` looks up this repo's Facets in the Bank, so leave out `--facet` unless you want a different scope. If the Bank doesn't list this repo, it returns Org-wide Records only and prints a note saying so. Pass `--facet service:order-service` to name the scope yourself.

Then read headers with `ltm head <path>`, or the MCP `head` tool. Read the whole file only for the Records that still look relevant.

## By Hand

Without `ltm`, run the same funnel with a shell. Run each command from the Bank root, where `_memory/` holds one folder for each memory type.

Glob for the folder. PolicyRules live in `_memory/policy-rules/`, Decisions in `_memory/decisions/`, Exceptions in `_memory/exceptions/`, and Context in `_memory/context/`.

Grep the frontmatter. Records for one Facet:

```sh
grep -rlE '^applies_to: .*service:order-service' _memory
```

Accepted PolicyRules, which are the standards to follow:

```sh
grep -rl '^status: accepted$' _memory/policy-rules
```

A Record with no `applies_to` line, or with `applies_to: []`, is Org-wide. It applies to this repo too, even though a Facet grep never lists it.

Proposals, which you can mention but never follow as rules:

```sh
grep -rl '^status: proposed$' _memory
```

The Exceptions that bend one PolicyRule, through `related`:

```sh
grep -rl 'constrained_by::cA9wE6uJr3' _memory/exceptions
```

Records to leave out of the answer:

```sh
grep -rlE '^status: (superseded|deprecated|rejected)$' _memory
```

Read the header of each match. The frontmatter ends within the first 20 lines, so `head -n 20 <path>` is enough. Read the whole file only for the Records that still look relevant.

## Rules for the Answer

- Skip Retired Records, meaning those with a `status` of `superseded`, `deprecated`, or `rejected`. Look at one only when the question is about history.
- A Proposal has `status: proposed`. Mention it as context, but never treat it as a constraint.
- An Exception can override a PolicyRule for its own Facets. Check for one before you tell someone that a rule applies to them.
- Cite the id of every Record your answer relies on, such as `nR5hB2yTq8`.
