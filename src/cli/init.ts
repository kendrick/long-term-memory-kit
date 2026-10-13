import type { Command } from "./run.ts";

// Holds the slot until #16 lands; the lane that builds it replaces this file.
export const init: Command = {
  name: "init",
  summary: "Scaffold a Bank and its generated agent instructions, or check them with --check",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm init: not implemented yet (see #16)\n");
    return 1;
  },
};
