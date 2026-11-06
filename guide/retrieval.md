# Retrieval

There are three ways to ask a Bank which Records apply to the work in front of you. A person in a Bank checkout can use plain grep. Anyone with `ltm` on `PATH` can run `ltm query`. An agent with the `ltm` MCP server connected can call its `query` tool. All three walk the same funnel, which [Retrieval Model](../docs/retrieval-model.md) explains, but they don't return the same answers.

The examples use the demo Bank in `fixtures/demo-bank/`, named `acme`. Its `memory-bank.yaml` maps the Consumer repo `acme/order-service` to the Facets `service:order-service` and `domain:commerce`.

## The Same Question Three Ways

The question here is which PolicyRules the order service has to follow.

### Plain Grep

Run grep from the Bank root. Name both of the repo's Facets, because a grep only knows what you type:

```sh
grep -rlE '^applies_to: .*(service:order-service|domain:commerce)' _memory/policy-rules
```

That prints four files. One of them, `shared-sftp-for-partner-files-yF4kP7tNs2.md`, is retired. Grep can't tell, so check the status of every match:

```sh
grep -rlE '^status: (superseded|deprecated|rejected)$' _memory
```

Then read each header that's left. The frontmatter ends within the first 20 lines, so `head -n 20 <path>` is enough, or use `ltm head`:

```sh
ltm head _memory/policy-rules/structured-json-logging-vD8mH3zQb5.md
```

### `ltm query`

Run `ltm query` from the Consumer repo. It reads the repo's Facets from the Bank's `consumers` map and drops retired Records for you:

```sh
ltm query --type PolicyRule
```

```text
acme:_memory/policy-rules/no-cross-service-db-reads-cA9wE6uJr3.md  PolicyRule  accepted  No cross-service DB reads
acme:_memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md  PolicyRule  accepted  Relational stores use PostgreSQL
acme:_memory/policy-rules/structured-json-logging-vD8mH3zQb5.md  PolicyRule  accepted  Structured JSON logging
```

Each line starts with the Bank's name, and the path after the colon is relative to that Bank's root. Add `--text` to rank results by their `title` and `summary`. A Bank that sets `recall:` ranks `--text` through qmd instead, as [Stage 0](../docs/retrieval-model.md#stage-0) explains. Add `--json` for the full frontmatter of each result:

```sh
ltm query --type PolicyRule --text logging --json
```

If the Consumer repo has no `.ltm.yaml` and your user config names no Bank for it, pass the Bank's path with `--bank`. [Getting Started](getting-started.md) sets up both files.

### The MCP `query` Tool

An agent calls the `query` tool with the same filters as JSON. It returns the same rows as `ltm query --json`:

```json
{ "type": "PolicyRule", "text": "logging" }
```

The tool takes `type` as one string, `facets` and `status` as lists, `text`, `all`, and `filters` for `key=value` pairs. To read a header, the agent calls the `head` tool with a Record's `id` or its Bank-relative `path`. When the plugin's `bank_url` or `bank_path` is set, the server already knows the Bank, so leave out the `bank` argument.

### What Each One Knows

| | Plain grep | `ltm query` | MCP `query` |
|---|---|---|---|
| Needs an install | No | `ltm` on `PATH` | The plugin, with `ltm` on `PATH` |
| Drops Retired Records | No, grep for `status` yourself | Yes, unless you pass `--all` or `--status` | Yes, unless you pass `all` or `status` |
| Marks Proposals | No, grep for `status: proposed` | `(proposal)` in text, `is_proposal` in JSON | `is_proposal` |
| Finds the repo's Facets | No, you type them | Yes, from the `consumers` map | Yes, from the `consumers` map |
| Includes Org-wide Records | No | Yes | Yes |

## Facets

A Facet is a prefix and a value, such as `service:order-service`. The Bank declares its prefixes in `memory-bank.yaml`, and any value can follow one:

```sh
grep '^facet_prefixes:' memory-bank.yaml
```

To see which Facets the Records actually use, with a count for each, run `ltm facets` from the Bank root. It counts live Records only. Pass `--all` to count Retired Records too:

```sh
ltm facets --all
```

To ask about Facets other than your repo's, pass `--facet`. Pass it once for each Facet. A Record matches when its `applies_to` holds any of them. An explicit `--facet` replaces the Facets from the `consumers` map:

```sh
ltm query --facet service:order-service --facet platform:kubernetes
```

## Org-wide Records

A Record with no `applies_to` line, or with `applies_to: []`, is Org-wide. It applies to every repo, so `ltm query` and the MCP tool include it in every Facet query.

A Facet grep never lists an Org-wide Record, because its `applies_to` line names no Facet. To find them by hand, run `grep -rL '^applies_to:' _memory` and `grep -rl '^applies_to: \[\]$' _memory` from the Bank root. The demo Bank has no Org-wide Records, so both print nothing there.

## When the Repo Isn't Mapped

If the Bank's `consumers` map doesn't list your repo, or the repo has no git origin, `ltm query` shows Org-wide Records only. It also adds a note. The text output prints the note on stderr:

```text
ltm query: kendrick/long-term-memory-kit is not mapped in Bank "acme"; showing org-wide Records only
```

Under `--json`, the note goes into the `notes` array instead. An empty result with that note means the Bank doesn't know which Facets your repo belongs to, so it may still hold Records that apply.

You can fix that in two ways. For a single query, pass `--facet` yourself. For a lasting fix, open a PR on the Bank that adds the repo to `consumers` in `memory-bank.yaml`. The key is the repo's `org/repo` as its origin URL names it:

```yaml
consumers:
  acme/order-service: [service:order-service, domain:commerce]
```

## Retired Records and Proposals

Queries leave Retired Records out. To see the history behind a choice, name a retired status with `--status`, or pass `--all` to include every status:

```sh
ltm query --status superseded
```

A Proposal has `status: proposed`. Queries include Proposals and label them, so an agent can mention one as context. Never treat a Proposal as a constraint. To list only Proposals by hand, run this from the Bank root:

```sh
grep -rl '^status: proposed$' _memory
```

## Related Pages

- [Retrieval Model](../docs/retrieval-model.md#what-ltm-query-adds) lists the rules `ltm query` adds over plain grep.
- [Supersession](../docs/supersession.md) explains how a Record becomes retired.
- [Getting Started](getting-started.md) connects a Consumer repo and installs the plugin.
