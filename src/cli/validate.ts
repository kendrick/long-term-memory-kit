import type { Command } from "./run.ts";

// Holds the slot until #9 lands; the lane that builds it replaces this file.
export const validate: Command = {
  name: "validate",
  summary: "Check memory-bank.yaml and each Record against the schemas and Bank rules",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm validate: not implemented yet (see #9)\n");
    return 1;
  },
};
