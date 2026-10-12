import { ConfigError, findBank } from "../core/bank.ts";
import { validateBank } from "../core/validate.ts";
import type { Command } from "./run.ts";

export const validate: Command = {
  name: "validate",
  summary: "Check memory-bank.yaml and each Record against the schemas and Bank rules",
  options: { json: { type: "boolean" } },
  positionals: [{ name: "path", required: false, variadic: true }],
  async run(ctx) {
    let root: string | null;
    try {
      root = findBank(ctx.cwd);
    } catch (e) {
      // #7 makes findBank throw ConfigError for a symlinked memory-bank.yaml.
      if (!(e instanceof ConfigError)) throw e;
      ctx.err(`ltm validate: ${e.path}: ${e.message.split("\n")[0]}\n`);
      return 1;
    }
    if (root === null) {
      ctx.err(`ltm validate: no memory-bank.yaml in ${ctx.cwd} or any parent directory\n`);
      return 1;
    }
    const findings = validateBank(root, ctx.positionals.length > 0 ? ctx.positionals : null, ctx.cwd);
    if (ctx.values.json === true) {
      const rows = findings.map(({ file, line, rule, severity, key, message }) => ({
        file,
        line,
        rule,
        severity,
        key,
        message,
      }));
      ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
    } else {
      for (const f of findings) {
        ctx.out(`${f.file}:${f.line}: ${f.severity} ${f.rule}: ${f.key ?? "-"}: ${f.message}\n`);
      }
    }
    return findings.length > 0 ? 1 : 0;
  },
};
