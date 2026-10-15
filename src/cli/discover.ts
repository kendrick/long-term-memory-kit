import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, findBank, loadConfig, type BankConfig } from "../core/bank.ts";
import { discover as discoverEntries } from "../core/discover.ts";
import { firstLine } from "../core/text.ts";
import type { Command } from "./run.ts";

export const discover: Command = {
  name: "discover",
  summary: "List Hydration source files under the given paths, with their kind and citations",
  options: { json: { type: "boolean" }, bank: { type: "string" } },
  positionals: [{ name: "path", required: true, variadic: true }],
  async run(ctx) {
    let bank: BankConfig | null = null;
    try {
      const flag = ctx.values.bank;
      let root: string | null;
      if (typeof flag === "string") {
        root = resolve(ctx.cwd, flag);
        let isFile = false;
        try {
          isFile = lstatSync(join(root, "memory-bank.yaml")).isFile();
        } catch {
          // Missing, unreadable, or a symlink (lstat) all read the same: no Bank there.
        }
        if (!isFile) {
          ctx.err(`ltm discover: --bank ${flag}: no memory-bank.yaml there\n`);
          return 1;
        }
      } else {
        root = findBank(ctx.cwd);
      }
      if (root !== null) bank = loadConfig(root);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // yaml appends a multi-line code frame to its messages; the first line is the diagnosis.
      const message = firstLine(e.message);
      ctx.err(`ltm discover: ${e.path}${e.line === null ? "" : `:${e.line}`}: ${message}\n`);
      return 1;
    }

    let failed = false;
    const entries = discoverEntries(ctx.positionals, {
      cwd: ctx.cwd,
      bank,
      onError(msg) {
        failed = true;
        ctx.err(`ltm discover: ${msg}\n`);
      },
      onSkip(path, reason) {
        ctx.err(`ltm discover: skipped ${path}: ${reason}\n`);
      },
    });

    if (ctx.values.json === true) {
      ctx.out(`${JSON.stringify(entries, null, 2)}\n`);
    } else {
      for (const e of entries) {
        const cited = e.cited_by !== null && e.cited_by.length > 0 ? `  (cited: ${e.cited_by.join(", ")})` : "";
        ctx.out(`${e.kind}  ${e.path}  ${e.title}${cited}\n`);
      }
    }
    return failed ? 1 : 0;
  },
};
