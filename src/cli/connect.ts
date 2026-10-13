import { ConfigError } from "../core/bank.ts";
import { noBankMessage, resolveBankFlag, resolveBanks, type ResolvedBank } from "../core/resolve.ts";
import type { Command } from "./run.ts";

const bankLine = (b: ResolvedBank): string =>
  `Org-level decisions, policies, and exceptions live in the ${b.name} Bank at ${b.url ?? b.root}.`;

export const connect: Command = {
  name: "connect",
  summary: "Print a Markdown snippet that points a Consumer repo's agents at its Banks",
  options: { bank: { type: "string" } },
  async run(ctx) {
    let banks: ResolvedBank[];
    try {
      if (typeof ctx.values.bank === "string") {
        banks = [resolveBankFlag(ctx.values.bank, ctx.cwd, ctx.env)];
      } else {
        const resolution = resolveBanks(ctx.cwd, ctx.env);
        if (resolution.banks.length === 0) {
          ctx.err(`ltm connect: ${noBankMessage(resolution.checked)}\n`);
          return 1;
        }
        banks = resolution.banks;
      }
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // yaml appends a multi-line code frame; the first line is the diagnosis.
      const message = e.message.split("\n")[0];
      ctx.err(`ltm connect: ${e.path}${e.line === null ? "" : `:${e.line}`}: ${message}\n`);
      return 1;
    }
    ctx.out(
      [
        "## Org memory",
        ...banks.map(bankLine),
        "Before making an architectural choice, follow that Bank's AGENTS.md to query it, or run `ltm query` from this repo.",
        "",
      ].join("\n"),
    );
    return 0;
  },
};
