# long-term-memory-kit: Design

Status: agreed in a design interview on 2026-10-08. This file is the input for `/to-spec` and `/to-tickets`. Vocabulary follows `GLOSSARY.md`; ADRs live in `docs/adr/`.

## Origin

- Next-generation, from-scratch successor to `kendrick-at-slalom/memory-bank` (local: `~/repos/personal/memory-bank`), a prose-only reference architecture for memory banks (four record types, base schema, four-stage retrieval funnel, six-phase hydration skills).
- Must implement, by intent, the memory-bank items (MB-1 to MB-11) of the "Memory Convergence Plan": https://claude.ai/artifact/SHwdFoT6AiPeUgzozLYsV2 (read it with the Artifact tool's `read` action). The plan also defines items for `kendrick/skills` (I2M-*) and `kendrick/working-memory-kit` (WMK-*); those are not built here.
- This repo takes over memory-bank's role in the plan's ownership table: it owns the record spec, retrieval model, validator, canonical hydration pipeline, eval format, and the frontmatter tool. The old repo gets frozen with a "superseded by" pointer once this one reaches parity.
- Hosting: personal GitHub, `kendrick/long-term-memory-kit`, private to start. License: fresh MIT in Kendrick Arnett's name. Port no text from the original (it is MIT, copyright Slalom); rewrite ideas from scratch. No prior-art notice.
- Name: pairs with working-memory-kit (short-term, per-repo memory). CLI and MCP server name: `ltm`.

## Principles

1. **A bank is useful with zero installs.** Plain markdown plus generated agent instructions works in any agent, language, or platform. Canonical single-line frontmatter exists so plain grep stays accurate.
2. **Tooling accelerates; it is never the entry fee.** Rungs, each optional: plain files → JSON Schema (validate from any language) → `ltm` CLI → `ltm mcp` → plugin. Every `ltm` operation has a documented manual equivalent.
3. **Host-neutral.** Git is the only assumption. Forge-specific pieces (GitHub Actions, issue forms) are adapters; GitLab and Azure DevOps get equivalent adapters in v1.1.
4. **ADRs come in as they are.** A Nygard or MADR ADR with ordinary frontmatter is a valid Decision record, or one deterministic `ltm fmt` away from one.
5. **`ltm` never calls a model** (ADR 0001). The agent harness supplies judgment; `ltm` does every mechanical step. Be as deterministic as possible everywhere.
6. **The bright line.** A record belongs in a bank when it applies to more than one repo, or when someone outside a repo's team governs it (e.g., an Exception to a bank PolicyRule for one service). Everything else is working memory and lives in the repo under working-memory-kit. Promotion is the bridge.
7. **Lean over comprehensive.** Adoption matters more than completeness; add fields and concepts only on observed need. (Carried over from the original.)

## Bank model

- A bank is a git repo, typically central per org or client (a consultant may keep one per client plus a personal one). Consumer repos hold no bank records.
- Example: Acme's bank holds "ADR: Postgres everywhere", "POL: no cross-service DB reads", "EXC: order-service may use Redis until 2027-03". An agent in `order-service` queries with its facets and gets the policy plus the exception, superseded records filtered out. `order-service/_working-memory/decisionLog.md` (WMK) holds "we picked ioredis", which never enters the bank.
- Config: one `memory-bank.yaml` at the bank root, with its own JSON Schema, validated by `ltm validate`. Its presence marks a repo as a bank (`ltm` walks up to find it). It holds:
  - type → folder map; default `_memory/<type>/`, overridable (e.g., `decisions: docs/adr`) so an existing ADR repo becomes a bank in place ("adopt in place")
  - facet prefixes (closed set, e.g. `service`, `domain`, `system`, `team`, `platform`)
  - consumer-repo mapping: git remote `org/repo` → facets (e.g. `acme/order-service → [service:order-service, domain:commerce]`)
  - body-heading aliases (Nygard + MADR built in)
  - `doctor` thresholds
  - reserved `recall:` key (qmd, v1.1) and reserved `subject` behavior switch
- Multiple named banks per user. Resolution order for a consumer repo: explicit repo config file → git-remote host/org match rule in user config → default. Multi-bank query results merge and label each result with its bank.
- Server access: plugin `userConfig` takes a bank git URL; the server clones read-only into the plugin data dir and fast-forwards on a TTL; optional local-path override for authors. Responses report the bank commit. A hosted remote MCP server can come later without changing the tool surface.
- Repo identity: derived from the consumer repo's git remote, mapped to facets via `memory-bank.yaml`. Unmapped repos fall back to org-wide records only, and the response says so.

## Records

