---
name: hydrate
description: Use when someone wants Bank Proposals drafted from existing material, such as ADRs, PRDs, meeting transcripts, pull requests, or notes. Covers Hydration end to end, from finding the sources to opening the Proposals for review.
---
<!-- VENDORED-FROM: kendrick/long-term-memory-kit skills/hydrate -->
<!-- VERSION: 0.1.0 -->

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

Each line shows a source's kind (`adr`, `pr`, `transcript`, `prd`, `document`, or `binary-doc`), its path, its title, and any Records that already cite it. Drop every source that shows a citation. A `binary-doc` is a Word, PowerPoint, Excel, or PDF file, which you convert before you read it. The SharePoint section below covers how.

Without `ltm`, glob for the files yourself, such as `docs/adr/*.md`. Then, from the Bank root, grep for Records that already cite each one:

```sh
grep -rl '^source_refs: .*0001-postgres.md' _memory
```

A match means a Record cites that source, so skip it.

## SharePoint

Use this section when the sources are Word, PowerPoint, Excel, or PDF files in a SharePoint document library.

### Sync the Library

Work from a synced folder whenever the person has one, because only a local folder lets `ltm discover` fill `cited_by`. Ask the person to sync the library with the OneDrive client, through the library's "Sync" or "Add shortcut to My files" button.

Read `<site>` and `<library>` off the library's address in the browser. They are the two path segments after `/sites/`, URL-decoded, with case kept. `https://acme.sharepoint.com/sites/acme/Policies/Forms/AllItems.aspx` gives `sharepoint:acme/Policies/`. Leave the tenant out. Don't use the library's display name, which someone can rename; the default library shows "Documents" while its address says `Shared%20Documents`.

Run Discover on the synced folder with that prefix:

```text
ltm discover ~/Acme/Policies --source-ref-prefix sharepoint:acme/Policies/ --bank <bank>
```

`--source-ref-prefix` joins the prefix to each file's path under the folder. A Record that cites `sharepoint:acme/Policies/data-retention.docx` then shows up in that file's `cited_by`.

### Check for Converters

Before you convert anything, see which converters are installed:

```sh
command -v markitdown pandoc pdftotext
```

`markitdown` reads all four formats when it's installed with its extras, as `markitdown[all]`. `pdftotext` reads `.pdf`, and `pandoc` reads `.docx`. Recent `pandoc` releases also read `.pptx` and `.xlsx`, and older ones don't. If `pandoc` is installed, check `pandoc --list-input-formats` for `pptx` and `xlsx` before you count on it for those formats. Compare what's installed against the extensions Discover listed. If a listed format has no converter, tell the person once, before you draft anything. Name `markitdown[all]` as the one install that covers all four formats (`pipx install 'markitdown[all]'`), and ask whether to install it or skip those files. Never install a converter without the person's yes.

### Convert

Convert each `binary-doc` whose `cited_by` is empty into Markdown in your working directory, such as `markitdown data-retention.docx > data-retention.md`. Read the converted text in Extract, as you would any other source.

Skip a file when no installed converter reads it or its converter exits with an error. List each skipped file in the run summary with the install that would have covered it. A bare `markitdown` install, without the extras, exits with an error on `.docx` and `.pdf`. Never draft from a file name, because a name like `data-retention.docx` doesn't say what the policy requires.

A converted file that opens with a `# … Digest` heading, followed by a line starting `Bank commit`, is a Digest from this Bank or another one. Skip it and list it in the run summary as "a Digest; read its Bank instead." A Digest copies a Bank's accepted Records, so a Proposal drafted from one would cite a copy. `ltm publish sharepoint` also puts Digests into libraries people sync.

### Cite

Every Proposal drafted from the library cites `sharepoint:<site>/<library>/<relative path>`, the prefix joined to the file's path under the synced folder:

```text
ltm propose --type PolicyRule --title "Keep order records for seven years" --summary "…" --source-ref sharepoint:acme/Policies/data-retention.docx --body-file draft.md
```

### Without a Synced Folder

Use this route only when the person has no synced folder, for example because the tenant blocks the OneDrive client. It also needs a SharePoint MCP tool the session already has, such as Work IQ, which is in preview. List and read the library through that tool, convert and skip as above, and cite the same `sharepoint:<site>/<library>/<path>` form. With no local folder, Discover can't fill `cited_by`, so check each file from the Bank root with `grep -rl 'sharepoint:acme/Policies/data-retention.docx' _memory`. Never install or configure an MCP server. If the tools are missing or return an error, stop and report it.

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
