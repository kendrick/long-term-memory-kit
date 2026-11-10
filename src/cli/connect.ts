import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError } from "../core/bank.ts";
import { connectRegion, spliceConnectRegion } from "../core/connect.ts";
import { noBankMessage, resolveBankFlag, resolveBanks, type ResolvedBank } from "../core/resolve.ts";
import { firstLine } from "../core/text.ts";
import { configErrorLine } from "./bank.ts";
import type { Command } from "./run.ts";

const bankLine = (b: ResolvedBank): string =>
  `Org-level decisions, policies, and exceptions live in the ${b.name} Bank at ${b.url ?? b.root}.`;

export const connect: Command = {
  name: "connect",
  summary: "Print a Markdown snippet that points a Consumer repo's agents at its Banks",
  options: {
    bank: { type: "string", description: "Bank name from your user config, or path to a Bank" },
    write: { type: "string", description: "Replace the ltm:connect region in this file, or append it once" },
  },
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
      ctx.err(configErrorLine("connect", e));
      return 1;
    }
    const region = connectRegion(
      [
        "## Org memory",
        ...banks.map(bankLine),
        "Before making an architectural choice, follow that Bank's AGENTS.md to query it, or run `ltm query` from this repo.",
        "",
      ].join("\n"),
    );
    if (typeof ctx.values.write !== "string") {
      ctx.out(region);
      return 0;
    }
    const file = ctx.values.write;
    const abs = resolve(ctx.cwd, file);
    try {
      let current: string | null = null;
      try {
        current = readFileSync(abs, "utf8");
      } catch (e) {
        // A missing file is the first-connect case; anything else (EISDIR, EACCES) is a real failure.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      writeFileSync(abs, spliceConnectRegion(current, region));
    } catch (e) {
      const msg = e instanceof Error ? firstLine(e.message) : String(e);
      ctx.err(`ltm connect: ${file}: ${msg}; nothing written\n`);
      return 1;
    }
    return 0;
  },
};
