import { ConfigError, findBank, isMapping, loadConfig, MEMORY_TYPES, type MemoryType } from "../core/bank.ts";
import { isOrgWide, listRecords, parseFilter, selectRecords, type Filter, type QueryOptions } from "../core/query.ts";
import type { ParsedRecord } from "../core/record.ts";
import {
  noBankMessage,
  repoIdentity,
  resolveBankFlag,
  resolveBanks,
  type ResolvedBank,
  type ResolvedBy,
} from "../core/resolve.ts";
import { firstLine } from "../core/text.ts";
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

function line(r: ParsedRecord): string {
  const status = scalar(r.frontmatter.status);
  const title = scalar(r.frontmatter.title);
  return `${r.path}  ${r.memoryType}  ${status ?? ""}  ${title ?? ""}${status === "proposed" ? "  (proposal)" : ""}\n`;
}

const configErrorLine = (e: ConfigError): string =>
  `ltm query: ${e.path}${e.line === null ? "" : `:${e.line}`}: ${firstLine(e.message)}\n`;

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
  const results: { bank: string; record: ParsedRecord }[] = [];
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
      for (const r of selectRecords(records, { ...opts, facets })) results.push({ bank: bank.name, record: r });
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    ctx.err(configErrorLine(e));
    return 1;
  }
  if (ctx.values.json === true) {
    const out = {
      results: results.map(({ bank, record }) => ({ bank, ...row(record) })),
      notes,
      resolved_by: resolvedBy,
    };
    ctx.out(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  for (const note of notes) ctx.err(`ltm query: ${note}\n`);
  for (const { bank, record } of results) ctx.out(`${bank}:${line(record)}`);
  return 0;
}

export const query: Command = {
  name: "query",
  summary: "List Records by key=value filters, --type, --facet, --status, or --text",
  options: {
    json: { type: "boolean" },
    type: { type: "string" },
    facet: { type: "string", multiple: true },
    status: { type: "string", multiple: true },
    text: { type: "string" },
    all: { type: "boolean" },
    bank: { type: "string" },
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
    let root;
    try {
      root = findBank(ctx.cwd);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      ctx.err(`ltm query: ${e.path}: ${firstLine(e.message)}\n`);
      return 1;
    }
    if (root === null) return runResolved(ctx, opts);
    let records;
    try {
      const config = loadConfig(root);
      records = selectRecords(
        listRecords(config, (path, reason) => {
          ctx.err(`ltm query: skipped ${path}: ${reason}\n`);
        }),
        opts,
      );
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // A null line (unreadable file, non-mapping config) has no position to print.
      // yaml appends a multi-line code frame to its messages; the first line is the diagnosis.
      const message = firstLine(e.message);
      ctx.err(`${e.path}${e.line === null ? "" : `:${e.line}`}: ${message}\n`);
      return 1;
    }
    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(records.map(row), null, 2)}\n`);
      return 0;
    }
    for (const r of records) ctx.out(line(r));
    return 0;
  },
};
