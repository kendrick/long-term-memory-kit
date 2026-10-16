import { toGithub, toGitlab, toJunit } from "../core/report.ts";
import { validateBankReport } from "../core/validate.ts";
import { locateBank, noBankLine } from "./bank.ts";
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
    const root = locateBank(ctx, "validate");
    if (root === 1) return 1;
    if (root === null) {
      ctx.err(noBankLine("validate", ctx.cwd));
      return 1;
    }
    // No loadBankAt here: validateBankReport loads the config itself and reports a broken one as a config-schema finding on stdout, which --format github|gitlab|junit hands to CI and stderr would lose.
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
