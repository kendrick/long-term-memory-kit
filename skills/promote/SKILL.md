---
name: promote
description: Use when a decision recorded in this repo's Working memory, such as an ADR or a decision-log entry, turns out to apply to other repos or to be governed by someone outside this repo's team. Promotes it to a Bank Proposal and records the Promotion in the repo.
---
<!-- VENDORED-FROM: kendrick/long-term-memory-kit skills/promote -->
<!-- VERSION: 0.1.0 -->

# Promote

Promotion moves a decision from this repo's Working memory into a Bank. The decision stays in the repo as well. The Bank gets a Proposal that points back to it, and the repo's copy gets a stamp that points to the Bank.

## The Bright Line

A decision belongs in a Bank when either of these is true:

- It applies to more than one repo.
- Someone outside this repo's team governs it, such as an Exception to a Bank PolicyRule for one service.

If neither is true, leave the decision where it is.

## Promote with `ltm`

Run this from the repo that holds the decision:

```text
ltm promote docs/adr/0007-use-grpc.md --bank ../acme-bank
```

`--bank` is the path to a local checkout of the Bank. For a decision log that holds many entries, pick one with `--entry "<heading>"`. The Proposal is a Decision unless you pass `--type`. Add `--applies-to` for each Facet the decision covers. Pass `--dry-run` first to see the Proposal without writing anything.

`ltm promote` opens the Proposal on a new branch of the Bank, with `promoted_from` naming this repo and file. It also adds a `promoted_to` stamp to the source file in this repo's working tree.

With the `ltm` MCP server connected, call its `propose` tool with `from` set to the file's path, and `entry` set for a decision-log entry. It does the same work as `ltm promote`.

## Commit the Stamp

`ltm promote` edits the source file but doesn't commit it. Commit the `promoted_to` line in this repo, so the next reader can see that the decision now lives in the Bank too. A rerun of `ltm promote` on the same file reads the stamp and refuses to promote it twice.

## Without `ltm`

1. Create a branch in the Bank.
2. Write a Record with `status: proposed` under the folder for its memory type, such as `_memory/decisions/`. Set `promoted_from` to `<org>/<repo>:<path>`, naming this repo and the file.
3. Open a pull request in the Bank.
4. Add `promoted_to: <bank>:<id>` to the source file's frontmatter, where `<bank>` is the `name` in the Bank's `memory-bank.yaml`. Commit it in this repo.
