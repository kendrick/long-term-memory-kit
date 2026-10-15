import { ConfigError, findBank } from "../core/bank.ts";
import { toGithub, toGitlab, toJunit } from "../core/report.ts";
import { firstLine } from "../core/text.ts";
import { validateBankReport } from "../core/validate.ts";
import type { Command } from "./run.ts";

const FORMATS = ["github", "gitlab", "junit"] as const;
type Format = (typeof FORMATS)[number];

export const validate: Command = {
  name: "validate",
  summary: "Check memory-bank.yaml and each Record against the schemas and Bank rules",
  options: { json: { type: "boolean" }, format: { type: "string" } },
  positionals: [{ name: "path", required: false, variadic: true }],
  checkArgs(_positionals, values) {
    const format = values.format;
    if (format === undefined) return undefined;
    if (values.json === true) return "--format and --json can't be combined";
    // Plain text is the default, not a format name, so `--format text` is rejected rather than guessed at.
    if (typeof format !== "string" || !(FORMATS as readonly string[]).includes(format)) {
      return `unknown format '${String(format)}' (expected github, gitlab, or junit)`;
    }
    return undefined;
  },
  async run(ctx) {
    let root: string | null;
    try {
      root = findBank(ctx.cwd);
    } catch (e) {
      // #7 makes findBank throw ConfigError for a symlinked memory-bank.yaml.
      if (!(e instanceof ConfigError)) throw e;
      ctx.err(`ltm validate: ${e.path}: ${firstLine(e.message)}\n`);
      return 1;
    }
    if (root === null) {
      ctx.err(`ltm validate: no memory-bank.yaml in ${ctx.cwd} or any parent directory\n`);
      return 1;
    }
    const { findings, files } = validateBankReport(root, ctx.positionals.length > 0 ? ctx.positionals : null, ctx.cwd);
    const format = ctx.values.format as Format | undefined;
    if (format === "github") ctx.out(toGithub(findings));
    else if (format === "gitlab") ctx.out(toGitlab(findings));
    else if (format === "junit") ctx.out(toJunit(findings, files));
    else if (ctx.values.json === true) {
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
    // Warnings are advice; failing CI on them would push teams to switch the checks off.
    return findings.some((f) => f.severity === "error") ? 1 : 0;
  },
};
