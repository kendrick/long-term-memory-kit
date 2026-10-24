import type { Command } from "./run.ts";

// Holds the slot until #14 lands; the lane that builds it replaces this file.
export const promote: Command = {
  name: "promote",
  summary: "Promote a repo ADR or decision-log entry to a Bank Proposal",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm promote: not implemented yet (see #14)\n");
    return 1;
  },
};
