---
name: hydrate
description: Use when someone wants Bank Proposals drafted from existing material, such as ADRs, PRDs, meeting transcripts, pull requests, or notes. Covers Hydration end to end, from finding the sources to opening the Proposals for review.
---
<!-- VENDORED-FROM: kendrick/long-term-memory-kit skills/hydrate -->
<!-- VERSION: 0.0.0 -->

# Hydrate

Hydration drafts Proposals for a Bank from material a team already has. You do the reading and the drafting. `ltm` does the mechanical steps, and it never calls a model. A person reviews every Proposal before it becomes a Record.

Every step that uses `ltm` also gives the manual way to do it. A team without `ltm` can follow this skill with a shell and an editor.

## Rules

- Every output is a Proposal, with `status: proposed`. Never set `status: accepted`, because Acceptance belongs to the Bank's merge review.
- Every Proposal cites the files it came from in `source_refs`.
- Skip any Hydration source whose `cited_by` isn't empty. A Record already cites it, so the source has been hydrated before.
- An ADR can produce more than a Decision. It can also produce the PolicyRules and Exceptions that follow from that Decision. Link each one to the Decision through `related`.
- Never write to the Bank's default branch. Each Proposal goes on its own branch and reaches the Bank through review.
- Never call a model API from a script or a tool for this work. The judgment in Extract, Draft, and Reconcile is yours, in this session.

## Discover

List the Hydration sources under the paths the person gave you:

```text
ltm discover docs/adr notes/ --bank <bank>
```

Each line shows a source's kind (`adr`, `pr`, `transcript`, `prd`, or `document`), its path, its title, and any Records that already cite it. Drop every source that shows a citation.

Without `ltm`, glob for the files yourself, such as `docs/adr/*.md`. Then, from the Bank root, grep for Records that already cite each one:

```sh
grep -rl '^source_refs: .*0001-postgres.md' _memory
```

A match means a Record cites that source, so skip it.

## Extract

Read each remaining source in full. Pull out the claims that might belong in the Bank: the choice and reasons behind a Decision, the PolicyRules a team follows, the Exceptions to them, and the Context agents need to reason correctly.

Test each claim against the bright line. A claim belongs in a Bank when it applies to more than one repo, or when someone outside one repo's team governs it. Leave anything else in the repo's Working memory.

This step is your judgment, and `ltm` has no part in it.

## Draft

Give each claim one memory type: Decision, PolicyRule, Exception, or Context. Write a title, a one-line summary, and a body for it. Choose the Facets it applies to, using prefixes the Bank's `memory-bank.yaml` declares. Leave `applies_to` empty only for a claim that really is Org-wide.

Keep each draft short enough for a reviewer to read in one sitting.

## Reconcile

Before you propose anything, look for Records that already cover the same ground. Search by the draft's words and its Facets:

```text
ltm query --text "postgres" --facet domain:commerce --all --bank <bank>
```

Pass the same `--bank` you gave Discover. Without it, `ltm query` picks a Bank from the current directory or your user config, which may not be the Bank you are proposing to. `--all` keeps Retired Records in the results, so an old choice you are about to repeat still shows up.

Without `ltm`, grep titles and summaries from the Bank root:

```sh
grep -rliE '^(title|summary): .*postgres' _memory
```

Decide what each match means for the draft:

- The same claim already exists. Drop the draft.
- The draft supersedes an older Record. Mark the Supersession with `--supersedes <id>`.
- The draft narrows or depends on another Record. Link the two through `related`.

## Validate

Run `ltm validate` from the Bank root before you propose. A clean result means any later failure comes from your Proposal.

Preview each Proposal with `ltm propose --dry-run`, using the same options you will pass in the next step. It prints the Record without writing it. If you wrote a Record file by hand, run `ltm validate <path>` on it.

Without `ltm`, check the file against `schema/record.schema.json`. Keep each list on one line, and close the frontmatter within its first 20 lines.

## Propose

Open one Proposal for each draft, from inside a checkout of the Bank:

```text
ltm propose --type Decision --title "Use PostgreSQL" --summary "…" --applies-to domain:commerce --source-ref docs/adr/0001-postgres.md --body-file draft.md
```

Pass `--source-ref` once for each source, and `--related` or `--supersedes` for what Reconcile found. `ltm propose` writes the Record on a new `ltm/propose` branch and opens a change request. If no forge adapter is set up, it prints the branch to open one from.

Without `ltm`, create a branch in the Bank. Write the file under the folder for its memory type, such as `_memory/decisions/`, and open a pull request.

Stop when every Proposal is open. Give the person the list of review links.
