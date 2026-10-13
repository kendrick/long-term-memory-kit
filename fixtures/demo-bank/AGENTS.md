<!-- ltm:generated:begin v0.0.0 -->

This repo is the acme Bank. It holds Records that apply to more than one repo. Each Record is one Markdown file with YAML frontmatter, filed in its memory type's folder: Decision (`_memory/decisions`), PolicyRule (`_memory/policy-rules`), Exception (`_memory/exceptions`), and Context (`_memory/context`).

## Find the Records That Apply

Run these commands from the Bank root, in this order. List the folders, then grep the frontmatter to narrow the list. Next, read the header of each Record that's left with `ltm head` or `head -n 20`. Read the full file only after its header shows that the Record applies.

```sh
ls _memory/decisions
ls _memory/policy-rules
ls _memory/exceptions
ls _memory/context
grep -rl '^memory_type: PolicyRule$' _memory/policy-rules
grep -rl 'applies_to:.*service:order-service' _memory/decisions _memory/policy-rules _memory/exceptions _memory/context
ltm head _memory/policy-rules/*.md
head -n 20 _memory/policy-rules/*.md
cat _memory/policy-rules/*.md
```

## Check Status Before You Act

A Record with `status: proposed` is a Proposal. Read it as context, never as a constraint. Skip any Record whose status is `superseded`, `deprecated`, or `rejected`.

## Facet Prefixes

`applies_to` and `owners` hold Facets written as `<prefix>:<value>`. This Bank declares these prefixes: `service`, `domain`, `system`, `team`, `platform`.

## Frontmatter Fields

| Field            | Required | Description                                                                                                     |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `schema`         | yes      | Set to 1, the Record schema version.                                                                            |
| `id`             | yes      | Give the Record a unique 10-character nanoid from [A-Za-z0-9_-] and never change it.                            |
| `memory_type`    | yes      | Pick exactly one memory type: Decision, PolicyRule, Exception, or Context.                                      |
| `title`          | yes      | Name the Record in a short, non-empty line.                                                                     |
| `status`         | yes      | Set the lifecycle state. A proposed Record is a Proposal: agents surface it but never treat it as a constraint. |
| `date`           | yes      | Record the date the Record was written or last accepted, as YYYY-MM-DD.                                         |
| `effective_from` |          | Set the YYYY-MM-DD date the Record starts to apply, if it applies later than its date.                          |
| `effective_to`   |          | Set the YYYY-MM-DD date the Record stops applying, such as the end of an Exception.                             |
| `last_confirmed` |          | Set the YYYY-MM-DD date someone last confirmed the Record still holds. Only move it forward.                    |
| `review_by`      |          | Set the YYYY-MM-DD date by which someone must review the Record again.                                          |
| `summary`        |          | State the claim and its scope in one sentence.                                                                  |
| `superseded_by`  |          | Name the one id of the Record that superseded this one. It holds a single id, while supersedes is a list.       |
| `supersedes`     |          | List the ids of the Records this one supersedes. Fill superseded_by on each of them too.                        |
| `promoted_from`  |          | Name where this Record came from when promoted out of a repo's working memory.                                  |
| `promoted_to`    |          | Name the Bank Record this item was promoted to, as <bank>:<id>.                                                 |
| `subject`        |          | Reserved. Accepted here, and v1 ignores it.                                                                     |
| `applies_to`     |          | List the Facets where the Record applies, each as <prefix>:<value> using a prefix the Bank declares.            |
| `owners`         |          | List the Facets that own the Record, each as <prefix>:<value>, such as team:commerce-architecture.              |
| `tags`           |          | List free-form keywords for search. Use applies_to, not tags, to say where the Record applies.                  |
| `source_refs`    |          | List the sources the Record was drawn from, such as URLs, file paths, or PR references.                         |
| `related`        |          | List links to other Records, each as <relation>::<id>, such as constrained_by::<PolicyRule id> on an Exception. |

## Propose a Record

To add a Record or change one, submit a Proposal in any of these ways:

- Run `ltm propose`.
- Call the `propose` tool on the ltm MCP server.
- Open a PR by hand that adds the Record with `status: proposed`.

<!-- ltm:generated:end -->
