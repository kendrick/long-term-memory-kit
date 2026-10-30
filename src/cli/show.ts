import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ConfigError, isInside, loadConfig } from "../core/bank.ts";
import { listRecords } from "../core/query.ts";
import { noBankMessage, resolveBankFlag, resolveBanks } from "../core/resolve.ts";
import { configErrorLine, locateBank } from "./bank.ts";
import type { Command } from "./run.ts";

export const show: Command = {
  name: "show",
  summary: "Print one Record file whole, frontmatter and body, found by id or by Bank-relative path",
  options: { bank: { type: "string", description: "Bank name from your user config, or path to a Bank" } },
  positionals: [{ name: "id-or-path", required: true }],
  async run(ctx) {
    const target = ctx.positionals[0] as string;
    // The schema pins ids to [A-Za-z0-9_-]{10}, so a `.` or `/` can only mean a path.
    const isPath = /[./]/.test(target);
    const fail = (msg: string): 1 => {
      ctx.err(`ltm show: ${msg}\n`);
      return 1;
    };
    const matches: string[] = [];
    let contained = false;
    try {
      let roots: string[];
      const flag = ctx.values.bank;
      if (typeof flag === "string") {
        roots = [resolveBankFlag(flag, ctx.cwd, ctx.env).root];
      } else {
        const here = locateBank(ctx, "show");
        if (here === 1) return 1;
        if (here !== null) {
          roots = [here];
        } else {
          const res = resolveBanks(ctx.cwd, ctx.env);
          if (res.banks.length === 0) return fail(noBankMessage(res.checked));
          roots = res.banks.map((b) => b.root);
        }
      }
      for (const root of roots) {
        const records = listRecords(loadConfig(root), () => {});
        if (!isPath) {
          for (const r of records) if (r.frontmatter.id === target) matches.push(join(root, r.path));
          continue;
        }
        // Realpath both sides before the check, so neither `..` nor a symlink reads a file outside the Bank.
        const realRoot = realpathSync(root);
        const abs = resolve(realRoot, target);
        const real = existsSync(abs) ? realpathSync(abs) : abs;
        // With several Banks resolved, a path is outside all but one of them; refuse only if no Bank holds it.
        if (!isInside(realRoot, real)) continue;
        contained = true;
        // Only listRecords paths, so an in-Bank non-Record like a clone's .git/config stays unreadable.
        const rel = relative(realRoot, real);
        if (records.some((r) => r.path === rel)) matches.push(real);
      }
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      ctx.err(configErrorLine("show", e));
      return 1;
    }
    if (isPath && !contained) return fail(`${target} is outside the Bank`);
    if (matches.length === 0) return fail(isPath ? `${target} is not a Record in the Bank` : `'${target}' matches no Record`);
    if (matches.length > 1) return fail(`'${target}' is held by ${matches.length} Records`);
    ctx.out(readFileSync(matches[0] as string, "utf8"));
    return 0;
  },
};
