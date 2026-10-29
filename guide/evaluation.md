# Evaluating ltm

Three evals check this kit before a release. The retrieval bench asks whether `ltm query --text` finds the right Records in the demo Bank, and it gates every release. The plugin eval asks whether Claude picks up the `ltm` plugin's skills and tools when it should. The agent-answer eval asks whether Claude, with the plugin loaded, answers questions from the Bank and cites the Records it used. The plugin eval and the agent-answer eval only report. Results for each version are committed under `evals/results/<version>/`.

## The Retrieval Bench

The bench lives in [`evals/bench/demo-bank.bench.json`](../evals/bench/demo-bank.bench.json). It holds 11 queries over [`fixtures/demo-bank/`](../fixtures/demo-bank/), each naming the Records that should come back. The queries cover exact titles, words that appear only in a summary, answers that are Exceptions, a multi-word query that should match two Records, a query that should return nothing, and the retired-status filter.

[`scripts/eval-bench.ts`](../scripts/eval-bench.ts) runs each query through `ltm query --text <query> --json --bank fixtures/demo-bank`. It runs them from a temp copy of [`fixtures/consumer-repo/`](../fixtures/consumer-repo/) whose git origin is `https://github.com/acme/order-service.git`. The demo Bank's `consumers:` list maps that repo to the `service:order-service` and `domain:commerce` Facets. From any other directory, `ltm query` shows only org-wide Records, and none of the bench queries would find anything.

A query hits when every path in its `expected_files` is among the first `expected_in_top_k` results and no path in its `ltm_forbidden_files` is. A query with an empty `expected_files` hits only when ltm returns zero results, so a query with no answer can't pass by default. Paths are compared as exact strings.

The `superseded-mysql-hidden` query is the one that tests the retired-status filter. It searches for `Postgres` and forbids `_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md`, the MySQL Decision that the Postgres Decision superseded. Its `expected_in_top_k` is 3, because `--all` puts the MySQL Decision third. Run the bench with `--all` and two queries miss. `superseded-mysql-hidden` misses because the forbidden MySQL Decision shows up in the top 3. `alias-mysql-finds-postgres` has an `expected_in_top_k` of 1 and misses because MySQL ranks first. The hit rate drops from 1 to 9/11. A change that stopped ltm hiding retired Records would cost the bench the same two queries.

The runner writes `evals/results/<version>/bench.json`:

```json
{
  "version": "0.0.0",
  "hit_rate": 1,
  "hits": 11,
  "total": 11,
  "queries": [
    {
      "id": "exact-title-trunk",
      "hit": true,
      "top": ["_memory/decisions/trunk-based-deployment-rX6jK1fWc9.md"]
    }
  ]
}
```

Each query gets one entry, and `top` lists every path ltm returned, in order. The file has no timestamps, so two runs over the same tree produce the same bytes.

### Run the Bench

From the repo root, run:

```sh
bun scripts/eval-bench.ts
```

The runner takes these flags:

| Flag | Default | Effect |
| :- | :- | :- |
| `--ltm <cmd>` | `bun src/cli/bin.ts` | The ltm command to run, such as a built binary |
| `--version <v>` | `version` in `package.json` | The version written into the result and its directory |
| `--out <path>` | `evals/results/<version>/bench.json` | Where the result goes |
| `--all` | off | Passes `--all` to every query, so retired Records come back too |

To regenerate the committed baseline, run the bench with no flags and check that git shows no change:

```sh
bun scripts/eval-bench.ts
git diff --exit-code evals/results/
```

A diff means retrieval changed. Commit the new file only if the change is one you meant to make.

## The Release Gate

