import { spawnSync } from "node:child_process";
import { today } from "../core/clock.ts";
import { planAccept, readBankIndex } from "../core/supersede.ts";
import { firstLine } from "../core/text.ts";
import { openBank } from "./bank.ts";
import { skipTally, writeEdits } from "./edits.ts";
import type { Command } from "./run.ts";

export const accept: Command = {
  name: "accept",
  summary: "Accept a Proposal, stamping its dates and making its Supersessions",
  positionals: [{ name: "id", required: false }],
  options: { "changed-since": { type: "string", description: "Accept every Proposal changed since this git ref" } },
  checkArgs(positionals, values) {
    const since = values["changed-since"] !== undefined;
    if (since && positionals.length > 0) return "pass either <id> or --changed-since, not both";
    if (!since && positionals.length === 0) return "missing <id> (or --changed-since <ref>)";
    return undefined;
  },
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
    const since = ctx.values["changed-since"];
    // Fresh index per id: an earlier id's Supersession edits can change what a later one plans against.
    const acceptOne = (id: string): 0 | 1 => {
      const skips = skipTally(ctx, "accept");
      const index = readBankIndex(config, skips.onSkip);
      if (skips.refuse()) return 1;
      const planned = planAccept(index, id, date);
      if ("refusal" in planned) {
        ctx.err(`ltm accept: ${planned.refusal}\n`);
        return 1;
      }
      const code = writeEdits(ctx, "accept", planned.edits);
      if (code === 0 && typeof since === "string") ctx.err(`ltm accept: accepted ${id}\n`);
      return code;
    };
    if (typeof since !== "string") return acceptOne(ctx.positionals[0]!);

    // -z keeps git from C-quoting non-ASCII paths, which would never match a Record rel. --relative makes the paths Bank-root-relative even when the Bank sits in a subdirectory of the repo.
    const diff = spawnSync("git", ["diff", "--name-only", "-z", "--relative", "-M", "--diff-filter=AMR", `${since}...HEAD`], {
      cwd: config.root,
      encoding: "utf8",
    });
    if (diff.status !== 0) {
      ctx.err(`ltm accept: ${firstLine(diff.stderr || String(diff.error))}\n`);
      return 1;
    }
    const changed = new Set(diff.stdout.split("\0").filter(Boolean));
    const skips = skipTally(ctx, "accept");
    const selected = readBankIndex(config, skips.onSkip)
      .records.filter((r) => changed.has(r.rel) && r.data.status === "proposed")
      .sort((a, b) => (a.rel < b.rel ? -1 : 1));
    // Accepting a successor flips its predecessor to `superseded`, and planAccept then refuses that id. So each Proposal follows every selected Proposal it supersedes; a cycle's back-edge is dropped and planAccept refuses the cycle itself.
    const byId = new Map(selected.map((r) => [String(r.data.id), r]));
    const seen = new Set<string>();
    const ids: string[] = [];
    const visit = (r: (typeof selected)[number]) => {
      const id = String(r.data.id);
      if (seen.has(id)) return;
      seen.add(id);
      const old = Array.isArray(r.data.supersedes) ? r.data.supersedes : [];
      for (const o of old) {
        const dep = byId.get(String(o));
        if (dep) visit(dep);
      }
      ids.push(id);
    };
    selected.forEach(visit);
    if (skips.refuse()) return 1;
    for (const id of ids) if (acceptOne(id) === 1) return 1;
    return 0;
  },
};
