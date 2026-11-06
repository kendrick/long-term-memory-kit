import { resolve } from "node:path";
import { today } from "../core/clock.ts";
import { digestFiles, sizeWarnings, writeDigest } from "../core/digest.ts";
import { listRecords } from "../core/query.ts";
import { openBank } from "./bank.ts";
import type { Command } from "./run.ts";

export const digest: Command = {
  name: "digest",
  summary: "Render the Bank's accepted Records as a Digest for readers outside the Bank",
  options: {
    out: { type: "string", description: "Write Digest files into this directory instead of stdout" },
    split: { type: "string", description: "Write one file per Facet plus org-wide.md; the only mode is facet" },
  },
  checkArgs(_positionals, values) {
    const split = values.split;
    if (split === undefined) return undefined;
    if (split !== "facet") return `--split takes only 'facet', not '${String(split)}'`;
    // Several files can't share stdout, so a split Digest needs somewhere to land.
    if (values.out === undefined) return "--split needs --out <dir>";
    return undefined;
  },
  async run(ctx) {
    const config = openBank(ctx, "digest");
    if (config === 1) return 1;
    const all = listRecords(config, (path, reason) => {
      ctx.err(`ltm digest: skipped ${path}: ${reason}\n`);
    });
    let day: string;
    try {
      day = today(ctx.env);
    } catch (e) {
      ctx.err(`ltm digest: ${(e as Error).message}\n`);
      return 1;
    }
    const split = ctx.values.split === "facet";
    const files = digestFiles({ config, all, today: day, split });
    const out = ctx.values.out;
    if (typeof out === "string") writeDigest(resolve(ctx.cwd, out), files, split, day);
    else ctx.out(files[0]!.content);
    for (const line of sizeWarnings(files)) ctx.err(`${line}\n`);
    return 0;
  },
};
