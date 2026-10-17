import { planSupersede, readBankIndex } from "../core/supersede.ts";
import { openBank } from "./bank.ts";
import { skipTally, writeEdits } from "./edits.ts";
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
    const skips = skipTally(ctx, "supersede");
    const index = readBankIndex(config, skips.onSkip);
    if (skips.refuse()) return 1;
    const planned = planSupersede(index, oldId, newId);
    if ("refusal" in planned) {
      ctx.err(`ltm supersede: ${planned.refusal}\n`);
      return 1;
    }
    return writeEdits(ctx, "supersede", planned.edits);
  },
};
