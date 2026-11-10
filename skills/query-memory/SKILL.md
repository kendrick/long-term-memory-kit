---
name: query-memory
description: Use before making or reviewing a choice that a PolicyRule or Decision in the Bank might govern, such as a datastore, a logging format, a deployment practice, or a service boundary, or when someone asks what the Bank says about a topic. Finds the Records that apply to this repo and cites them.
---
<!-- VENDORED-FROM: kendrick/long-term-memory-kit skills/query-memory -->
<!-- VERSION: 0.1.0 -->

# Query Memory

A Bank holds the Decisions, PolicyRules, Exceptions, and Context that apply beyond one repo. Read as little of it as you can and still get the answer right. Use a four-stage funnel, where each stage reads fewer files than the one before:

1. Glob. Pick the folder for the memory type you need.
2. Grep the frontmatter of the files in that folder.
3. Read the header of each match.
4. Read the whole file for the few Records that are left.

## With `ltm` or the MCP Tools

If `ltm` is on your `PATH`, or the `ltm` MCP server is connected, let it run stages 1 and 2:

```text
ltm query --type PolicyRule --text "logging"
```

The MCP `query` tool takes the same filters. `ltm query` looks up this repo's Facets in the Bank, so leave out `--facet` unless you want other Facets. If the Bank doesn't list this repo, it returns Org-wide Records only and prints a note saying so. Pass `--facet service:order-service` to name the Facets yourself.

Then read the header of each match. In a Consumer repo, each result line starts with the name of the Bank it came from, as in `acme:_memory/policy-rules/structured-json-logging-vD8mH3zQb5.md`. The path after the colon is relative to that Bank's root. `ltm head` reads paths from the current directory, so run it from the Bank's root:

```text
cd <bank-root> && ltm head _memory/policy-rules/structured-json-logging-vD8mH3zQb5.md
```

To find the root, look up the Bank's name in the `banks` map of your `ltm` user config and take its `path`. The user config is the file `$LTM_CONFIG` names, or else `$XDG_CONFIG_HOME/ltm/config.yaml`, or else `~/.config/ltm/config.yaml`. On Windows it's `%APPDATA%\ltm\config.yaml`. If you gave `--bank` a directory, that directory is the root.

The MCP `head` tool takes the path as `path`. When the plugin's `bank_path` or `bank_url` is set, the server already knows the Bank and refuses a `bank` argument, so leave `bank` out. Pass the Bank's name as `bank` only when neither setting is set and the server picks Banks through your `ltm` user config.

When results come from more than one Bank, keep each path with its Bank's name and read its header from that Bank. Two Banks can hold Records at the same path.

Read the whole file only for the Records that still look relevant.

Over MCP, use the `read` tool for this. It returns a Record's whole file, frontmatter and body, and takes an `id` or a `path`, not both. It follows the same `bank` rule as `head`.

## By Hand

Without `ltm`, run the same funnel with a shell. Run each command from the Bank root, where `_memory/` holds one folder for each memory type.

Glob for the folder. PolicyRules live in `_memory/policy-rules/`, Decisions in `_memory/decisions/`, Exceptions in `_memory/exceptions/`, and Context in `_memory/context/`.

Grep the frontmatter. Records for one Facet:

```sh
grep -rlE '^applies_to: .*service:order-service' _memory
```

Accepted PolicyRules, which agents have to follow:

```sh
grep -rl '^status: accepted$' _memory/policy-rules
```

A Record with no `applies_to` line, or with `applies_to: []`, is Org-wide. It applies to this repo too, even though a Facet grep never lists it.

Proposals, which you can mention but never treat as constraints:

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

## Writing the Answer

- Skip Retired Records, meaning those with a `status` of `superseded`, `deprecated`, or `rejected`. Look at one only when the question is about history.
- A Proposal has `status: proposed`. Mention it as context, but never treat it as a constraint.
- An Exception grants a bounded departure from a PolicyRule within its own Facets. Check for one before you tell someone that a PolicyRule applies to them.
- Cite the id of every Record your answer relies on, such as `nR5hB2yTq8`.
