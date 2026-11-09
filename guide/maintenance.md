# Maintenance

Over time, Records stop being re-read, review dates pass, Proposals wait for a decision nobody makes, and links point at ids that no longer exist. `ltm doctor` finds those Records. It only reports, and it never edits a Record.

## Run `ltm doctor` by Hand

Run it from the Bank root:

```sh
ltm doctor
```

From any other directory, pass the Bank's path with `--bank`:

```sh
ltm doctor --bank ../acme-bank
```

Each finding prints on one line as `<file>: <check>: <message>`:

```text
_memory/context/kubernetes-platform-landscape-uH7rF3kWj6.md: stale-confirmed: date 2026-07-01 is 118 days old and there's no last_confirmed (threshold 90)
_memory/exceptions/search-service-plaintext-logs-bU2pR8aXf7.md: stale-proposal: proposed on 2026-09-25, 32 days ago (threshold 30)
```

For a script, pass `--json`. It prints the same findings as an array of objects with `file`, `check`, `message`, and `related_files`:

```sh
ltm doctor --json
```

`ltm doctor` exits `0` whenever the checks ran, with or without findings. It exits `1` outside a Bank without `--bank`, when `--bank` doesn't name a Bank, when the `doctor` block in `memory-bank.yaml` is invalid, or when `LTM_TODAY` isn't a valid date. To see what the report will say on a later day, set `LTM_TODAY` to that date in `YYYY-MM-DD` form.

## Run It on a Schedule

A weekly run catches drift before a reader does. The sample workflow below runs `ltm doctor` every Monday, writes the findings to the run's summary page, and fails the run when there are any. Save it in the Bank as `.github/workflows/ltm-doctor.yml`. Set `LTM_VERSION` to the value in your `ltm-validate.yml`, so both workflows run the same `ltm`.

```yaml
name: ltm-doctor
env:
  LTM_VERSION: "0.1.0"

on:
  schedule:
    - cron: "0 14 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ltm-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
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
      - name: Report findings
        run: |
          ltm doctor > "$RUNNER_TEMP/doctor.txt"
          if [ ! -s "$RUNNER_TEMP/doctor.txt" ]; then
            echo "ltm doctor found nothing." >> "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          { echo '```text'; cat "$RUNNER_TEMP/doctor.txt"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
          exit 1
```

The run fails on findings on purpose, since `ltm doctor` itself exits `0`. GitHub emails a failed scheduled run to the person who last edited the cron line. If nobody reads that email, have the step open an issue instead.

## Act on Each Finding

There is no suppression list. To clear a finding, edit the Record, or change a threshold under `doctor:` in `memory-bank.yaml`. Each check below links to its section in [ltm doctor](../docs/doctor.md), which gives the fields it reads, its false positives, and its full dismissal steps.

### stale-confirmed

The Record's `last_confirmed`, or its `date` when it has none, is more than 90 days old. Re-read the Record with `ltm show <id>`. If it's still true, run `ltm confirm <id>`. If it isn't, run `ltm deprecate <id>`. See [stale-confirmed](../docs/doctor.md#stale-confirmed).

```sh
ltm confirm uH7rF3kWj6
ltm deprecate cR7mT2vKb5
```

Both commands accept only an accepted Record and write nothing if any Record you name is refused. Editing `last_confirmed` or `status` by hand does the same thing.

An agent with the `ltm` MCP server connected can confirm a Record without a checkout of the Bank. It calls the `amend` tool with the Record's `id` and `set: { last_confirmed: "<today>" }`, where `<today>` is a `YYYY-MM-DD` date. `amend` pushes the change to a new `ltm/amend` branch and opens a change request, so the confirmation goes through the same review as a `propose`.

To list the Records that have never been confirmed, run this from the Bank root:

```sh
grep -rL '^last_confirmed:' _memory
```

### review-due

The Record's `review_by` date has passed. Do the review, then move `review_by` to a future date or remove it. If the Record no longer applies, set `status` to `deprecated`. See [review-due](../docs/doctor.md#review-due).

To see every review date at once:

```sh
grep -rn '^review_by:' _memory
```

### stale-proposal

A Proposal has waited more than 30 days. Decide it. Accept it through review, as [Reviewing](reviewing.md) describes, or set its `status` to `rejected`. To let it wait longer, raise `doctor.proposal_age_days`. See [stale-proposal](../docs/doctor.md#stale-proposal).

### long-chain

A Supersession chain holds more than three Records. Check that the newest Record says why the decision keeps changing. If the chain is real, raise `doctor.max_chain_length`. If a link in it is wrong, fix that `supersedes` or `superseded_by` field. See [long-chain](../docs/doctor.md#long-chain).

### orphan

A Record older than 30 days has no `related`, `supersedes`, or `superseded_by`, and no other Record links to it. Add a `related` entry in either direction. If the Record no longer matters, retire it. See [orphan](../docs/doctor.md#orphan).

### broken-related

A `related` entry names an id that no Record has. Correct the id, or remove the entry. If the target is on a branch that hasn't merged, the finding clears once it does. See [broken-related](../docs/doctor.md#broken-related).

To list every `related` entry in the Bank:

```sh
grep -rh '^related:' _memory
```

### supersession-no-shared-facet

Two Records are linked by a Supersession, one of them has an empty or missing `applies_to`, and they name no Facet in common. Confirm that the broad Record really should replace the narrow one, or the reverse. Then give both Records a common Facet, or fix the link. See [supersession-no-shared-facet](../docs/doctor.md#supersession-no-shared-facet).

## Change a Threshold

The four thresholds live under `doctor:` in `memory-bank.yaml`. Each must be a whole number of 1 or more. These are the defaults:

```yaml
doctor:
  stale_confirmed_days: 90
  proposal_age_days: 30
  max_chain_length: 3
  orphan_days: 30
```

Change a threshold through a Bank PR, like any other change. A threshold set too loose hides drift for the whole Bank, so prefer fixing a Record to raising a number.

## Related Pages

- [ltm doctor](../docs/doctor.md) is the reference for every check.
- [Supersession](../docs/supersession.md) explains the chains that `long-chain` and `supersession-no-shared-facet` read.
- [Reviewing](reviewing.md) covers accepting a stale Proposal.
