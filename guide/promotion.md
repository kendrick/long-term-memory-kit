# Promotion

Promotion moves a decision from one repo's Working memory into a Bank. Promote a decision when it turns out to apply to more than one repo, or when someone outside the repo's team governs it. If neither is true, leave it where it is.

The decision stays in the repo. The Bank gets a Proposal that points back to the repo's copy, and the repo's copy gets a `promoted_to` stamp that points to the Bank.

The examples run from a copy of `fixtures/consumer-repo/`, the order service, with a Bank checkout at `../acme-bank`.

## Before You Start

You need three things:

- a local checkout of the Bank, on its default branch and up to date
- a git `origin` remote on the repo you're promoting from, since `ltm promote` names the repo by it
- a GitHub token in `GH_TOKEN` or `GITHUB_TOKEN`, if the Bank lives on GitHub and you want the PR opened for you

Without a token, `ltm promote` still pushes the Proposal's branch. It then prints the remote to open the PR on.

## Promote an ADR

Run `ltm promote` from the repo, with the ADR's path and the Bank checkout. Pass `--dry-run` first. It prints the Proposal and writes nothing:

```sh
ltm promote docs/adr/0004-retry-budget.md --bank ../acme-bank --dry-run
```

```text
---
schema: 1
id: v1UKpCnd-y
memory_type: Decision
title: Retry budget for outbound calls
status: proposed
date: 2026-10-27
promoted_from: acme/order-service:docs/adr/0004-retry-budget.md
applies_to: [service:order-service, domain:commerce]
---
```

The title comes from the ADR's frontmatter or its first `# ` heading, and the body is the ADR's body. `promoted_from` names the repo and the file. The Proposal is a Decision unless you pass `--type`.

`applies_to` comes from the Bank's `consumers` map for this repo. A decision that matters beyond one repo usually needs wider Facets than that. Pass `--applies-to` once for each Facet the decision covers. The flags replace the mapped Facets rather than adding to them:

```sh
ltm promote docs/adr/0004-retry-budget.md --bank ../acme-bank --applies-to domain:commerce --applies-to platform:kubernetes
```

That run opens the Proposal on a new `ltm/propose` branch of the Bank and prints its review link. Each run mints a fresh id, so it won't match the dry run's. It also adds a line like this to the ADR's frontmatter in your working tree:

```yaml
promoted_to: acme:Qm4rT8wLz2
```

`acme` is the `name` in the Bank's `memory-bank.yaml`. The id after it is the new Record's id, and it doesn't change at Acceptance.

## Promote a Decision-Log Entry

A working-memory-kit decision log holds many decisions, each under its own `## ` heading. Pick one with `--entry` and the heading text, exactly as written:

```sh
ltm promote _working-memory/decisionLog.md --entry "Cap retries at three per request" --bank ../acme-bank --dry-run
```

The heading becomes the title, and the text under it becomes the body. `promoted_from` adds an anchor for the entry, such as `acme/order-service:_working-memory/decisionLog.md#cap-retries-at-three-per-request`. Without `--dry-run`, the stamp goes on its own line just below the heading:

```markdown
## Cap retries at three per request
promoted_to: acme:Hs7kD2pVn5
```

The working-memory-kit template dates each heading, as in `## 2026-10-01: Cap retries at three per request`. When a heading opens with a calendar date and `: `, `--entry` also takes the text after the date. The title leaves the date out, and the anchor keeps it: `#2026-10-01-cap-retries-at-three-per-request`. A heading that matches exactly always wins, so an undated `## Cap retries` stays reachable beside a dated one with the same title.

`ltm promote` may print a `body-sections` warning, because a short entry has no Context or Consequences heading. The Proposal still opens. A reviewer can ask for those sections before accepting it.

## Commit the Stamp

`ltm promote` edits the source file but never commits it. Commit the stamp in the repo you promoted from:

```sh
git add docs/adr/0004-retry-budget.md
git commit -m "Promote the retry budget ADR to the acme Bank"
```

The stamp tells the next reader that the decision now lives in the Bank too. It also stops a second Promotion: `ltm promote` refuses a file or entry that already has a `promoted_to`.

If the Proposal opened but the stamp couldn't be written, `ltm promote` prints the exact line to add by hand. Add it, then commit it the same way.

## What Happens at Acceptance

The Proposal goes through the Bank's normal review, described in [Reviewing](reviewing.md). Nothing in the repo changes when it's accepted. The `promoted_to` stamp already names the Record's id, and the id stays the same.

From Acceptance on, the Bank owns the decision, so change it through a Bank PR. The repo's ADR or log entry stays as history, and its stamp points readers at the Record that now governs.

If reviewers reject the Proposal, the stamp still names an id. Remove the `promoted_to` line and commit that, so a later Promotion isn't refused.

## With the MCP Server

An agent with the `ltm` MCP server connected can promote without the CLI. It calls the `propose` tool with `from` set to the file's path, and with `entry` set for a decision-log entry. That does the same work as `ltm promote`, stamp included. The plugin's `promote` skill walks an agent through it.

## Related Pages

- [Reviewing](reviewing.md) covers what happens to the Proposal in the Bank.
- [Retrieval](retrieval.md) shows how a Consumer repo finds the Record once it's accepted.
- [Getting Started](getting-started.md) maps a Consumer repo to its Facets in `consumers`.
