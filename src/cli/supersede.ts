import { applyEdits, planSupersede, readBankIndex } from "../core/supersede.ts";
import { openBank } from "./bank.ts";
import type { Command } from "./run.ts";

export const supersede: Command = {
  name: "supersede",
  summary: "Mark one Record superseded by another, editing both",
  positionals: [
    { name: "old-id", required: true },
    { name: "new-id", required: true },
  ],
  async run(ctx) {
    const config = openBank(ctx, "supersede");
    if (config === 1) return 1;
    const [oldId, newId] = ctx.positionals as [string, string];
    const index = readBankIndex(config, (rel, reason) => {
      ctx.err(`ltm supersede: skipped ${rel}: ${reason}\n`);
    });
    const planned = planSupersede(index, oldId, newId);
    if ("refusal" in planned) {
      ctx.err(`ltm supersede: ${planned.refusal}\n`);
      return 1;
    }
    const { written, failed } = applyEdits(planned.edits);
    if (failed !== null) {
      // Writes aren't atomic across files; naming what landed tells the user what to inspect.
      ctx.err(`ltm supersede: wrote ${written.join(", ") || "nothing"}, then failed on ${failed.rel}: ${failed.message}\n`);
      return 1;
    }
    for (const rel of written) ctx.out(`${rel}\n`);
    return 0;
  },
};
