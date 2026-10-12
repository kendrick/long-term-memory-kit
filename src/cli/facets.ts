import { ConfigError, findBank, loadConfig } from "../core/bank.ts";
import { countFacets, listRecords } from "../core/query.ts";
import type { Command } from "./run.ts";

export const facets: Command = {
  name: "facets",
  summary: "List every Facet in applies_to with its Record count",
  options: { all: { type: "boolean" }, json: { type: "boolean" } },
  async run(ctx) {
    let root;
    try {
      root = findBank(ctx.cwd);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      ctx.err(`ltm facets: ${e.path}: ${e.message}\n`);
      return 1;
    }
    if (root === null) {
      ctx.err(`ltm facets: no memory-bank.yaml in ${ctx.cwd} or any parent directory\n`);
      return 1;
    }
    let rows;
    try {
      const records = listRecords(loadConfig(root), (path, reason) => {
        ctx.err(`ltm facets: skipped ${path}: ${reason}\n`);
      });
      rows = countFacets(records, ctx.values.all === true);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // yaml appends a multi-line code frame to its messages; the first line is the diagnosis.
      const message = e.message.split("\n")[0];
      ctx.err(`${e.path}${e.line === null ? "" : `:${e.line}`}: ${message}\n`);
      return 1;
    }
    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const r of rows) ctx.out(`${r.facet}  ${r.count}\n`);
    return 0;
  },
};
