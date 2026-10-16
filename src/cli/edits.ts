import { applyEdits, type Edit } from "../core/supersede.ts";
import type { CommandContext } from "./run.ts";

export const skipLine = (ctx: CommandContext, command: string) => (rel: string, reason: string) => {
  ctx.err(`ltm ${command}: skipped ${rel}: ${reason}\n`);
};

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
