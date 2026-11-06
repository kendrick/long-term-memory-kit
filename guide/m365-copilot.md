# M365 Copilot

People who work in Microsoft 365 ask Copilot their questions in Teams, Outlook, and SharePoint, and many of them have no GitHub seat, so a Bank never reaches them. `ltm digest` renders the Bank's accepted Records as a Digest, and a workflow in the Bank puts that Digest where Copilot can read it. There are three routes: the GitHub Cloud Knowledge connector, a workflow that uploads Word files to SharePoint, and a manual upload for tenants that won't grant the Graph token.

## What the Digest Holds

The Digest holds only accepted Records. Proposals and Retired Records stay out, so Copilot can't cite a superseded rule as if it still holds. An Exception stays in through its `effective_to` day and drops out the day after. Run it from the Bank root to print it on stdout:

```sh
ltm digest
```

The header names the Bank and pins the commit it was rendered from, so a reader can trace any line back to the Bank:

```text
# acme Digest

Bank commit 7998c1675ec7c417fc83a255227f912a990ad9cf (2026-11-05).
Scope: all accepted Records.
```

Sections follow in the order PolicyRule, Exception, Decision, Context. Each entry gives the Record's title and id, its `memory_type`, its Facets, its path in the Bank, and its full body. A PolicyRule's entry lists each Exception that departs from it. An Exception's entry gives its PolicyRule's title, id, and `summary`, or says that the PolicyRule is no longer in force when it isn't accepted. The Digest holds no markdown tables, because `ltm digest` wraps any table in a Record's body in a `text` block.

To write the Digest into a directory instead, pass `--out`. It writes `accepted.md` there:

```sh
ltm digest --out digest/
```

Two runs on the same commit and the same day write the same bytes. To render the Digest as of another day, set `LTM_TODAY` to that date in `YYYY-MM-DD` form.

## Route 1: The GitHub Cloud Knowledge Connector

Microsoft's GitHub Cloud Knowledge connector indexes every markdown file in a repo, and it can't tell an accepted Record from a Proposal. Pointed at the whole Bank, it lets Copilot cite a Retired Record as current. Point it at `digest/` instead.

