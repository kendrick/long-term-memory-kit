# Getting Started

Run every command on this page in order, starting from one empty directory. You end with a Bank in `acme-bank/` that holds one Record, and a Consumer repo in `order-service/` whose agents can query it. Later steps refer to both directories by those paths.

## Install ltm

Each GitHub Release ships a standalone `ltm` binary per platform, named `ltm-linux-x64`, `ltm-linux-arm64`, `ltm-darwin-x64`, `ltm-darwin-arm64`, and `ltm-windows-x64.exe`, along with a `SHA256SUMS` file. Download yours and the checksums, check the binary, and put it on your `PATH`. On an Apple silicon Mac:

```bash
base=https://github.com/kendrick/long-term-memory-kit/releases/latest/download
curl -fsSL -O "$base/ltm-darwin-arm64" -O "$base/SHA256SUMS"
shasum -a 256 -c --ignore-missing SHA256SUMS
chmod +x ltm-darwin-arm64
mv ltm-darwin-arm64 /usr/local/bin/ltm
```

On Linux, `sha256sum -c --ignore-missing SHA256SUMS` does the same check. An npm wrapper is coming too, but its package name isn't set until the first npm publish.

Check that your shell finds it:

```sh
ltm --version
```

## Create a Bank

`ltm init` scaffolds a Bank: `memory-bank.yaml`, a `_memory/` folder for each memory type, agent instructions in `AGENTS.md` and `CLAUDE.md`, and the GitHub workflows that check and accept changes. Each `--facet-prefix` names a prefix your Records can scope themselves by.

```sh
ltm init acme-bank --name acme --facet-prefix service --facet-prefix domain --facet-prefix team
```

A Bank only knows which Facets a Consumer repo cares about if its `consumers:` map says so, and `ltm init` writes no entries. Add one for `acme/order-service`, then run `ltm init` again so the generated `AGENTS.md` picks it up:

```sh
cd acme-bank
cat >> memory-bank.yaml <<'EOF'
consumers:
  acme/order-service: [service:order-service, domain:commerce]
EOF
ltm init
```

## Write the First Record

A Record is one Markdown file: frontmatter on top, prose below. Write the frontmatter fields a person decides, and leave `id`, `memory_type`, and `schema` to `ltm fmt`. It reads the memory type from the folder the Record sits in. This Decision applies to `domain:commerce`, one of the Facets the `consumers:` entry maps to `order-service`.

```sh
cat > _memory/decisions/postgres-for-new-services.md <<'EOF'
---
title: Postgres for new services
status: accepted
date: 2026-10-26
summary: New commerce services use Postgres as their relational store.
applies_to: [domain:commerce]
owners: [team:commerce-architecture]
---

## Context

Commerce teams run three relational engines, and on-call has to know all of them.

## Decision

New commerce services use Postgres.

## Consequences

Existing services keep their engine until someone plans a migration.
EOF
ltm fmt
```

`ltm fmt` adds the missing fields and rewrites the frontmatter in canonical form, leaving the body byte-identical. If your editor runs Prettier, oxfmt, or the Obsidian Linter, see [Formatters and Record Frontmatter](formatters.md) to keep them off the frontmatter.

[The Decision page](../docs/types/decision.md) lays out a Decision's body under Context, Decision, and Consequences headings, and `ltm validate` warns when one is missing. The other memory types have their own pages under `docs/types/`.

## Validate the Bank

```sh
ltm validate
```

`ltm validate` prints nothing and exits 0 when the Bank is clean. Each error or warning comes out as `path:line: severity rule: message`, and any error makes it exit 1.

Commit the Bank:

```sh
git init --quiet -b main
git add -A
git commit --quiet -m "Start the acme Bank"
cd ..
```

## Push to GitHub

Create an empty repository for the Bank on GitHub and push to it:

```bash
cd acme-bank
git remote add origin https://github.com/acme/acme-bank.git
git push -u origin main
cd ..
```