The `bench-gate` job in [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on every event the workflow handles: tag pushes, pull requests, and manual dispatches. It downloads the linux binary from the `build` job and runs the bench with it. The version comes from the tag name without its `v` on a push, and from `package.json` otherwise. The job then passes the result to [`scripts/eval-gate.ts`](../scripts/eval-gate.ts). The `npm` job needs `bench-gate`, and the GitHub Release job needs `npm`, so a failed gate stops the release.

The gate compares the new `hit_rate` with the one in the newest `bench.json` committed under `evals/results/` whose version sorts at or below the input's by semver. Counting the input's own version means a dry run at the committed version meets its own committed result. The gate fails when the new rate is lower, and passes when it's equal or higher. With no such result, it passes and prints that it found no baseline, along with the input rate. Otherwise it prints both rates.

Committing a higher result raises the rate every later release has to meet. With a 0.0.0 baseline of 0.8, a 0.1.0 run passes at 0.8, fails at 0.7, and passes at 0.9. Once that 0.9 result is committed as `evals/results/0.1.0/bench.json`, a 0.2.0 run at 0.8 fails. [`test/scripts/eval-gate.test.ts`](../test/scripts/eval-gate.test.ts) checks each of those cases against real temp result directories.

The gate reads `bench.json` only. A `plugin-eval.json` beside it never changes the outcome, however low its score.

To try the gate locally, pass it a bench result:

```sh
bun scripts/eval-gate.ts evals/results/0.0.0/bench.json
```

`--results <dir>` points it at a different results directory.

## The Plugin Eval

The plugin eval runs Claude with and without the `ltm` plugin over the seven cases in [`evals/plugin/`](../evals/plugin/), using [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals.md). Each case runs once per arm.

| Case | Checks that |
| :- | :- |
| `query-memory-triggers` | "What's our policy on cross-service DB reads?" fires the `query-memory` skill |
| `hydrate-triggers` | "Turn these ADRs into proposals." fires the `hydrate` skill |
| `promote-triggers` | "This decision should apply to every service." fires the `promote` skill |
| `query-memory-ignores-unrelated` | A request for a TypeScript function doesn't fire `query-memory` |
| `hydrate-ignores-unrelated` | A question about git merge and rebase doesn't fire `hydrate` |
| `promote-ignores-unrelated` | A question about HTTP 418 doesn't fire `promote` |
| `uses-ltm-not-grep` | Asked about cross-service DB reads with Grep allowed, Claude calls ltm or its MCP tools and never greps `_memory` |

### Run the Plugin Eval

You need the Claude Code CLI, 2.1.311 in the baseline run, logged in with the credentials your normal sessions use. From the repo root, run:

```sh
bun scripts/eval-plugin.ts
```

[`scripts/eval-plugin.ts`](../scripts/eval-plugin.ts) copies the demo Bank to a temp directory and puts an `ltm` shim first on `PATH`. The shim points ltm at that copy, and it wraps the `ltm` already on your `PATH`, or `bun src/cli/bin.ts` when there isn't one. The script then runs `claude plugin eval` on the repo root with `--trust-plugin`, `--no-publish`, `--allow-real-servers`, `--max-cost-usd 15`, and grants for `Bash(ltm *)` and the plugin's MCP tools. It writes the result to `evals/results/<version>/plugin-eval.json` and keeps claude's own results directory in the temp directory. Before saving, the script rewrites local paths in the result to `.` for the repo and its worktrees, `<tmp>` for temp directories, and `~` for your home directory, so committed results carry no machine paths.

`--version <v>` sets the version directory. The script passes every other argument through to `claude plugin eval`, so you can run a single case:

```sh
bun scripts/eval-plugin.ts --case promote-triggers
```

The script exits with claude's exit code. Exit 1 may mean nothing worse than a case scoring below claude's default threshold of 1.0, so read stderr before you treat it as a load error. To regenerate the committed result, run the script with no arguments and commit `evals/results/<version>/plugin-eval.json`. Expect it to differ from the last run, since model output varies between runs.

### How the Eval Reaches the MCP Server

The eval runs the plugin's real MCP server against the demo Bank copy, and `evals/mocks/` doesn't exist. Two limits shaped how the Bank reaches that server:

- A case's `env` keys must match `EVAL_[A-Z0-9_]*`, so a case can't set `LTM_BANK_PATH` or `LTM_CONFIG`.
- [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) sets the server's `LTM_BANK_PATH` from `${user_config.bank_path}`, which is empty in an eval.

The shim solves both by setting `LTM_CONFIG` to a temp config whose `default:` names the Bank copy. The script passes `--allow-real-servers` because claude's default `--mocks record` mode doesn't start a plugin server that has no mock.

### Cost and the Baseline

The 0.0.0 baseline ran 14 agent runs, seven cases with and without the plugin, on CLI 2.1.311. It took 241 seconds and cost $1.47 at list price (`costUsd` 1.4677672 in [`evals/results/0.0.0/plugin-eval.json`](../evals/results/0.0.0/plugin-eval.json)). Six of seven cases passed. `promote-triggers` failed in both arms, because the case's working directory holds no decision. The trace shows the agent replying "I'm not sure which decision you mean" and asking, so `promote` never fired. A fix would give the case a decision to promote, for example through a scaffold, and then re-run the eval. Expect a similar cost per full run while cases keep `runs: 1`. Every `llm` grader adds three judge calls per run, and the current cases have none.

### In the Release Workflow

The `plugin-eval` job in [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on tag pushes only, so pull requests and manual dispatches never bill model calls. It needs the `ANTHROPIC_API_KEY` secret. When that secret is empty, the job prints a notice and skips the eval instead of failing. The job installs CLI 2.1.311, puts the linux binary on `PATH` as `ltm`, and runs `bun scripts/eval-plugin.ts --version <tag without v>`. It has `continue-on-error: true` and no other job needs it, so its result never blocks a release.

## The Agent-Answer Eval

The agent-answer eval asks whether Claude, working in a Consumer repo with the `ltm` plugin loaded, gets the right answer from the Bank and cites the Records it used. It runs the 35 questions in [`evals/agent-answer/questions.json`](../evals/agent-answer/questions.json), seven in each of LongMemEval's five styles: single-hop, multi-session, temporal, knowledge-update, and abstention. Every question is asked from a copy of [`fixtures/consumer-repo/`](../fixtures/consumer-repo/), the order-service Consumer repo, against the demo Bank.

Each question names the Records that answer it in `gold_ids` and the ones that must not appear in `forbidden_ids`. A knowledge-update question forbids the superseded Record. A temporal question states its reference date in the question text. One dated after an Exception's `effective_to` forbids that Exception, because the Exception grants nothing once it expires. An abstention question has no gold Records, because the Bank holds no answer.

The agent ends its reply with a `CITED:` line listing the Record ids it relied on, or `CITED: NONE`. The runner reads the last such line from the transcript and scores it without looking at the prose. An answer is correct when it cites every `gold_ids` entry and no `forbidden_ids` entry. An abstention answer is correct when it cites nothing. A reply with no `CITED:` line scores as wrong.

File recall is a second score. It is the share of a question's `gold_files` that entered the agent's context. A file counts as read through any of these calls:

- `Read` on the file
- the MCP `head` tool, by `path` or by `id`
- the MCP `query` tool, for every path in its results
- `cat`, `head`, or `ltm head` on the file in Bash
- `ltm query --json` in Bash, for every path in its results

The runner splits a Bash command at `&&` and `;` and checks each part. A `cd` in an earlier part sets the directory for relative paths after it, so `cd <bank-root> && ltm head <path>` counts. A `grep` that printed only paths doesn't count, and neither does a tool call that returned an error.

### Run the Agent-Answer Eval

You need the Claude Code CLI, 2.1.311 in the baseline run. From the repo root, run:

```sh
bun scripts/eval-agent-answer.ts
```

The runner takes these flags:

| Flag | Default | Effect |
| :- | :- | :- |
| `--limit <n>` | all 35 | Runs only the first `n` questions and marks the result `partial` |
| `--version <v>` | `version` in `package.json` | The version written into the result and its directory |
| `--out <path>` | `evals/results/<version>/agent-answer.json` | Where the result goes |
| `--transcripts <dir>` | off | Saves each run's raw stream-json as `<id>.jsonl` |

Raw transcripts hold absolute temp paths, so point `--transcripts` at a scratch directory and scrub any transcript before you commit it as a fixture.

Every run uses an empty temp `CLAUDE_CONFIG_DIR`, which can't use the keychain login of your normal sessions. Set `ANTHROPIC_API_KEY`, or set `CLAUDE_CODE_OAUTH_TOKEN` to a token from `claude setup-token`. Without one of them the runner prints why and exits before any paid call.

### What the Probe Checks

Before it scores anything, the runner makes one probe run on the first question and inspects the init event. The eval stops with exit code 2 unless all of these hold:

- The plugin `ltm` is loaded with no plugin errors.
- The only MCP server is `plugin:ltm:ltm`.
- No memory files are loaded.
- No other plugin is loaded, apart from the three with `path: "builtin"` that Claude Code 2.1.311 always loads: `cc-plugin-agents-md`, `cc-plugin-telemetry`, and `cc-plugin-plugin-authoring`. The probe allows those by name.

The runner doesn't pass `--strict-mcp-config` or `--bare`. Both drop a `--plugin-dir` plugin's own MCP server, so the agent would lose the tools the eval exists to test. The empty temp `CLAUDE_CONFIG_DIR` already leaves `plugin:ltm:ltm` as the only server.

### Cost

A full run is 35 headless runs plus the probe. The baseline cost $0.93 at list price: $0.89 for the questions and $0.04 for the probe. The runner caps each run at $0.50 and stops starting new questions once the total passes $15, marking the result `stopped_for_budget` and `partial`. A run that ends without a result event, because it crashed or was killed, never reports its cost. The runner counts it as the full $0.50 toward the $15 limit and prints a warning that names the question.

### Read the Results

The runner writes `evals/results/<version>/agent-answer.json`. Unlike `bench.json`, it holds timestamps, so two runs never produce the same bytes. Its top-level fields are:

| Field | Holds |
| :- | :- |
| `version`, `model`, `claude_code_version` | What was measured and with what |
| `isolation` | The environment settings the runs used |
| `started_at`, `finished_at` | Run times |
| `partial`, `limit`, `stopped_for_budget` | Whether fewer than 35 questions ran, and why. `limit` appears only with `--limit`. |
| `probe_cost_usd`, `total_cost_usd`, `cost_unknown_runs` | Probe cost, the summed cost of the scored runs whose cost is known, and the number of scored runs whose cost is unknown |
| `by_style`, `overall` | `n`, `correct`, `accuracy`, and `file_recall` per style and in total |
| `questions` | One entry per question: `id`, `style`, `correct`, `answer`, `cited`, `file_recall`, `cost_usd`, `plugin_loaded`, and `files_read` |

`answer` is the reply without its `CITED:` line. `cited` is `null` when the reply had no `CITED:` line and `[]` for `CITED: NONE`. `file_recall` is `null` for abstention questions, which have no gold files, and the aggregate averages only the questions that have gold files. `cost_usd` is `null` for a run that ended without a result event, because its cost is unknown. `total_cost_usd` leaves those runs out. `plugin_loaded` is false when a run's init event shows a plugin problem.

The 0.0.0 baseline ran on `claude-sonnet-5-5` and CLI 2.1.311. It answered 22 of 35 questions correctly (63%), with 91% file recall.

| Style | Correct | File recall |
| :- | :- | :- |
| single-hop | 5/7 | 86% |
| multi-session | 5/7 | 93% |
| temporal | 5/7 | 86% |
| knowledge-update | 0/7 | 100% |
| abstention | 7/7 | n/a |

The knowledge-update score is the one to read closely. In all seven answers the agent found the current Record and cited the superseded one beside it, which the scorer counts as wrong. The two temporal questions dated after Exception `wJ3nC7hTy4` expired on 2027-03-31 scored wrong the same way. Both answers said the Exception had lapsed, then cited it beside the PolicyRule. Two single-hop answers cited nothing. In `sh-fulfillment-term` the right Record was in the query results, which counts toward file recall, but the answer said the agent saw only the Record's summary and not its body. In `sh-billing-db-read` the agent said all three of its queries returned no Records, so it read no files and scored 0 file recall. Model output varies between runs, so treat a single run as a rough reading.

### In the Release Workflow

`release.yml` doesn't run the agent-answer eval, since it needs a paid job and a secret the workflow doesn't have. Run it by hand before or after you tag a release, with the auth that [Run the Agent-Answer Eval](#run-the-agent-answer-eval) names, and commit the result as `evals/results/<version>/agent-answer.json`. The eval reports and never gates. Nothing compares its result with an earlier one, and a low score never stops a release. Gating waits until two releases have each committed a result, so there is a measured spread to set a threshold against.

## Format Findings

The bench borrows qmd's fixture format, and the plugin cases use the format `claude plugin eval` defines.

### qmd's Bench Format

The bench file follows the fixture format of qmd's bench, read from tobi/qmd at commit `86d2365d17fc682e491c2c53d1e4a884aee8682a`:

- [`src/bench/types.ts`](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/bench/types.ts#L9-L33) types the file. The top level has `description` (string), `version` (number), an optional `collection` (string), and `queries`. Each query has `id`, `query`, `type`, `description`, `expected_files` (string array), and `expected_in_top_k` (number). `type` is one of `exact`, `semantic`, `topical`, `cross-domain`, or `alias`, and qmd uses it only to group results.
- [`src/bench/bench.ts`](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/bench/bench.ts#L337-L342) checks only that `queries` is an array, so qmd ignores this bench's extra `ltm_forbidden_files` field.
- [`src/bench/score.ts`](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/bench/score.ts#L12-L32) treats two paths as a match when they're equal after lowercasing or when one ends with the other. This bench compares exact strings instead, which is stricter and enough for the Bank-relative paths `ltm query --json` prints.

### The `claude plugin eval` Case Format

The cases follow [Test plugins with evals](https://code.claude.com/docs/en/plugin-evals.md), checked against `claude plugin eval --help` on CLI 2.1.311:

- A case is a directory under `evals/` holding a `prompt.md`, a `case.yaml`, or both, and at least one grader. Discovery is recursive, and the eval directory is `evals/` at the plugin root. The plugin root here is the repo root, where `.claude-plugin/plugin.json` sits.
- `prompt.md` has YAML frontmatter and the prompt as its body. The frontmatter fields are `schema_version`, `name`, `description`, `tags`, `plugins`, `runs`, `expected_outcome`, `model`, `max_turns`, `timeout_seconds`, `allowed_tools`, `append_system_prompt`, and `env`. An unknown key is an error, and `env` keys must match `EVAL_[A-Z0-9_]*`.
- Each `graders/<name>.md` file is one grader. Its frontmatter takes `type`, an optional `weight`, an optional `arm` (`with-only` or `both`), and the options for its type. The types are `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, and `baseline`.
- No validate-only mode exists, so a case that fails to load shows up only in a real run, and every run calls the model.
