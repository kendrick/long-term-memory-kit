# Long-Term Memory Kit

A Bank is a git repository of Records that coding agents in any repo can consult before they act. Each Record is one Markdown file with flat frontmatter and a prose body, and it holds a Decision, a PolicyRule, an Exception to a PolicyRule, or Context. A Record belongs in a Bank when it applies to more than one repo, or when someone outside a repo's own team governs it. Agents find Records with plain grep, so a Bank works with nothing installed. The `ltm` CLI checks, formats, and queries a Bank. Its MCP server serves the Bank to agents, and the Claude Code plugin starts that server for you.

## Install

Download the `ltm` binary for your platform from the latest GitHub Release. Check it against `SHA256SUMS`, then move it onto your `PATH` as `ltm`. Release assets are `ltm-linux-x64`, `ltm-linux-arm64`, `ltm-darwin-x64`, `ltm-darwin-arm64`, and `ltm-windows-x64.exe`. On an Apple silicon Mac:

```bash
curl -fsSLO https://github.com/kendrick/long-term-memory-kit/releases/latest/download/ltm-darwin-arm64
curl -fsSLO https://github.com/kendrick/long-term-memory-kit/releases/latest/download/SHA256SUMS
grep ' ltm-darwin-arm64$' SHA256SUMS | shasum -a 256 -c
chmod +x ltm-darwin-arm64
mv ltm-darwin-arm64 /usr/local/bin/ltm
```

An npm wrapper ships with the same Releases. Its package name is set at first publish.

To give Claude Code the Bank through MCP, install the plugin from this repo's marketplace. When the plugin asks for `bank_url`, enter your Bank's git URL. The plugin starts its MCP server by running `ltm mcp`, so `ltm` must be on your `PATH`.

```bash
claude plugin marketplace add kendrick/long-term-memory-kit
claude plugin install ltm@ltm-marketplace
```

## Quickstart

Create a Bank, then save this Record as `_memory/context/orders-database.md` inside it:

```markdown
---
title: Order data lives in one Postgres cluster
summary: Every service that reads or writes orders uses the shared orders cluster.
status: accepted
applies_to: [domain:commerce]
owners: [team:platform]
date: 2026-10-26
---

The commerce services share one Postgres cluster for order data. The platform team runs it.
```

These five commands create the Bank, put the Record in canonical form, check the Bank, and find the Record by its Facet:

```sh
ltm init acme-bank --name acme
cd acme-bank
# Save the Record above as _memory/context/orders-database.md, then:
ltm fmt
ltm validate
ltm query --facet domain:commerce
```

`ltm fmt` adds the `schema`, `id`, and `memory_type` fields. `ltm validate` exits `0` when every Record passes. [Getting Started](guide/getting-started.md) takes the same Bank through pushing to GitHub and connecting a Consumer repo.

## Promote a decision

A decision that starts in one repo sometimes turns out to matter beyond it. Promotion moves it from that repo's working memory into a Bank as a Proposal. Run `ltm promote` from inside the repo and point `--bank` at a local checkout of the Bank. It takes a repo ADR, or one entry from a decision log:

```sh
ltm promote docs/adr/0003-use-ioredis.md --bank ../acme-bank --dry-run
ltm promote docs/adr/0003-use-ioredis.md --bank ../acme-bank
ltm promote _working-memory/decisionLog.md --entry "Cap retries at three per request" --bank ../acme-bank
```

`--dry-run` prints the Proposal without writing anything. Without it, `ltm promote` pushes the Proposal to an `ltm/propose/<id>` branch on the Bank's origin and prints where to review it. It also adds a `promoted_to` line to the source file's frontmatter. Commit that line in your repo. It tells the next reader that the decision now lives in the Bank. The Proposal binds agents only after Acceptance, when the Bank's merge review moves it to `accepted`. [Promotion](guide/promotion.md) covers each step.

## How It Fits With working-memory-kit

[working-memory-kit](https://github.com/kendrick/working-memory-kit) holds what one repo knows about itself. A Bank holds what spans repos. The bright line between them puts a Record in a Bank when it applies to more than one repo, or when someone outside a repo's team governs it. An Exception to a Bank PolicyRule for one service qualifies, because the PolicyRule's owners grant it. Everything else is working memory and stays in its repo. Promotion is how a decision crosses the line. [Design Forces](docs/design-forces.md#the-bright-line) explains why the line sits where it does.

## Guides and Reference

The guides cover running a Bank day to day:

- [Getting Started](guide/getting-started.md) installs `ltm`, creates a Bank, and connects a Consumer repo.
- [Retrieval](guide/retrieval.md) queries a Bank with grep, `ltm query`, and MCP.
- [Hydration](guide/hydration.md) drafts Proposals from existing ADRs and transcripts.
- [Reviewing](guide/reviewing.md) reviews and accepts Proposals, and supersedes Records.
- [Promotion](guide/promotion.md) moves a decision from a repo into a Bank.
- [Maintenance](guide/maintenance.md) runs `ltm doctor` and acts on what it finds.
- [M365 Copilot](guide/m365-copilot.md) renders a Digest of accepted Records and puts it where M365 Copilot can read it.
- [Formatters](guide/formatters.md) stops Prettier, oxfmt, and the Obsidian Linter from rewriting Record frontmatter.

The reference pages explain why the kit works the way it does:

- [Design Forces](docs/design-forces.md) names the principles behind the kit.
- [Retrieval Model](docs/retrieval-model.md) describes the funnel agents use to read a Bank.
- [Supersession](docs/supersession.md) covers retiring one Record in favor of another.
- [ltm doctor](docs/doctor.md) explains each finding `ltm doctor` reports.
- The type pages cover [Decision](docs/types/decision.md), [PolicyRule](docs/types/policy-rule.md), [Exception](docs/types/exception.md), and [Context](docs/types/context.md).

## License

MIT, copyright Kendrick Arnett. See [LICENSE](LICENSE).
