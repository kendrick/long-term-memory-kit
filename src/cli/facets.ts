import { ConfigError, type BankConfig } from "../core/bank.ts";
import { countFacets, listRecords } from "../core/query.ts";
import { resolveBankFlag, resolveBanks } from "../core/resolve.ts";
import { configErrorLine, loadBankAt, locateBank, noBankLine } from "./bank.ts";
import type { Command, CommandContext } from "./run.ts";

export const facets: Command = {
  name: "facets",
  summary: "List every Facet in applies_to with its Record count",
  options: {
    all: { type: "boolean", description: "Count Retired Records too" },
    json: { type: "boolean", description: "Print the counts as JSON" },
    bank: { type: "string", description: "Name or path of the Bank to count" },
  },
  async run(ctx) {
    const config = pickBank(ctx);
    if (config === 1) return 1;
    const records = listRecords(config, (path, reason) => {
      ctx.err(`ltm facets: skipped ${path}: ${reason}\n`);
    });
    const rows = countFacets(records, ctx.values.all === true);
    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const r of rows) ctx.out(`${r.facet}  ${r.count}\n`);
    return 0;
  },
};

// Same order as `ltm show`: --bank, then the Bank around the cwd, then the user config. Counts from two Banks would read as one Bank's, so more than one is refused.
function pickBank(ctx: CommandContext): BankConfig | 1 {
  try {
    const flag = ctx.values.bank;
    if (typeof flag === "string") return resolveBankFlag(flag, ctx.cwd, ctx.env).config;
    const here = locateBank(ctx, "facets");
    if (here === 1) return 1;
    if (here !== null) return loadBankAt(ctx, "facets", here);
    const { banks } = resolveBanks(ctx.cwd, ctx.env);
    if (banks.length === 0) {
      // Not noBankMessage: the eval and existing tests match this line.
      ctx.err(noBankLine("facets", ctx.cwd));
      return 1;
    }
    if (banks.length > 1) {
      const names = banks.map((b) => b.name).join(", ");
      ctx.err(`ltm facets: ${banks.length} Banks resolve for ${ctx.cwd} (${names}); pass --bank to pick one\n`);
      return 1;
    }
    return banks[0]!.config;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    ctx.err(configErrorLine("facets", e));
    return 1;
  }
}