The workflow in [Route 2](#route-2-the-publish-workflow) commits `digest/` to the Bank on every change. For this route alone, keep its Render the Digest and Commit the Digest steps, and drop Convert to Word, Save the Word files, Get a Graph token, and Upload to SharePoint.

The connector shows repo content only to people who can already see the repo on GitHub. Readers without a GitHub seat need Route 2 or Route 3.

## Route 2: The Publish Workflow

This workflow renders the Digest, converts each file to Word with `pandoc`, uploads the Word files to a SharePoint document library through Microsoft Graph, and then commits `digest/`. It runs on every push to the default branch and once a day.

The Word step is there because M365 Copilot's semantic retrieval covers `.docx` but not `.md`, which gets keyword matching at best. `ltm` itself writes only markdown. [ADR 0005](../docs/adr/0005-the-digest-ships-as-word-files.md) records why.

The daily run removes an expired Exception from SharePoint even when nobody pushes, since an Exception drops out of the Digest the day after its `effective_to`.

Before you add the workflow, set up the following:

- Register an Entra app with Graph application permission to write the one drive the Digest goes to. Store its tenant id and client id as the repo variables or secrets `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`, and its client secret as the repo secret `ENTRA_CLIENT_SECRET`. `ltm` stores no credential.
- `SHAREPOINT_SITE_ID` and `SHAREPOINT_DRIVE_ID` are repo variables holding the site id and the document library's drive id.
- The default branch must let the workflow push its `digest/` commit.

Save the workflow in the Bank as `.github/workflows/ltm-digest.yml`. Set `LTM_VERSION` to the value in your `ltm-validate.yml`, and change `main` if your default branch has another name:

```yaml
name: ltm-digest
env:
  LTM_VERSION: "0.1.0"

on:
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

permissions:
  contents: write

# A run that overlapped another could upload an older Digest over a newer one.
concurrency:
  group: ltm-digest
  cancel-in-progress: false

jobs:
  ltm-digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install ltm
        run: |
          base="https://github.com/kendrick/long-term-memory-kit/releases/download/v${LTM_VERSION}"
          mkdir -p "$RUNNER_TEMP/ltm"
          cd "$RUNNER_TEMP/ltm"
          curl -fsSL --retry 3 -O "$base/ltm-linux-x64" -O "$base/SHA256SUMS"
          sha256sum -c --ignore-missing SHA256SUMS
          mv ltm-linux-x64 ltm
          chmod +x ltm
          echo "$RUNNER_TEMP/ltm" >> "$GITHUB_PATH"
      - name: Render the Digest
        id: render
        run: |
          ltm digest --out digest/
          git add digest/
          # Every new commit rewrites the header's commit line, so a change there alone doesn't count.
          if git diff --cached --quiet -I '^Bank commit ' -- digest/; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi
      - name: Convert to Word
        if: steps.render.outputs.changed == 'true'
        run: |
          sudo apt-get update
          sudo apt-get install -y pandoc
          mkdir -p docx
          for f in digest/*.md; do
            pandoc "$f" -o "docx/$(basename "$f" .md).docx"
          done
      - name: Save the Word files
        if: steps.render.outputs.changed == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: digest-docx
          path: docx/
      - name: Get a Graph token
        if: steps.render.outputs.changed == 'true'
        env:
          TENANT: ${{ vars.ENTRA_TENANT_ID || secrets.ENTRA_TENANT_ID }}
          CLIENT_ID: ${{ vars.ENTRA_CLIENT_ID || secrets.ENTRA_CLIENT_ID }}
          CLIENT_SECRET: ${{ secrets.ENTRA_CLIENT_SECRET }}
        run: |
          # The default shell has no pipefail, so curl piped straight into jq could fail without failing the job.
          response=$(curl -fsS "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
            --data-urlencode grant_type=client_credentials \
            --data-urlencode "client_id=$CLIENT_ID" \
            --data-urlencode "client_secret=$CLIENT_SECRET" \
            --data-urlencode scope=https://graph.microsoft.com/.default)
          token=$(jq -r .access_token <<< "$response")
          echo "::add-mask::$token"
          echo "LTM_GRAPH_TOKEN=$token" >> "$GITHUB_ENV"
      - name: Upload to SharePoint
        if: steps.render.outputs.changed == 'true'
        run: ltm publish sharepoint --site "${{ vars.SHAREPOINT_SITE_ID }}" --drive "${{ vars.SHAREPOINT_DRIVE_ID }}" --path Digest docx/
      - name: Commit the Digest
        if: steps.render.outputs.changed == 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -m "Update the Digest"
          git push
```

An Entra access token lasts about an hour, so the Get a Graph token step mints a new one on each run with the client-credentials grant and hands it to `ltm` as `LTM_GRAPH_TOKEN`. Nobody has run this step against a real tenant yet.

The workflow commits and uploads only when some Digest file's bytes changed. It checks the markdown in `digest/` and not the Word files, because `pandoc` writes a different `.docx` on every run. The workflow makes this check because `ltm publish sharepoint` never skips a file and uploads every file in the directory each time it runs. A push made with the workflow's own token starts no new run, so the `digest/` commit doesn't loop. The commit comes last because the change check compares against the committed `digest/`. When an upload fails, the run commits nothing, so the next run still sees the change and uploads again.

`ltm publish sharepoint` sends one `PUT` per file to the folder `--path` names in the drive, and it overwrites the file it wrote last time. It uploads each file as it is and converts nothing. When one upload fails, it still sends the rest, then exits `1` and names each failed path on stderr. A rerun is always safe. Without `LTM_GRAPH_TOKEN`, it exits `2`, names the variable, and sends nothing. It calls the Graph API and never a model.

To check the target URLs before the first upload, pass `--dry-run`. It needs no token and sends nothing:

```sh
ltm publish sharepoint --site <site-id> --drive <drive-id> --path Digest docx/ --dry-run
```

It prints one URL per file:

```text
https://graph.microsoft.com/v1.0/sites/<site-id>/drives/<drive-id>/root:/Digest/accepted.docx:/content
```

## Route 3: Upload by Hand

Some tenants won't grant the Graph token. For them, delete the workflow's Get a Graph token and Upload to SharePoint steps and keep Save the Word files. Each run that changes the Digest then saves the `.docx` files as a zip in a GitHub Actions artifact named `digest-docx`.

To bring SharePoint up to date, download that artifact from the run's page and unzip it. Upload every `.docx` file in it to the document library, and replace the files with the same names.

## Split a Large Digest by Facet

To write one file per Facet, pass `--split facet` with `--out`:

```sh
ltm digest --out digest/ --split facet
```

Each Facet value in an accepted Record gets its own file, and org-wide Records go in `org-wide.md` only. The file name escapes every character outside `a-z`, `0-9`, and `-`, so `service:order-service` becomes `service_3aorder-service.md`. A Record with two Facets appears in both files.

`ltm digest` warns on stderr when any one file passes 1,500,000 characters, and the warning names `--split facet`. Microsoft Search stops reading a file after 2,000,000 characters. The run still exits `0`.

`ltm` never deletes a file, in `<dir>` or in SharePoint. When a file drops out of the Digest, `ltm digest --out` overwrites it with a placeholder that names where the Digest went. That happens when a Facet loses its last accepted Record, or when you switch `<dir>` between the single file and `--split facet`. A placeholder's first line is `<!-- ltm digest placeholder -->`, which `pandoc` drops, so the Word file holds only the note. The workflow uploads the placeholder over the old file, and Copilot stops citing what it held. A later run leaves an existing placeholder byte for byte. `ltm digest` never touches a file in `<dir>` that doesn't end in `.md`.

## Tell the Agent What Binds

The Digest holds every accepted Record and nothing else. If you build a declarative agent over the library, give it this instruction verbatim:

```text
treat any rule that isn't in the Digest as non-binding.
```

## Related Pages

- [ADR 0005](../docs/adr/0005-the-digest-ships-as-word-files.md) records why the Digest ships as Word files and why `ltm` never deletes in the tenant.
- [Exception](../docs/types/exception.md) covers `effective_to` and the `related` link to a PolicyRule.
- [Maintenance](maintenance.md) runs `ltm doctor` on a schedule with the same install step.
