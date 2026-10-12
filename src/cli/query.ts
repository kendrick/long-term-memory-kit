import { ConfigError, findBank, loadConfig, MEMORY_TYPES, type MemoryType } from "../core/bank.ts";
import { listRecords, parseFilter, selectRecords, type Filter } from "../core/query.ts";
import type { Command } from "./run.ts";

const scalar = (v: unknown): string | number | boolean | null =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;

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
    let root;
    try {
      root = findBank(ctx.cwd);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      ctx.err(`ltm query: ${e.path}: ${e.message.split("\n")[0]}\n`);
      return 1;
    }
    if (root === null) {
      ctx.err(`ltm query: no memory-bank.yaml in ${ctx.cwd} or any parent directory\n`);
      return 1;
    }
    let records;
    try {
      const config = loadConfig(root);
      records = selectRecords(
        listRecords(config, (path, reason) => {
          ctx.err(`ltm query: skipped ${path}: ${reason}\n`);
        }),
        {
          filters,
          type: typeof ctx.values.type === "string" ? (ctx.values.type as MemoryType) : undefined,
          statuses: many(ctx.values.status),
          facets: many(ctx.values.facet),
          text: typeof ctx.values.text === "string" ? ctx.values.text : undefined,
          all: ctx.values.all === true,
        },
      );
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // A null line (unreadable file, non-mapping config) has no position to print.
      // yaml appends a multi-line code frame to its messages; the first line is the diagnosis.
      const message = e.message.split("\n")[0];
      ctx.err(`${e.path}${e.line === null ? "" : `:${e.line}`}: ${message}\n`);
      return 1;
    }
    if (ctx.values.json === true) {
      const rows = records.map((r) => ({
        path: r.path,
        id: scalar(r.frontmatter.id),
        memory_type: r.memoryType,
        status: scalar(r.frontmatter.status),
        title: scalar(r.frontmatter.title),
        summary: scalar(r.frontmatter.summary),
        is_proposal: r.frontmatter.status === "proposed",
        frontmatter: r.frontmatter,
      }));
      ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const r of records) {
      const status = scalar(r.frontmatter.status);
      const title = scalar(r.frontmatter.title);
      ctx.out(`${r.path}  ${r.memoryType}  ${status ?? ""}  ${title ?? ""}${status === "proposed" ? "  (proposal)" : ""}\n`);
    }
    return 0;
  },
};
