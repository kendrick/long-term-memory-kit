# Hydration

Hydration drafts Proposals for a Bank from material your teams already have: ADRs, meeting transcripts, PRDs, pull requests, and notes. An agent does the reading and drafting. `ltm` does the mechanical steps and never calls a model. A person reviews every Proposal before it becomes a Record.

The plugin ships two ways to run it. The `hydrate` skill walks the steps with you in one session. The `hydrator` agent runs the same skill end to end on a batch of paths and reports back when the Proposals are open.

## Before You Start

You need four things:

- the `ltm` plugin installed, with `ltm` on your `PATH` ([Getting Started](getting-started.md) covers both)
- a local checkout of the Bank, on its default branch and up to date
- a folder of Hydration sources, such as `docs/adr/` and a folder of transcripts
- a GitHub token in `GH_TOKEN` or `GITHUB_TOKEN`, if the Bank lives on GitHub and you want `ltm propose` to open the PRs for you

Without a token, `ltm propose` still pushes each Proposal's branch. It then prints a link you can open the PR from.

Run `ltm validate` in the Bank checkout first. A clean result means any later failure comes from a Proposal:

```sh
ltm validate
```

## Preview the Sources

To see what Hydration will read, run `ltm discover` on the source folders. Pass `--bank` so it can check which sources a Record already cites. This example runs from a checkout of this kit, against its fixtures:

```sh
ltm discover fixtures/hydration-sources --bank fixtures/demo-bank
```

```text
adr  fixtures/hydration-sources/adr/0001-postgres.md  1. Use PostgreSQL  (cited: kQ7vN2xLp4)
adr  fixtures/hydration-sources/adr/0002-event-bus.md  Use an event bus for order events
adr  fixtures/hydration-sources/adr/0003-no-shared-db.md  3. No shared databases
document  fixtures/hydration-sources/notes.md  Platform team notes
pr  fixtures/hydration-sources/pr-1234.json  Move session storage to PostgreSQL
prd  fixtures/hydration-sources/prd-checkout.md  PRD: Checkout redesign
transcript  fixtures/hydration-sources/transcripts/arch-sync-2026-09.vtt  arch-sync-2026-09.vtt
```

Each line shows the source's kind, its path, and its title. A source with a `cited:` list has been hydrated before, and the skill skips it. Here `0001-postgres.md` is already cited by Record `kQ7vN2xLp4`.

Without `ltm`, check a source by hand. From the Bank root, grep for Records whose `source_refs` name it:

```sh
grep -rl '^source_refs: .*0001-postgres.md' _memory
```

## Run the Skill

In Claude Code, run `/ltm:hydrate` and name the source folders and the Bank checkout. For example: "hydrate `docs/adr` and `notes/transcripts` into the Bank at `../acme-bank`".

The skill works through six steps in order:

1. Discover lists the sources and drops the cited ones.
2. Extract reads each source and pulls out claims that apply to more than one repo, or that someone outside one team governs. Anything else stays in the repo's Working memory.
3. Draft gives each claim a memory type, a title, a summary, a body, and its Facets.
4. Reconcile searches the Bank for Records that already cover each draft. A duplicate is dropped. A draft that replaces an older Record gets `--supersedes`, and one that depends on another gets a `related` link.
5. Validate previews each Proposal with `ltm propose --dry-run`.
6. Propose opens one Proposal per draft with `ltm propose`, each on its own `ltm/propose` branch.

The skill stops when every Proposal is open, and it gives you the list of review links. It never accepts a Proposal and never pushes to the Bank's default branch.

## Run the Agent

For a large batch, hand the work to the `hydrator` agent instead. Ask Claude Code to use the `hydrator` agent, and give it the same two things: the paths to read and the Bank checkout. If you leave either out, it asks rather than guessing.

The agent reports each review link when it finishes. It also lists every source it skipped, with the reason.

## Check a Proposal Before Review

Each Proposal is one Record with `status: proposed`. Before you hand the batch to reviewers, spot-check a few:

- `source_refs` names the files the Proposal came from.
- `applies_to` uses prefixes the Bank declares. It's empty only for a claim that really applies everywhere.
- The body is short enough to read in one sitting.
- A Proposal that replaces an older Record lists it in `supersedes`.

## Review the Proposals

Review each Proposal PR like any other Bank change. [Reviewing](reviewing.md) covers the `ltm-validate` check, the three ways to accept, and Supersession. A Proposal you reject can be closed without merging, or merged with `status: rejected` if you want the Bank to remember the answer.

A Proposal PR merged without Acceptance lands as `proposed` on the default branch. To list those, run this from the Bank root:

```sh
grep -rl '^status: proposed$' _memory
```

## Related Pages

- [Reviewing](reviewing.md) accepts or rejects what Hydration opened.
- [Retrieval](retrieval.md) shows how Proposals appear in queries.
- [Retrieval Model](../docs/retrieval-model.md) explains why every list stays on one line.
