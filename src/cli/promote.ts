import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isInside, MEMORY_TYPES, type MemoryType } from "../core/bank.ts";
import { today } from "../core/clock.ts";
import { promoteSource } from "../core/promote.ts";
import { redactRemote } from "../core/propose.ts";
import { repoIdentity } from "../core/resolve.ts";
import { firstLine } from "../core/text.ts";
import { loadBankAt } from "./bank.ts";
import type { Command } from "./run.ts";

export const promote: Command = {
  name: "promote",
  summary: "Promote a repo ADR or decision-log entry to a Bank Proposal",
  positionals: [{ name: "path", required: true }],
  options: {
    bank: { type: "string" },
    entry: { type: "string" },
    type: { type: "string", default: "Decision" },
    "applies-to": { type: "string", multiple: true },
    title: { type: "string" },
    summary: { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  },
  // Exit 2 has to come before run() so a bad flag never reads the repo or touches git.
  checkArgs(_positionals, values) {
    if (typeof values.bank !== "string") return "missing required option --bank";
    const type = values.type;
    if (typeof type === "string" && !(MEMORY_TYPES as readonly string[]).includes(type)) {
      return `unknown memory type '${type}' (expected Decision, PolicyRule, Exception, or Context)`;
    }
    if (values["dry-run"] === true && values.json === true) return "--dry-run and --json can't be used together";
    return undefined;
  },
  async run(ctx) {
    const fail = (line: string): 1 => {
      for (const l of line.split("\n")) ctx.err(`ltm promote: ${l}\n`);
      return 1;
    };

    let date: string;
    try {
      date = today(ctx.env);
    } catch (e) {
      return fail(firstLine(e instanceof Error ? e.message : String(e)));
    }

    const { root, remote } = repoIdentity(ctx.cwd);
    if (root === null) return fail(`${ctx.cwd} is not inside a git work tree`);
    if (remote === null) return fail(`no usable origin remote in ${root}; promoted_from needs the repo's org/repo`);

    const path = ctx.positionals[0]!;
    const realRoot = realpathSync(root);
    let abs = resolve(ctx.cwd, path);
    try {
      // Realpath so a symlink out of the repo can't pass the containment check below.
      abs = realpathSync(abs);
    } catch (e) {
      return fail(`can't read ${path}: ${firstLine(e instanceof Error ? e.message : String(e))}`);
    }
    if (!isInside(realRoot, abs)) return fail(`${path} is outside the repo at ${root}`);
    const rel = relative(realRoot, abs).split(sep).join("/");

    const config = loadBankAt(ctx, "promote", resolve(ctx.cwd, ctx.values.bank as string));
    if (config === 1) return 1;

    const applies = ctx.values["applies-to"];
    const result = await promoteSource(
      {
        abs,
        rel,
        repo: `${remote.org}/${remote.repo}`,
        type: ctx.values.type as MemoryType,
        ...(typeof ctx.values.entry === "string" ? { entry: ctx.values.entry } : {}),
        ...(typeof ctx.values.title === "string" ? { title: ctx.values.title } : {}),
        ...(typeof ctx.values.summary === "string" ? { summary: ctx.values.summary } : {}),
        ...(Array.isArray(applies) && applies.length > 0 ? { applies_to: applies as string[] } : {}),
      },
      {
        config,
        today: date,
        env: ctx.env,
        dryRun: ctx.values["dry-run"] === true,
        onWarning: (line) => ctx.err(`ltm promote: ${line}\n`),
      },
    );

    if ("refusal" in result) {
      fail(result.refusal);
      if (result.url) ctx.err(`${result.url}\n`);
      return 1;
    }
    if (result.dryRun) {
      ctx.out(result.text);
      return 0;
    }
    if (ctx.values.json === true) {
      const { id, path, branch, url, adapter, stamped } = result;
      ctx.out(`${JSON.stringify({ id, path, branch, url, adapter, stamped }, null, 2)}\n`);
      return 0;
    }
    ctx.out(`path: ${result.path}\nbranch: ${result.branch}\n`);
    if (result.url) ctx.out(`review: ${result.url}\n`);
    else ctx.out(`review: open a change request for ${result.branch} on ${redactRemote(result.remoteUrl)}\n`);
    ctx.out(`stamped: ${result.stamped.path}:${result.stamped.line}\n`);
    return 0;
  },
};
