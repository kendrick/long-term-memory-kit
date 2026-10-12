import type { Command } from "./run.ts";

// Holds the slot until #8 lands; the lane that builds it replaces this file.
export const fmt: Command = {
  name: "fmt",
  summary: "Rewrite Record frontmatter canonically, leaving the body byte-identical",
  hidden: true,
  async run(ctx) {
    ctx.err("ltm fmt: not implemented yet (see #8)\n");
    return 1;
  },
};
