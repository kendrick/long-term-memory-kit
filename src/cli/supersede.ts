import type { Command } from "./run.ts";

// Holds the slot until #11 lands; the lane that builds it replaces this file.
export const supersede: Command = {
  name: "supersede",
  summary: "Mark one Record superseded by another, editing both",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm supersede: not implemented yet (see #11)\n");
    return 1;
  },
};
