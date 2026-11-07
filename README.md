# Long-Term Memory Kit

Org-level memory for coding agents, holding the decisions and policies that span your repos.

A Bank is a git repository of Records. Each Record is one Markdown file with flat frontmatter and a prose body, and it holds a Decision, a PolicyRule, an Exception to a PolicyRule, or Context. A Record belongs in a Bank when it applies to more than one repo, or when someone outside a repo's own team governs it. Agents find Records with plain grep, so a Bank works before anyone installs anything. The `ltm` CLI checks, formats, and queries a Bank, and the Claude Code plugin serves it to agents over MCP.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Promote a decision](#promote-a-decision)
- [Connect a Consumer Repo](#connect-a-consumer-repo)
- [Hydrate From Existing Docs](#hydrate-from-existing-docs)
- [How It Fits With working-memory-kit](#how-it-fits-with-working-memory-kit)
- [Guides and Reference](#guides-and-reference)
- [Contributing](#contributing)
- [License](#license)

## Install

`ltm` is one self-contained binary. Each GitHub Release publishes it for five platforms: `ltm-linux-x64`, `ltm-linux-arm64`, `ltm-darwin-x64`, `ltm-darwin-arm64`, and `ltm-windows-x64.exe`, along with a `SHA256SUMS` file.

### Fallback: Download a Release Binary

Download your platform's binary and `SHA256SUMS`, check the binary against it, and move it onto your `PATH`. On an Apple silicon Mac:

```sh
curl -fsSLO https://github.com/kendrick/long-term-memory-kit/releases/latest/download/ltm-darwin-arm64
curl -fsSLO https://github.com/kendrick/long-term-memory-kit/releases/latest/download/SHA256SUMS
grep ' ltm-darwin-arm64$' SHA256SUMS | shasum -a 256 -c
chmod +x ltm-darwin-arm64
mv ltm-darwin-arm64 /usr/local/bin/ltm
ltm --version
```

On Linux, use `ltm-linux-x64` or `ltm-linux-arm64` and check it with `sha256sum -c` in place of `shasum -a 256 -c`. On Windows, download `ltm-windows-x64.exe`, compare `Get-FileHash ltm-windows-x64.exe` with its line in `SHA256SUMS`, and put it in a folder on your `PATH` as `ltm.exe`.

### Claude Code Plugin

To give Claude Code the Bank, install the plugin from this repo's marketplace. When it asks for `bank_url`, enter your Bank's git URL. The plugin starts its MCP server by running `ltm mcp`, so `ltm` has to be on your `PATH` first.

```sh
claude plugin marketplace add kendrick/long-term-memory-kit
claude plugin install ltm@ltm-marketplace
```

## Quickstart

### Make a Bank

Create a Bank, then save this Record inside it as `_memory/context/orders-database.md`:

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

These commands create the Bank, put the Record in canonical form, check the Bank, and find the Record by its Facet:

```sh
ltm init acme-bank --name acme
cd acme-bank
# Save the Record above as _memory/context/orders-database.md, then:
ltm fmt
ltm validate
ltm query --facet domain:commerce
```

`ltm fmt` adds the `schema`, `id`, and `memory_type` fields, and `ltm validate` exits `0` with no output when every Record passes. The query prints the Record:

```text
_memory/context/orders-database.md  Context  accepted  Order data lives in one Postgres cluster
```

### Point an Agent at It

Push the Bank to a git host, install the plugin as shown under [Install](#install), and give it the Bank's URL as `bank_url`. Claude Code can then query the Bank through the plugin's MCP tools. [Getting Started](guide/getting-started.md) walks the same Bank from `ltm init` through pushing it and connecting a repo.

## Promote a decision

A decision that starts in one repo sometimes turns out to matter beyond it. Promotion moves it from that repo's working memory into a Bank as a Proposal. Run `ltm promote` from inside the repo, point `--bank` at a local checkout of the Bank, and give it a repo ADR or one entry from a decision log:

```sh
ltm promote docs/adr/0003-use-ioredis.md --bank ../acme-bank --dry-run
ltm promote docs/adr/0003-use-ioredis.md --bank ../acme-bank
ltm promote _working-memory/decisionLog.md --entry "Cap retries at three per request" --bank ../acme-bank
```

`--dry-run` prints the Proposal without writing anything. Without it, `ltm promote` pushes the Proposal to an `ltm/propose/<id>` branch on the Bank's origin and prints where to review it. It also adds a `promoted_to` line to the source file's frontmatter. Commit that line in your repo, so the next reader knows the decision now lives in the Bank. The Proposal binds agents only after Acceptance, when the Bank's merge review moves it to `accepted`. [Promotion](guide/promotion.md) covers each step.

## Connect a Consumer Repo

A Consumer repo is any repo whose agents should read a Bank. Name the Bank in your user config, list it in the repo's `.ltm.yaml`, and append the snippet `ltm connect` prints to the repo's `AGENTS.md`:

```sh
cat > .ltm.yaml <<'EOF'
banks: [acme]
EOF
ltm connect >> AGENTS.md
ltm query
```

With no filters, `ltm query` lists the Records in the Facets the Bank maps to this repo, plus every org-wide Record. [Getting Started](guide/getting-started.md#connect-a-consumer-repo) shows the user config, and [Retrieval](guide/retrieval.md) covers filtering by type, Facet, status, and text.

## Hydrate From Existing Docs

Most teams already have decisions written down in ADRs, PRDs, meeting transcripts, and pull requests. Hydration drafts Proposals from them, and a person reviews each one before it binds anyone. `ltm discover` lists the sources under a path and marks the ones a Record already cites:

```sh
ltm discover docs/adr notes/ --bank ../acme-bank
```

In Claude Code, run `/ltm:hydrate` and name the source folders and the Bank checkout. The skill reads each uncited source, drafts Proposals, and opens them for review. It also drafts from Word, PowerPoint, Excel, and PDF files in a SharePoint library you sync with the OneDrive client. [Hydration](guide/hydration.md) covers each step.

## How It Fits With working-memory-kit

[working-memory-kit](https://github.com/kendrick/working-memory-kit) holds what one repo knows about itself, and a Bank holds what spans repos. A Record crosses into a Bank when it applies to more than one repo or someone outside the repo's team governs it, and Promotion is how it crosses. [Design Forces](docs/design-forces.md#the-bright-line) explains why the line sits there.

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
- [Evaluation](guide/evaluation.md) describes the evals that check the kit before each release.

The reference pages explain why the kit works the way it does:

- [Design Forces](docs/design-forces.md) names the principles behind the kit.
- [Retrieval Model](docs/retrieval-model.md) describes the funnel agents use to read a Bank.
- [Supersession](docs/supersession.md) covers retiring one Record in favor of another.
- [ltm doctor](docs/doctor.md) explains each finding `ltm doctor` reports.
- The type pages cover [Decision](docs/types/decision.md), [PolicyRule](docs/types/policy-rule.md), [Exception](docs/types/exception.md), and [Context](docs/types/context.md).

`ltm --help` lists every command.

## Contributing

Issues are welcome. Pull requests are by arrangement for now, so open an issue before you start on one.

## License

MIT, copyright Kendrick Arnett. See [LICENSE](LICENSE).
