import type { Command } from "./run.ts";

// Holds the slot until #7 lands; the lane that builds it replaces this file.
export const facets: Command = {
  name: "facets",
  summary: "List every Facet in applies_to with its Record count",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm facets: not implemented yet (see #7)\n");
    return 1;
  },
};
