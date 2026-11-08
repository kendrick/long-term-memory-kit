import { join } from "node:path";
import { ConfigError, isMapping, MEMORY_TYPES, type BankConfig, type MemoryType } from "../core/bank.ts";
import { loadRecall, qmdBackend, type QmdBackend, type Recall } from "../core/qmd.ts";
import { qmdVectorBackend } from "../core/qmd-vector.ts";
import { tokenize } from "../core/recall.ts";
import { rankStage0, type RankedBy } from "../core/stage0.ts";
import { isOrgWide, listRecords, orgWideMode, parseFilter, selectRecords, type Filter, type QueryOptions } from "../core/query.ts";
import type { ParsedRecord } from "../core/record.ts";
import {
  noBankMessage,
  repoIdentity,
  resolveBankFlag,
  resolveBanks,
  type ResolvedBank,
  type ResolvedBy,
} from "../core/resolve.ts";
import { configErrorLine, loadBankAt, locateBank } from "./bank.ts";
import type { Command, CommandContext } from "./run.ts";

const scalar = (v: unknown): string | number | boolean | null =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;

const row = (r: ParsedRecord) => ({
  path: r.path,
  id: scalar(r.frontmatter.id),
  memory_type: r.memoryType,
  status: scalar(r.frontmatter.status),
  title: scalar(r.frontmatter.title),
  summary: scalar(r.frontmatter.summary),
  is_proposal: r.frontmatter.status === "proposed",
  frontmatter: r.frontmatter,
});

type Row = ReturnType<typeof row> & { score?: number; ranked_by?: RankedBy };

export function formatRow(r: Row): string {
  return `${r.path}  ${r.memory_type}  ${r.status ?? ""}  ${r.title ?? ""}${r.is_proposal ? "  (proposal)" : ""}\n`;
}

export function loadQueryMinScore(config: BankConfig, recall: Recall): number | undefined | { error: string } {
  const raw = config.raw.query;
  if (raw !== undefined && !isMapping(raw)) return { error: "query is not a mapping" };
  for (const key of Object.keys(raw ?? {})) {
    if (key !== "min_score" && key !== "org_wide") return { error: `query.${key}: unknown key` };
  }
  const v = raw?.min_score;
  if (v === undefined) {
    // Vector scores have no scale a default could sit on, as with doctor's threshold (ADR 0004).
    return recall.mode === "vector" ? { error: "query.min_score is required when recall.mode is vector" } : undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < -1 || v > 1) {
    return { error: "query.min_score must be a number from -1 to 1" };
  }
  return v;
}

// Stage 0 needs `--text` with a token: an empty token list gets no qmd hits, while lexical
// keeps every Record, so `--text ""` stays today's unfiltered list. recall: and query: are
// read only then, except query.org_wide, which any Facet query reads. Either way a malformed
// block never breaks a query that couldn't use it.
// Returns the rows, or 1 after printing a config error.
function selectForBank(
  ctx: CommandContext,
  config: BankConfig,
  records: ParsedRecord[],
  opts: QueryOptions,
  notes: string[],
  // Bare in-Bank (one file, obvious); the real path when several Banks are in play.
  cfgLabel: string,
): Row[] | 1 {
  if (opts.facets.length > 0) {
    const orgWide = orgWideMode(config);
    if (typeof orgWide === "object") {
      ctx.err(`ltm query: ${cfgLabel}: ${orgWide.error}\n`);
      return 1;
    }
    opts = { ...opts, orgWide };
  }
  const text = opts.text;
  if (text === undefined || tokenize(text).length === 0) return selectRecords(records, opts).map(row);
  const recall = loadRecall(config);
  if (recall === null) return selectRecords(records, opts).map(row);
  if ("error" in recall) {
    ctx.err(`ltm query: ${cfgLabel}: ${recall.error}\n`);
    return 1;
  }
  const minScore = loadQueryMinScore(config, recall);
  if (typeof minScore === "object") {
    ctx.err(`ltm query: ${cfgLabel}: ${minScore.error}\n`);
    return 1;
  }
  const warn = (line: string) => notes.push(`qmd: ${line}`);
  const backend: QmdBackend =
    recall.mode === "vector" ? qmdVectorBackend(recall, config.root, ctx.env, warn) : qmdBackend(recall, config.root, ctx.env, warn);
  const kept = selectRecords(records, { ...opts, text: undefined });
  return rankStage0(kept, text, backend, recall.mode, minScore, config.root, notes).map((r) => ({
    ...row(r.record),
    score: r.score,
    ranked_by: r.rankedBy,
  }));
}

