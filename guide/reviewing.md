# Reviewing

Every change to a Bank arrives as a pull request. Most are Proposals, opened by `ltm propose`, by Hydration, by `ltm promote`, or by the issue form.

## Review a Proposal PR

Wait for the `ltm-validate` check first. `ltm init` writes it to `.github/workflows/ltm-validate.yml`, and it runs two commands on every PR:

```sh
ltm validate --format github
ltm init --check
```

The first checks `memory-bank.yaml` and every Record against the schemas and Bank rules, with each finding shown as an annotation on the diff. The second fails when the generated `AGENTS.md` or its pointers are stale. If the check is red, ask the author to fix it before you read further.

Then read the Record itself. Check these things:

- It belongs in a Bank. It applies to more than one repo, or someone outside one repo's team governs it. Anything else belongs in that repo's Working memory.
- Its memory type fits: Decision, PolicyRule, Exception, or Context.
- Its `applies_to` names the right Facets. An empty list makes it Org-wide, which applies to every repo.
- Its `source_refs` point at the material it came from.
- It doesn't repeat a Record the Bank already has.

To look for a repeat, check out the PR branch and query the Bank from its root. Pass `--all` so Retired Records show up too:

```sh
ltm query --text "event bus" --all
```

If the Proposal replaces an older Record, its `supersedes` list should name that Record's id. Acceptance then retires the older one.

## Three Ways to Accept

A Proposal becomes a Record when its `status` changes to `accepted` in a merged PR. Pick one of three ways to make that change. If a PR merges with none of them, the Record lands as `proposed`.

### The `accept` Label

`ltm init` writes `.github/workflows/ltm-accept.yml`. When someone adds the `accept` label to a PR, the workflow does this:

1. It checks that the person who added the label has write access or higher. If not, it comments and stops.
2. It runs `ltm accept --changed-since origin/<base>` on the PR branch, which accepts every Proposal the PR adds or changes.
3. It commits the result as `Accept <ids>`, pushes it to the PR branch, and comments with the commit.

The reviewer then sees the final diff, with stamped dates and any Supersession edits, before merging. If `ltm accept` refuses, nothing is committed and the comment shows why.

For a PR from a fork, the workflow can't push to the branch. It comments the command to run instead.

Add an `LTM_TOKEN` secret to the Bank: a fine-grained token or GitHub App token with contents and pull-requests write. Without it, the workflow pushes with the default workflow token, and GitHub doesn't run `ltm-validate` on that commit. To re-run the check without the secret, push an empty commit.

### `ltm accept` on Your Machine

Accept one Proposal by id from the Bank root, on the PR branch:

```sh
ltm accept pL2sG4nVq0
```

To accept every Proposal the branch adds or changes, compare it against the base branch:

```sh
git fetch origin
ltm accept --changed-since origin/main
```

Either way, `ltm accept` sets `status: accepted`, sets `date` and `last_confirmed` to today, and makes every Supersession the Proposal lists in `supersedes`. `ltm accept` plans each Proposal's edits first and refuses before writing anything if one can't be made, so a refused Proposal changes nothing. With `--changed-since`, that holds per Proposal, not for the batch. A refusal stops the run, and Proposals accepted before it stay written. After a failed batch, check `git status` and `git diff` before you commit. Commit the changed files and push them to the PR branch.

### A Hand Edit

You can make the same edit in an editor. On the Proposal, set `status` to `accepted`, and set `date` and `last_confirmed` to today. For each id in its `supersedes` list, open that Record, set its `status` to `superseded`, and set `superseded_by` to the new Record's id.

Run `ltm validate` before you push. It catches a Supersession you wrote on one side only:

```sh
ltm validate
```

To check a Record from a Consumer repo, pass its path. `ltm validate` finds the Bank from the path, so you don't have to `cd` into the Bank first:

```sh
ltm validate ../acme-bank/_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md
```

## Supersession

A Supersession retires one Record in favor of a newer, accepted one. A Proposal that lists `supersedes` gets its Supersessions at Acceptance. To link two Records that are both already accepted, run `ltm supersede` from the Bank root with the old id first:

```sh
ltm supersede <old-id> <new-id>
```

It edits both files together. It refuses, and changes nothing, when the new Record isn't `accepted`, when the old one already names a different successor, when the link would close a cycle, or when the two Records share no Facet. [Supersession](../docs/supersession.md#the-two-record-edit) lists every refusal. Open the two-file change as its own PR, so a reviewer sees both sides.

## CODEOWNERS and Branch Protection

GitHub enforces review only when the Bank's repository is set up for it. Set up three things.

First, name the people who review Records. `ltm init` writes `CODEOWNERS.example` with one line per memory-type folder:

```text
/_memory/decisions/ @your-org/memory-maintainers
/_memory/policy-rules/ @your-org/memory-maintainers
/_memory/exceptions/ @your-org/memory-maintainers
/_memory/context/ @your-org/memory-maintainers
```

Copy it to `.github/CODEOWNERS`. Replace `@your-org/memory-maintainers` with your own team, and give a folder its own team when a different group governs that memory type.

Second, protect the default branch with a branch protection rule or a ruleset. Turn on these settings:

- Require a pull request before merging, with at least one approval.
- Require review from Code Owners.
- Require the `ltm-validate` status check to pass.

Third, decide who can add the `accept` label. GitHub lets anyone with triage access add a label. The workflow ignores a label from anyone below write access, so a triager can't accept a Proposal.

## Related Pages

- [Supersession](../docs/supersession.md) explains the two-Record edit and the shared-Facet check.
- [Hydration](hydration.md) opens Proposals in bulk.
- [Promotion](promotion.md) opens a Proposal from a Consumer repo.
- [Maintenance](maintenance.md) finds Proposals that waited too long.
