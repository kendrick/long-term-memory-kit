import { runDoctor, loadThresholds } from "../core/doctor.ts";
import { today } from "../core/clock.ts";
import { listRecords } from "../core/query.ts";
import { firstLine } from "../core/text.ts";
import { ConfigError } from "../core/bank.ts";
import { resolveBankFlag } from "../core/resolve.ts";
import { configErrorLine, openBank } from "./bank.ts";
import type { Command } from "./run.ts";

export const doctor: Command = {
  name: "doctor",
  summary: "Report Records that have gone stale, lost links, or need review",
  options: { json: { type: "boolean" }, bank: { type: "string" } },
  async run(ctx) {
    // Findings are advice, not failure: exit 0 whenever the checks ran, so a script can read the output
    // without treating a dirty Bank as a broken command.
    let date: string;
    try {
      date = today(ctx.env);
    } catch (e) {
      ctx.err(`ltm doctor: ${firstLine((e as Error).message)}\n`);
      return 1;
    }
    const flag = ctx.values.bank;
    let config;
    if (typeof flag === "string") {
      try {
        config = resolveBankFlag(flag, ctx.cwd, ctx.env).config;
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        ctx.err(configErrorLine("doctor", e));
        return 1;
      }
    } else {
      config = openBank(ctx, "doctor");
      if (config === 1) return 1;
    }
    const thresholds = loadThresholds(config);
    if ("error" in thresholds) {
      ctx.err(`ltm doctor: memory-bank.yaml: ${thresholds.error}\n`);
      return 1;
    }
    const records = listRecords(config, (path, reason) => {
      ctx.err(`ltm doctor: skipped ${path}: ${reason}\n`);
    });
    const findings = runDoctor(records, date, thresholds);
    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(findings, null, 2)}\n`);
      return 0;
    }
    for (const f of findings) ctx.out(`${f.file}: ${f.check}: ${f.message}\n`);
    return 0;
  },
};