// The Consumer repo's own Facets, from this Bank's `consumers` map. null means the Bank
// has no entry for the repo, or there's no origin to look one up by.
function consumerFacets(bank: ResolvedBank, key: string | null): string[] | null {
  if (key === null) return null;
  const consumers = bank.config.raw.consumers;
  if (!isMapping(consumers) || !Object.hasOwn(consumers, key)) return null;
  const v = consumers[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

// Outside a Bank, or with --bank: query every resolved Bank on its own and concatenate
// in resolution order, so --text ranking stays per Bank and Bank order wins.
function runResolved(ctx: CommandContext, opts: QueryOptions): 0 | 1 {
  const flag = ctx.values.bank;
  let banks: ResolvedBank[];
  let resolvedBy: ResolvedBy;
  const notes: string[] = [];
  const results: ({ bank: string } & Row)[] = [];
  try {
    if (typeof flag === "string") {
      banks = [resolveBankFlag(flag, ctx.cwd, ctx.env)];
      resolvedBy = "flag";
    } else {
      const res = resolveBanks(ctx.cwd, ctx.env);
      if (res.resolvedBy === null || res.banks.length === 0) {
        ctx.err(`ltm query: ${noBankMessage(res.checked)}\n`);
        return 1;
      }
      banks = res.banks;
      resolvedBy = res.resolvedBy;
    }
    // A user's --facet is an explicit scope, so it overrides every Bank's mapping and
    // the not-mapped note would be noise.
    const remote = opts.facets.length > 0 ? null : repoIdentity(ctx.cwd).remote;
    const key = remote === null ? null : `${remote.org}/${remote.repo}`;
    for (const bank of banks) {
      let records = listRecords(bank.config, (path, reason) => {
        ctx.err(`ltm query: skipped ${path}: ${reason}\n`);
      });
      let facets = opts.facets;
      if (facets.length === 0) {
        const mapped = consumerFacets(bank, key);
        if (mapped === null) {
          notes.push(
            key === null
              ? `no git origin here; showing org-wide Records only from Bank "${bank.name}"`
              : `${key} is not mapped in Bank "${bank.name}"; showing org-wide Records only`,
          );
        }
        // selectRecords reads empty facets as "no Facet filter", which would hand an
        // unmapped repo (or one mapped to []) every Record in the Bank.
        if (mapped === null || mapped.length === 0) records = records.filter(isOrgWide);
        else facets = mapped;
      }
      const bankNotes: string[] = [];
      const rows = selectForBank(ctx, bank.config, records, { ...opts, facets }, bankNotes, join(bank.config.root, "memory-bank.yaml"));
      if (rows === 1) return 1;
      for (const note of bankNotes) notes.push(`Bank "${bank.name}": ${note}`);
      for (const r of rows) results.push({ bank: bank.name, ...r });
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    ctx.err(configErrorLine("query", e));
    return 1;
  }
  if (ctx.values.json === true) {
    const out = {
      results,
      notes,
      resolved_by: resolvedBy,
    };
    ctx.out(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  for (const note of notes) ctx.err(`ltm query: ${note}\n`);
  for (const r of results) ctx.out(`${r.bank}:${formatRow(r)}`);
  return 0;
}

export const query: Command = {
  name: "query",
  summary: "List Records by key=value filters, --type, --facet, --status, or --text",
  options: {
    json: { type: "boolean", description: "Print each result's full frontmatter as JSON" },
    type: { type: "string", description: "Only Records of this memory type" },
    facet: { type: "string", multiple: true, description: "Only Records that apply to this Facet; repeat to match any of several Facets. key=value filters must all match" },
    status: { type: "string", multiple: true, description: "Only Records with this status, which may be a retired one" },
    text: { type: "string", description: "Rank results by matches in title and summary, or through recall: when the Bank sets it" },
    all: { type: "boolean", description: "Include Retired Records" },
    bank: { type: "string", description: "Bank name from your user config, or path to a Bank" },
  },
  positionals: [{ name: "filter", required: false, variadic: true }],
  // Exit 2 has to come before run() so a malformed filter never reads the Bank.
  checkArgs(positionals, values) {
    const bad = positionals.find((a) => parseFilter(a) === null);
    if (bad !== undefined) return `invalid filter '${bad}' (expected key=value)`;
    const type = values.type;
    if (typeof type === "string" && !(MEMORY_TYPES as readonly string[]).includes(type)) {
      return `unknown memory type '${type}' (expected Decision, PolicyRule, Exception, or Context)`;
    }
    const badFacet = ((values.facet ?? []) as unknown as string[]).find(
      (f) => f.indexOf(":") <= 0 || f.indexOf(":") === f.length - 1,
    );
    return badFacet === undefined ? undefined : `invalid facet '${badFacet}' (expected prefix:value)`;
  },
  async run(ctx) {
    // checkArgs already rejected anything parseFilter refuses; the guard only narrows the type.
    const filters = ctx.positionals
      .map((a) => parseFilter(a))
      .filter((f): f is Filter => f !== null);
    // multiple: true arrives as string[]; run.ts types every value as a scalar.
    const many = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
    const opts: QueryOptions = {
      filters,
      type: typeof ctx.values.type === "string" ? (ctx.values.type as MemoryType) : undefined,
      statuses: many(ctx.values.status),
      facets: many(ctx.values.facet),
      text: typeof ctx.values.text === "string" ? ctx.values.text : undefined,
      all: ctx.values.all === true,
    };
    if (typeof ctx.values.bank === "string") return runResolved(ctx, opts);
    const root = locateBank(ctx, "query");
    if (root === 1) return 1;
    if (root === null) return runResolved(ctx, opts);
    const config = loadBankAt(ctx, "query", root);
    if (config === 1) return 1;
    const notes: string[] = [];
    const rows = selectForBank(
      ctx,
      config,
      listRecords(config, (path, reason) => {
        ctx.err(`ltm query: skipped ${path}: ${reason}\n`);
      }),
      opts,
      notes,
      "memory-bank.yaml",
    );
    if (rows === 1) return 1;
    // A bare JSON array has no notes key, so in-Bank notes always go to stderr.
    for (const note of notes) ctx.err(`ltm query: ${note}\n`);
    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const r of rows) ctx.out(formatRow(r));
    return 0;
  },
};
