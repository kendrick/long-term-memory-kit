import type { Command } from "./run.ts";

// Holds the slot until #18 lands; the lane that builds it replaces this file.
export const discover: Command = {
  name: "discover",
  summary: "List Hydration source files under the given paths, with their kind and citations",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm discover: not implemented yet (see #18)\n");
    return 1;
  },
};
