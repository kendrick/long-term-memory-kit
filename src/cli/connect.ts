import type { Command } from "./run.ts";

// Holds the slot until #17 lands; the lane that builds it replaces this file.
export const connect: Command = {
  name: "connect",
  summary: "Print a Markdown snippet that points a Consumer repo's agents at its Banks",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm connect: not implemented yet (see #17)\n");
    return 1;
  },
};
