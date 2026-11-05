import { runDoctor, loadThresholds } from "../core/doctor.ts";
import { today } from "../core/clock.ts";
import { loadRecall, qmdBackend, RecallError, type QmdBackend } from "../core/qmd.ts";
import { qmdVectorBackend } from "../core/qmd-vector.ts";
import { listRecords } from "../core/query.ts";
import { firstLine } from "../core/text.ts";
import { ConfigError } from "../core/bank.ts";
import { resolveBankFlag } from "../core/resolve.ts";
import { configErrorLine, openBank } from "./bank.ts";
import type { Command } from "./run.ts";

export const doctor: Command = {
  name: "doctor",
  summary: "Report Records that have gone stale, lost links, or need review",
  options: {
    json: { type: "boolean", description: "Print the findings as JSON" },
    bank: { type: "string", description: "Bank name from your user config, or path to a Bank" },
  },
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
    const recall = loadRecall(config);
    if (recall !== null && "error" in recall) {
      ctx.err(`ltm doctor: memory-bank.yaml: ${recall.error}\n`);
      return 1;
    }
    const warn = (line: string) => ctx.err(`ltm doctor: qmd: ${line}\n`);
    const backend: QmdBackend | undefined =
      recall === null ? undefined : recall.mode === "vector" ? qmdVectorBackend(recall, config.root, ctx.env, warn) : qmdBackend(recall, config.root, ctx.env, warn);
    const problem = backend?.preflight();
    if (problem) {
      ctx.err(`ltm doctor: ${problem}\n`);
      return 1;
    }
    const records = listRecords(config, (path, reason) => {
      ctx.err(`ltm doctor: skipped ${path}: ${reason}\n`);
    });
    let findings;
    try {
      backend?.prefetch?.(records);
      findings = runDoctor(records, date, thresholds, backend);
    } catch (e) {
      if (!(e instanceof RecallError)) throw e;
      ctx.err(`ltm doctor: ${e.message}\n`);
      return 1;
    }
    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(findings, null, 2)}\n`);
      return 0;
    }
    for (const f of findings) ctx.out(`${f.file}: ${f.check}: ${f.message}\n`);
    return 0;
  },
};
