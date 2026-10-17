import { applyEdits, type Edit } from "../core/supersede.ts";
import type { CommandContext } from "./run.ts";

export function skipTally(ctx: CommandContext, command: string) {
  let n = 0;
  return {
    onSkip(rel: string, reason: string): void {
      n++;
      ctx.err(`ltm ${command}: skipped ${rel}: ${reason}\n`);
    },
    // Any skipped file could hold an id or a supersedes edge the plan needs, so a writing command refuses on one.
    refuse(): boolean {
      if (n === 0) return false;
      ctx.err(`ltm ${command}: ${n} ${n === 1 ? "file" : "files"} skipped, so nothing was written\n`);
      return true;
    },
  };
}

// applyEdits rolls back a failed set, but a restore can fail too, so a failure still names any file left changed.
// stdout lists paths only on success, so a script reading it never mistakes a partial run for a finished one.
export function writeEdits(ctx: CommandContext, command: string, edits: Edit[]): 0 | 1 {
  const { written, failed } = applyEdits(edits);
  if (failed !== null) {
    ctx.err(`ltm ${command}: wrote ${written.join(", ") || "nothing"}, then failed on ${failed.rel}: ${failed.message}\n`);
    return 1;
  }
  for (const rel of written) ctx.out(`${rel}\n`);
  return 0;
}
