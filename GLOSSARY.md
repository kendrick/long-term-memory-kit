# Long-Term Memory Kit

Org-level memory that coding agents in any repo can consult for architecture decisions, standards, and their exceptions. It pairs with working-memory-kit, which holds what one repo knows about itself.

## Language

### Banks and Their Readers

**Bank**:
A git repository of records that apply to more than one repo, or that someone outside a repo's own team governs. A consultant may keep one bank per client, plus a personal one.
_Avoid_: Knowledge base, vault, memory store

**Consumer repo**:
A repository whose agents read from a bank but hold none of its records.
_Avoid_: Client repo, downstream repo

**Working memory**:
Decisions and conventions that apply to one repo only and that the repo's own team governs. They live in that repo under working-memory-kit, never in a bank.
_Avoid_: Local memory, repo memory

**Facet**:
A prefixed scope value on a record, such as `service:order-service` or `domain:commerce`, saying where the record applies. The bank declares which prefixes exist, and any value is allowed after one.
_Avoid_: Tag, label, scope

### Records

**Record**:
One markdown file in a bank, holding frontmatter and a prose body. Each record has exactly one memory type.
_Avoid_: Memory, entry, note, document

**Decision**:
A record of a choice and its reasoning. A Nygard-style ADR with frontmatter is already a Decision.
_Avoid_: ADR (when meaning the bank's record type)

**PolicyRule**:
A record stating a standard that applies across its facets.
_Avoid_: Policy, standard, rule

**Exception**:
A record granting a bounded, usually time-limited, departure from a PolicyRule.
_Avoid_: Waiver, override

**Context**:
A record of background that isn't a choice or a rule but that agents need to reason correctly.
_Avoid_: Background, fact

**Canonical form**:
The one frontmatter layout every record is written in: flat values, lists on a single line, and a header that closes early enough for a cheap read.
_Avoid_: Normalized form, house style

**Retired**:
A record whose `status` is `superseded`, `deprecated`, or `rejected`. Queries leave retired records out unless you ask for them.
_Avoid_: Archived, inactive, dead

**Org-wide**:
A record whose `applies_to` is missing, `null`, or `[]`. It falls inside every facet, so it matches every facet query and every supersession scope check.
_Avoid_: Global, unscoped, universal

### Lifecycle

**Proposal**:
A record with `status: proposed`. Agents surface it as context but never treat it as a constraint.
_Avoid_: Draft, candidate (once it's a file)

**Acceptance**:
The change that moves a proposal to `accepted`, made through the bank's merge review.
_Avoid_: Approval, publishing

**Supersession**:
Retiring one record in favor of a newer one, recorded on both records.
_Avoid_: Replacement, override

**Promotion**:
Moving a decision from a repo's working memory into a bank because it turned out to matter beyond that repo.
_Avoid_: Upstreaming, escalation

**Hydration**:
Drafting proposals from existing material such as ADRs, transcripts, PRDs, and pull requests. A person reviews every proposal.
_Avoid_: Ingestion, import, seeding

**Hydration source**:
A local file that hydration reads, which `ltm discover` classifies as `adr`, `pr`, `transcript`, `prd`, or `document`.
_Avoid_: Input, seed file, raw material
