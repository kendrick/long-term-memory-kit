import { ConfigError, findBank, loadConfig } from "../core/bank.ts";
import { listRecords, matches, parseFilter, type Filter } from "../core/query.ts";
import type { Command } from "./run.ts";

const scalar = (v: unknown): string | number | boolean | null =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;

export const query: Command = {
  name: "query",
  summary: "List Records matching key=value filters (ANDed)",
  options: { json: { type: "boolean" } },
  positionals: [{ name: "filter", required: false, variadic: true }],
  // Exit 2 has to come before run() so a malformed filter never reads the Bank.
  checkArgs(positionals) {
    const bad = positionals.find((a) => parseFilter(a) === null);
    return bad === undefined ? undefined : `invalid filter '${bad}' (expected key=value)`;
  },
  async run(ctx) {
    const root = findBank(ctx.cwd);
    if (root === null) {
      ctx.err(`ltm query: no memory-bank.yaml in ${ctx.cwd} or any parent directory\n`);
      return 1;
    }
    let config;
    try {
      config = loadConfig(root);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // A null line (unreadable file, non-mapping config) has no position to print.
      ctx.err(`${e.path}${e.line === null ? "" : `:${e.line}`}: ${e.message}\n`);
      return 1;
    }
    const filters = ctx.positionals.map((a) => parseFilter(a) as Filter);
    const records = listRecords(config, (path, reason) => {
      ctx.err(`ltm query: skipped ${path}: ${reason}\n`);
    }).filter((r) => matches(r, filters));

    if (ctx.values.json === true) {
      const rows = records.map((r) => ({
        path: r.path,
        id: scalar(r.frontmatter.id),
        memory_type: r.memoryType,
        status: scalar(r.frontmatter.status),
        title: scalar(r.frontmatter.title),
        summary: scalar(r.frontmatter.summary),
        frontmatter: r.frontmatter,
      }));
      ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const r of records) {
      const status = scalar(r.frontmatter.status);
      const title = scalar(r.frontmatter.title);
      ctx.out(`${r.path}  ${r.memoryType}  ${status ?? ""}  ${title ?? ""}\n`);
    }
    return 0;
  },
};
