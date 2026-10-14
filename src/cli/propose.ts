import type { Command } from "./run.ts";

// Holds the slot until #13 lands; the lane that builds it replaces this file.
export const propose: Command = {
  name: "propose",
  summary: "Open a Proposal on a new ltm/propose branch for review",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm propose: not implemented yet (see #13)\n");
    return 1;
  },
};
