import type { Command } from "./run.ts";

// Holds the slot until #12 lands; the lane that builds it replaces this file.
export const doctor: Command = {
  name: "doctor",
  summary: "Report Records that have gone stale, lost links, or need review",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm doctor: not implemented yet (see #12)\n");
    return 1;
  },
};