- Four types: Decision, PolicyRule, Exception, Context.
- **Canonical form** (MB-1): every value a scalar or a flat list of scalars; lists in single-line flow style; frontmatter closes within the first 20 lines (budget table documented, including `summary`). `applies_to` is a flat list of facet strings (`[service:order-service, domain:commerce]`); `related` entries are compound strings (`[constrained_by::<id>]`). No `uuid`, no `qmd:` block.
- **JSON Schema is the contract** (draft 2020-12) for records and for `memory-bank.yaml`. The validator, `fmt` key order, MCP server, scaffold, and generated instructions all read it. Prose docs explain why; they never define fields.
- `schema: 1` marker. No backward compatibility with the original memory-bank format.
- **Required tier:** `title`, `status`, `date` only. `id` (10-char nanoid) is required on disk but `ltm fmt` adds it when missing without renaming the file; `memory_type` comes from the folder and `fmt` writes it in so plain grep works. Filenames: optional human slug + nanoid; files never get renamed and ids never regenerate.
- **Recommended/optional:** `summary` (MB-2, one sentence: claim plus scope), `applies_to`, `owners` (flat, e.g. `[team:commerce-architecture]`), `tags`, `effective_from`, `effective_to`, `last_confirmed` and `review_by` (MB-5; `last_confirmed` only moves forward), `related`, `supersedes`, `superseded_by`, `source_refs` (flat), `promoted_from` / `promoted_to`. `subject` is reserved: accepted by the schema, unused by the validator in v1.
- Status lifecycle: `proposed → accepted → superseded | deprecated | rejected`. Proposals are context, never constraints.
- **Bodies are convention, not contract.** New records come from a Nygard template (Context / Decision / Consequences for Decisions). `ltm validate` warns, never fails, when a Decision lacks recognizable sections; recognizes Nygard and MADR headings plus configured aliases. `ltm fmt` lifts a body-level `## Status` into frontmatter so classic Nygard ADRs drop in. (MB-3's non-goal "validating body sections" holds for errors.)
- **Supersession / invalidation** (MB-5): always explicit, via `ltm supersede old new` or a hand edit, never inferred. The validator checks the two-record edit is complete and that the records share at least one facet. The "same subject" judgment stays with the human. Clear path forward: turn on an explicit `subject` slug (option a) or qmd-assisted candidates (option b) later via config; `ltm doctor` reports supersessions between records sharing no facet so the need shows up in data.
- Bright-line check: `ltm validate` warns when a bank record's only facet is a single `service:` and it relates to no bank PolicyRule ("looks like working memory").
- Formatter drift (MB-10): document tested Prettier/oxfmt overrides (`embeddedLanguageFormatting: "off"` scoped to memory paths) and Obsidian Linter settings; `ltm init` writes the overrides; `ltm fmt` in pre-commit is the backstop. Ship the before/after fixture and a check script.

## CLI: `ltm`

The CLI is the implementation; `ltm mcp` is a thin wrapper over the same functions. Any agent with a shell can run the whole funnel through `ltm` without MCP. Human-readable output by default, `--json` for agents.

| Command | Job |
| --- | --- |
| `init` | Scaffold a bank: `memory-bank.yaml`, type folders, generated `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`) + `.github/copilot-instructions.md` pointer, formatter overrides, CODEOWNERS sample, GitHub CI + issue form. `init --check` fails when generated files are stale against config/schema. |
| `fmt` | Rewrite frontmatter to canonical form; body byte-identical; idempotent; adds missing `id`/`memory_type`; lifts body `## Status` (MB-9). |
| `query` | Parse frontmatter and filter (`key=value`, type, facets, status, free `text`); works on drifted files too (MB-9). Free text in v1 is a deterministic lexical match over `title` + `summary`; qmd replaces it behind the same parameter in v1.1. |
| `head` | Print frontmatter up to the closing fence (MB-9). |
| `validate` | JSON Schema + canonical form + 20-line budget + folder/type match + supersession completeness + facet prefixes + config; warnings for body sections and bright line. `--format github\|gitlab\|junit` (MB-3). |
| `facets` | List facet values in use. |
| `doctor` | Report-only consolidation checks (MB-6): stale `last_confirmed` (default 90 days), `review_by` past, proposals older than 30 days, supersession chains longer than 3, orphans with no relationships after 30 days, broken `related` targets, supersessions sharing no facet. Each check documents its fields, threshold, report line, false-positive shape, and dismissal. Near-duplicates arrive with qmd in v1.1. Never writes. |
| `propose` | Write a schema-valid `status: proposed` record to a branch and open a PR via the forge adapter; without an adapter, push the branch and print the compare/MR URL. Never writes the default branch. |
| `accept` | Flip `proposed → accepted`, stamp date and `last_confirmed`, perform the two-record supersession edit when applicable. Optional; a hand edit in a reviewed PR is equally valid. |
| `supersede` | The explicit two-record supersession edit. |
| `promote` | From inside a consumer repo, convert a repo ADR or WMK `decisionLog.md` entry into a bank proposal (same path as `propose`). On acceptance ownership transfers to the bank; the local item gets `promoted_to: <bank>:<id>`. |
| `discover` | Inventory hydration sources (mechanical half of the hydration discover phase). |
| `connect` | Print the consumer-repo `AGENTS.md` snippet: "Org memory lives at <path/URL>; follow its AGENTS.md to query it." `--write <file>` writes it into the named file when a person runs it, the same kind of explicit write as `promote`'s `promoted_to` stamp; no tool writes into consumer repos on its own. |
| `mcp` | Run the MCP server. |

