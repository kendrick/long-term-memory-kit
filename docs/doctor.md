# ltm doctor

`ltm doctor` reads every Record in a Bank and reports the ones that look stale, unlinked, or due for review. It only reports. It never edits a Record, and it exits `0` whenever the checks ran, findings or not. It exits `1` when you run it outside a Bank, when the `doctor` block in `memory-bank.yaml` is invalid, or when `LTM_TODAY` isn't a valid date.

Each finding prints as `<file>: <check>: <message>`, sorted by file and then by check, in the order the sections below appear. `ltm doctor --json` prints the same findings as an array of objects with the keys `file`, `check`, `message`, and `related_files`.

Retired Records (`status` of `superseded`, `deprecated`, or `rejected`) are skipped by `stale-confirmed`, `review-due`, and `orphan`. A malformed field is `ltm validate`'s to report, so a check that needs it skips that Record without a finding.

There is no suppression list. To clear a finding, edit the Record, or change a threshold under `doctor:` in `memory-bank.yaml`. The four thresholds are `stale_confirmed_days`, `proposal_age_days`, `max_chain_length`, and `orphan_days`. Each must be an integer of 1 or more, and each default is read from `schema/memory-bank.schema.json`.

Every report line below came from `ltm doctor` run with `LTM_TODAY=2026-10-09` on a scratch copy of `fixtures/demo-bank`. Where the demo Bank doesn't fire a check, the copy had a frontmatter edit that the section names.

## stale-confirmed

**Fields:** `last_confirmed`, or `date` when the Record has no `last_confirmed`. Proposals (`status: proposed`) and retired Records are skipped.

**Threshold:** `doctor.stale_confirmed_days`, default 90. The check fires when the field is more than that many days before today.

**Report line:** `_memory/context/kubernetes-platform-landscape-uH7rF3kWj6.md: stale-confirmed: date 2026-07-01 is 100 days old and there's no last_confirmed (threshold 90)`

**False positives:** A Record that is still correct but that nobody re-read. A reference Record about a stable system can sit past 90 days and stay accurate.

**Dismissal:** Re-read the Record and set `last_confirmed` to today's date. If the Record is no longer true, set its `status` to `deprecated`. If 90 days is too short for your Bank, raise `doctor.stale_confirmed_days`.

## review-due

**Fields:** `review_by`. Retired Records are skipped, so a superseded Record with a past `review_by` produces no finding.

**Threshold:** None. The check fires when `review_by` is at least one day before today. A `review_by` equal to today is not yet due.

**Report line:** `_memory/exceptions/legacy-billing-mysql-until-2026-12-tZ6qL0vKd1.md: review-due: review_by 2026-10-08 has passed` (scratch edit: `review_by` changed from `2026-11-15` to `2026-10-08`)

**False positives:** A Record whose review happened but whose `review_by` was never moved forward.

**Dismissal:** Review the Record, then set `review_by` to a future date or remove the field. If the Record no longer applies, retire it by setting `status` to `deprecated`.

## stale-proposal

**Fields:** `status` and `date`. Only Records with `status: proposed` are checked.

**Threshold:** `doctor.proposal_age_days`, default 30. The check fires when `date` is more than that many days before today, so a Proposal dated 30 days ago is fine and one dated 31 days ago is not.

**Report line:** `_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md: stale-proposal: proposed on 2026-09-08, 31 days ago (threshold 30)` (scratch edit: `date` changed from `2026-09-30` to `2026-09-08`)

**False positives:** A Proposal waiting on a decision that is scheduled for later, such as a planning cycle that starts next quarter.

**Dismissal:** Accept the Proposal with `ltm accept`, or set its `status` to `rejected`. To keep it waiting, raise `doctor.proposal_age_days`.

## long-chain

**Fields:** `supersedes` and `superseded_by`, read from every Record, including retired ones. Either side of a link counts.

**Threshold:** `doctor.max_chain_length`, default 3. The count is Records, not links, so A superseded by B superseded by C is 3. The count is the longest Supersession path from the newest Record, so a Record that supersedes several Records at once counts only its longest branch. The check fires when that path holds more Records than the threshold, and it reports once, on the newest Record. A chain with no newest Record, which is a closed cycle, isn't reported here. A chain that runs into a cycle still is.

**Report line:** `_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md: long-chain: Supersession chain holds 4 Records (threshold 3)` (scratch edit: two more retired Records added, each superseded by the one before it, behind `mysql-for-new-services-mB3tR9wZe1.md`). The finding's `related_files` lists the older Records on that longest path.

**False positives:** A Decision that really did change four times.

**Dismissal:** Raise `doctor.max_chain_length`. If a link in the chain is wrong, fix the `supersedes` or `superseded_by` field that wrote it.

## orphan

**Fields:** `date`, `related`, `supersedes`, and `superseded_by`, plus the `related` entries of every other Record, retired ones included. Retired Records are skipped.

**Threshold:** `doctor.orphan_days`, default 30. The check fires when the Record's `date` is more than that many days before today and nothing links it in either direction. A newer Record gets a grace period to be linked.

**Report line:** `_memory/decisions/trunk-based-deployment-rX6jK1fWc9.md: orphan: no related, supersedes, or superseded_by, and no Record relates to it (date 2025-11-03, 340 days old, threshold 30)`

**False positives:** A standalone Record that has nothing to link to, such as a glossary of terms.

**Dismissal:** Add a `related` entry to the Record, or add one pointing at it from another Record. Retire the Record if it no longer matters. To loosen the check, raise `doctor.orphan_days`.

## broken-related

**Fields:** `related`, on every Record, retired ones included. An entry's id is the text after its last `::`, or the whole entry when it has no `::`. An id resolves when at least one Record holds it, so a duplicated id doesn't fire.

**Threshold:** None.

**Report line:** `_memory/exceptions/order-service-redis-until-2027-03-wJ3nC7hTy4.md: broken-related: related entry 'constrained_by::ZZZZZZZZZZ' names id 'ZZZZZZZZZZ', which no Record has` (scratch edit: `related` changed from `[constrained_by::cA9wE6uJr3]`). A repeated entry counts as one finding.

**False positives:** A link to a Record that lives in another Bank, or one that has not been merged yet.

**Dismissal:** Correct the id, or remove the entry from `related`. If the target Record is on an unmerged branch, the finding clears once it merges.

## supersession-no-shared-facet

**Fields:** `applies_to` on both ends of a Supersession link, from `supersedes` or `superseded_by`.

**Threshold:** None. The check covers the gap that `ltm validate` leaves. Validate rejects two non-empty lists that are disjoint. This check fires when one side has an empty or missing `applies_to`, which overlaps everything, yet the two Records name no Facet in common. A pair that shares at least one Facet never fires.

**Report line:** `_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md: supersession-no-shared-facet: supersedes _memory/decisions/mysql-for-new-services-mB3tR9wZe1.md, but the two share no applies_to Facet` (scratch edit: `applies_to` on the MySQL Record changed to `[]`). The finding is on the newer Record, and the older one is in `related_files`.

**False positives:** A new Record that deliberately replaces an org-wide one, so the older Record has no Facets to share.

**Dismissal:** Give both Records at least one common Facet in `applies_to`. If the link itself is wrong, fix the `supersedes` or `superseded_by` field.
