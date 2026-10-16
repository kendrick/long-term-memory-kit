import { today } from "../core/clock.ts";
import { applyEdits, planAccept, readBankIndex } from "../core/supersede.ts";
import { firstLine } from "../core/text.ts";
import { openBank } from "./bank.ts";
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
    const index = readBankIndex(config, (rel, reason) => {
      ctx.err(`ltm accept: skipped ${rel}: ${reason}\n`);
    });
    const planned = planAccept(index, ctx.positionals[0]!, date);
    if ("refusal" in planned) {
      ctx.err(`ltm accept: ${planned.refusal}\n`);
      return 1;
    }
    const { written, failed } = applyEdits(planned.edits);
    for (const rel of written) ctx.out(`${rel}\n`);
    if (failed !== null) {
      // Files already written can't be unwritten, so say which landed.
      ctx.err(
        `ltm accept: wrote ${written.length === 0 ? "nothing" : written.join(", ")}, then failed on ${failed.rel}: ${failed.message}\n`,
      );
      return 1;
    }
    return 0;
  },
};