Downstream contract: the plan's `fm fmt|query|head` become `ltm fmt|query|head` with the same semantics, so I2M-8 and WMK-5 only swap the command prefix.

## Flows

- **Query:** the four-stage funnel (glob → frontmatter grep → header read → full read), through `ltm`/MCP or by hand. Stage 0 semantic recall (MB-4) arrives with qmd in v1.1; precise questions skip it. Status and facet filtering happen in the server/CLI, which closes MB-11 (no derived `qmd.metadata` block).
- **Submit (low friction):** MCP `propose` tool (any agent, any repo), `ltm propose` (people), GitHub issue form on the bank repo whose Action turns the form into a record PR (browser-only users). All three share one code path.
- **Accept:** a reviewed edit in a merged PR/MR. Permission is whatever the forge enforces (CODEOWNERS, approvals, branch protection) plus a required `ltm validate` check. Optional GitHub Action: a code owner applies an `accept` label, the Action runs `ltm accept <id>` and commits onto the PR branch so the reviewer sees the final diff. A PR merged without the label lands the record as `proposed`.
- **Promote:** CLI, MCP `propose` with a `from:` path, and a WMK nudge (filed against WMK, not built here). README gets a "Promote a decision" section near the top.
- **Hydrate (core, a must-have for most orgs):** the harness's LLM does extract, draft, and reconcile; `ltm` does discover, near-duplicate/supersession lookup via `query`, `validate`, and `propose` with provenance. Every output is a proposal. Repo ADRs are working memory and stay in their repo; org-level ADR collections adopt in place; hydration over an ADR may propose derived PolicyRules and Exceptions linked to the Decision via `related`. No ADR sync in v1.
- **Maintain:** `ltm doctor` on a schedule or by hand.

## Agent surface and distribution

- One TypeScript package on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.x). Contains core library, CLI, MCP server, JSON Schemas.
- Distribution: standalone binaries (Bun `--compile`; Node SEA fallback) on GitHub Releases, plus an npm wrapper package (esbuild/Biome per-platform pattern). No Node or TypeScript needed by consumers. qmd stays a separate optional Node install that `ltm` detects.
- Plugin: Claude-format at the repo root (`.claude-plugin/plugin.json`, `skills/`, `agents/`, `.mcp.json` running `ltm mcp`). VS Code Copilot auto-detects Claude-format plugins. The repo is also its own one-entry marketplace (`claude plugin marketplace add kendrick/long-term-memory-kit`, then install). Design core as harness-neutral (open SKILL.md format, AGENTS.md, MCP); other harnesses get thin adapters later.
- Skills: `hydrate` (one skill, phases as sections, every mechanical step an `ltm` call), `query-memory` (funnel with `ltm` when present, plain glob/grep/read otherwise), `promote`. Agent: `hydrator`. Each skill carries a `VENDORED-FROM` header and version line (MB-8) so downstream copies can compare. WMK-5 changes to vendoring one `hydrate` skill instead of six.
- Versioning: semver for `ltm`; `schema: N` on records changes only on a breaking schema change; each release declares which schema versions it reads; the `VENDORED-FROM` version is the `ltm` release version.

## Repo shape

```
src/                 core library, CLI, MCP server
schema/              record + memory-bank.yaml JSON Schemas
skills/ agents/      plugin content (open formats)
.claude-plugin/      plugin.json, marketplace.json
.mcp.json
templates/           what `ltm init` writes
fixtures/demo-bank/  the single shared fixture
docs/                why: retrieval model, design forces, per-type purpose and common mistakes, ADRs
guide/               practice: getting started, retrieval, hydration, promotion, formatters, evaluation
```

No persona pages. One package, one version, no monorepo tooling.

## Fixture

