import { today } from "../core/clock.ts";
import { planAccept, readBankIndex } from "../core/supersede.ts";
import { firstLine } from "../core/text.ts";
import { openBank } from "./bank.ts";
import { skipTally, writeEdits } from "./edits.ts";
import type { Command } from "./run.ts";

export const accept: Command = {
  name: "accept",
  summary: "Accept a Proposal, stamping its dates and making its Supersessions",
  positionals: [{ name: "id", required: true }],
  async run(ctx) {
    // Before the Bank opens: a bad clock must refuse with nothing read or written.
    let date: string;
    try {
      date = today(ctx.env);
    } catch (e) {
      ctx.err(`ltm accept: ${firstLine((e as Error).message)}\n`);
      return 1;
    }
    const config = openBank(ctx, "accept");
    if (config === 1) return 1;
    const skips = skipTally(ctx, "accept");
    const index = readBankIndex(config, skips.onSkip);
    if (skips.refuse()) return 1;
    const planned = planAccept(index, ctx.positionals[0]!, date);
    if ("refusal" in planned) {
      ctx.err(`ltm accept: ${planned.refusal}\n`);
      return 1;
    }
    return writeEdits(ctx, "accept", planned.edits);
  },
};