`ltm init` wrote three workflows and an issue form, and GitHub picks them up on the first push:

- `.github/workflows/ltm-validate.yml` runs `ltm validate` and `ltm init --check` on every pull request.
- `.github/workflows/ltm-accept.yml` accepts a Proposal when someone with write access adds the `accept` label to its pull request.
- `.github/ISSUE_TEMPLATE/ltm-proposal.yml` is an issue form for suggesting a Record, and `.github/workflows/ltm-issue-form.yml` turns each one filed into a Proposal pull request.

Pushes and pull requests made with the default `github.token` start no other workflows, so the Accept commit and the issue form's pull request would skip `ltm-validate`. Add a repository secret named `LTM_TOKEN` holding a token that can push and open pull requests, and both workflows use it instead.

Copy `CODEOWNERS.example` to `.github/CODEOWNERS`, replace the placeholder team with whoever reviews each folder, and make `ltm-validate` a required check on `main`.

## Connect a Consumer Repo

A Consumer repo finds its Bank through your user config, which maps Bank names to local checkouts. On macOS and Linux the file is `~/.config/ltm/config.yaml`. Point it at the Bank you just made:

```sh
mkdir -p ~/.config/ltm
cat > ~/.config/ltm/config.yaml <<EOF
banks:
  acme:
    path: $PWD/acme-bank
EOF
```

The heredoc's `EOF` is unquoted so the shell fills in `$PWD`. A relative `path` would resolve against the config file's own directory.

The Consumer repo here is a new git repo whose origin is `acme/order-service`, the name the Bank's `consumers:` entry uses. A `.ltm.yaml` at its root names the Banks it reads, by their names in your user config, so everyone who clones it reads the same ones:

```sh
mkdir order-service
cd order-service
git init --quiet -b main
git remote add origin https://github.com/acme/order-service.git
cat > .ltm.yaml <<'EOF'
banks: [acme]
EOF
```

`ltm connect` prints a short Markdown section that tells the repo's agents where the Bank is and how to query it. Append it to the repo's `AGENTS.md`:

```sh
ltm connect >> AGENTS.md
```

Now query the Bank from inside the Consumer repo. With no filters, `ltm query` lists the Records in the Facets the Bank maps to this repo, plus every org-wide Record:

```sh
ltm query
```

The Postgres Decision comes back. Add `--json` for output an agent can parse, and see [Retrieval](retrieval.md) for filtering by type, Facet, status, and text.

## Install the Plugin

The `ltm` plugin gives Claude Code an MCP server over the Bank, plus skills for querying it, Hydration, and Promotion. Its MCP server runs `ltm mcp`, so `ltm` has to be on your `PATH` first. The repo is its own marketplace:

```bash
claude plugin marketplace add kendrick/long-term-memory-kit
claude plugin install ltm@ltm-marketplace
```

The plugin takes three settings:

- `bank_url` is the Bank's git URL, such as `https://github.com/acme/acme-bank.git`. The plugin clones it read-only and refreshes it on a timer.
- `bank_ttl` is how many seconds the clone is served before the next fetch. It defaults to 300.
- `bank_path` points at a local checkout instead, which it uses as is with no clone or fetch. It overrides `bank_url`, and it's for Bank authors testing Records that haven't merged.

Leave both `bank_url` and `bank_path` empty to have the plugin resolve the Bank the way `ltm query` does, from `.ltm.yaml` or your user config.

## Next

- [Retrieval](retrieval.md) covers grep, `ltm query`, and the MCP tools side by side.
- [Hydration](hydration.md) drafts Proposals from the ADRs and docs you already have.
- [Reviewing](reviewing.md) covers what to check before accepting a Proposal.
- [Promotion](promotion.md) moves a decision from one repo's working memory into the Bank.
- [Maintenance](maintenance.md) keeps the Bank current with `ltm doctor`.