One synthesized, fictional org bank (no client content) under `fixtures/demo-bank/`: about 15 records across all four types, including superseded distractors, an Exception to a PolicyRule, and a drop-in MADR ADR; a small hydration source corpus (ADR folder, PR, transcript snippet); and a fictional consumer repo with a WMK decision log for promotion. It is the only fixture: unit tests, docs examples, the qmd bench, and agent evals all use it.

## Verification

Acceptance tests gate every PR, asserted in the consumer's units:

- Every stage-2 grep the docs show runs against the fixture and matches (MB-1).
- `ltm fmt` on a real Prettier- and oxfmt-reflowed copy yields the committed bytes; idempotent; body bytes unchanged (MB-9).
- `ltm query 'memory_type=Decision'` matches the documented grep on canonical files and still finds a file reflowed to block style (MB-9).
- `ltm head` ends at the closing fence of a 25-line block (MB-9).
- Removing `status` from a fixture record fails validation naming the file and key; block-style `tags` fails with a single-line-form error (MB-3).
- The JSON Schema validates the fixture under an independent validator (Python `jsonschema` in CI).
- Formatter fixture: with overrides on, Prettier and oxfmt leave frontmatter byte-identical; script exits non-zero otherwise (MB-10).
- `claude plugin validate` passes.
- The compiled binary runs on a machine with no Node.
- `ltm init --check` passes on the fixture and fails after a config edit.

Evals gate releases (run on tags or by hand), with results committed so each release has a number to beat (MB-7): a `qmd bench` fixture (≥10 queries, `expected_files`, `expected_in_top_k`) built from the demo bank; a 30–50 question agent-answer eval in LongMemEval's five styles (single-hop, multi-session, temporal, knowledge-update, abstention) scored on answer and files read; `claude plugin eval` cases for skill triggering and for agents using `ltm` rather than raw grep. `guide/evaluation.md` documents both evals and regeneration. v0.1's committed results are the baseline, measured before Stage 0 exists.

## Milestones

**Start with two timeboxed spikes:**

1. MCP TS SDK v2 server inside a `bun build --compile` binary (fallback: Node SEA).
2. Does Copilot CLI accept the Claude-format plugin? (Fallback: a root Agent Plugins 1.0 `plugin.json` alongside `.claude-plugin/`.)

**v1:** JSON Schemas, `memory-bank.yaml`, full CLI, `ltm mcp`, plugin (Claude Code + VS Code Copilot), GitHub adapters (validate Action, `accept` label Action, issue form), binaries on Releases + npm wrapper, demo-bank fixture, acceptance tests, docs and guide, first eval baseline. v1 builds the seams 1.1 needs: a recall interface with a lexical default and the reserved `recall:` key; a forge adapter interface with push-and-print fallback; `validate --format`.

**v1.1 (immediate next):** qmd recall backend (Stage 0, MB-4) with before/after bench numbers, plus qmd near-duplicate detection in `doctor`; GitLab and Azure DevOps forge adapters and CI templates.

**Later:** Homebrew, winget, Docker image, reusable GitHub Action; Copilot CLI manifest if spike 2 needs it; hosted remote MCP; ADR sync if an engagement needs it.

## Convergence plan mapping

| Item | Lands as |
| --- | --- |
| MB-1 | Canonical form, flat facets, compound `related`, no `uuid`, `schema: 1` |
| MB-2 | `summary` in the recommended tier |
| MB-3 | `ltm validate` + CI |
| MB-4 | Recall seam in v1; qmd Stage 0 in v1.1; Mechanism-4 server is our own `ltm mcp` |
| MB-5 | `last_confirmed`, `review_by`, explicit supersession with facet-overlap check |
| MB-6 | `ltm doctor` + `docs/` spec of each check |
| MB-7 | Eval format, bench fixture, agent-answer eval, release gating |
| MB-8 | `VENDORED-FROM` header and version line on skills |
| MB-9 | `ltm fmt`, `ltm query`, `ltm head` |
| MB-10 | `guide/formatters.md`, formatter fixture + check script, `init` writes overrides |
| MB-11 | Closed: the server filters status and facets itself |

## Downstream follow-ups (file in other repos later)

- working-memory-kit: WMK-5 vendors one `hydrate` skill; a promotion nudge in WMK skills; WMK docs state the mirror of the bright line.
- kendrick/skills: I2M-8 swaps `fm` for `ltm`; I2M-3 adopts this schema.
- memory-bank: freeze with a "superseded by" pointer at parity.

## Unverified facts

- Spike 1 and spike 2 above.
- qmd MCP and library parameter names came from a summarized README read; check against qmd source before coding to them.
- `claude plugin eval` case file schema not yet read.
