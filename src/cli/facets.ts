import { openBank } from "./bank.ts";
import { countFacets, listRecords } from "../core/query.ts";
import type { Command } from "./run.ts";

export const facets: Command = {
  name: "facets",
  summary: "List every Facet in applies_to with its Record count",
  options: {
    all: { type: "boolean", description: "Count Retired Records too" },
    json: { type: "boolean", description: "Print the counts as JSON" },
  },
  async run(ctx) {
    const config = openBank(ctx, "facets");
    if (config === 1) return 1;
    const records = listRecords(config, (path, reason) => {
      ctx.err(`ltm facets: skipped ${path}: ${reason}\n`);
    });
    const rows = countFacets(records, ctx.values.all === true);
    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const r of rows) ctx.out(`${r.facet}  ${r.count}\n`);
    return 0;
  },
};
