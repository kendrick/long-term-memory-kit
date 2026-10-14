import type { Command } from "./run.ts";

// Holds the slot until #11 lands; the lane that builds it replaces this file.
export const accept: Command = {
  name: "accept",
  summary: "Accept a Proposal, stamping its dates and making its Supersessions",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm accept: not implemented yet (see #11)\n");
    return 1;
  },
};
