import { relative, resolve } from "node:path";
import { today } from "../core/clock.ts";
import { planStamp, readBankIndex, type StampTarget } from "../core/supersede.ts";
import { firstLine } from "../core/text.ts";
import { openBank } from "./bank.ts";
import { skipTally, writeEdits } from "./edits.ts";
import type { Command } from "./run.ts";

// confirm and deprecate differ only in the field planStamp sets, so they share one body.
export function stampCommand(change: "confirm" | "deprecate", summary: string): Command {
  return {
    name: change,
    summary,
    positionals: [{ name: "id-or-path", required: true, variadic: true }],
    async run(ctx) {
      // Before the Bank opens, as accept does: a bad clock must refuse with nothing read. deprecate stamps no date, so it never reads the clock.
      let date = "";
      if (change === "confirm") {
        try {
          date = today(ctx.env);
        } catch (e) {
          ctx.err(`ltm ${change}: ${firstLine((e as Error).message)}\n`);
          return 1;
        }
      }
      const config = openBank(ctx, change);
      if (config === 1) return 1;
      // The schema pins ids to [A-Za-z0-9_-]{10}, so a `.` or `/` can only mean a path. A path is cwd-relative, so one pasted from doctor output works at the Bank root and a relative one works from a subfolder.
      const targets: StampTarget[] = ctx.positionals.map((t) =>
        /[./]/.test(t) ? { rel: relative(config.root, resolve(ctx.cwd, t)) } : { id: t },
      );
      const skips = skipTally(ctx, change);
      const index = readBankIndex(config, skips.onSkip);
      if (skips.refuse()) return 1;
      const planned = planStamp(index, targets, change, date);
      if ("refusal" in planned) {
        ctx.err(`ltm ${change}: ${planned.refusal}\n`);
        return 1;
      }
      return writeEdits(ctx, change, planned.edits);
    },
  };
}

export const confirm = stampCommand("confirm", "Set last_confirmed to today on accepted Records, by id or path");
