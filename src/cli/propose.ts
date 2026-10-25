import { readFileSync } from "node:fs";
import { MEMORY_TYPES, type MemoryType } from "../core/bank.ts";
import { today } from "../core/clock.ts";
import { parseIssueForm } from "../core/issue-form.ts";
import { proposeRecord, redactRemote, type ListField, type ProposalInput } from "../core/propose.ts";
import { firstLine } from "../core/text.ts";
import { openBank } from "./bank.ts";
import type { Command } from "./run.ts";

const LIST_FLAGS: Record<string, ListField> = {
  "applies-to": "applies_to",
  owners: "owners",
  tags: "tags",
  related: "related",
  supersedes: "supersedes",
  "source-ref": "source_refs",
};

const many = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

export const propose: Command = {
  name: "propose",
  summary: "Open a Proposal on a new ltm/propose branch for review",
  options: {
    type: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    "applies-to": { type: "string", multiple: true },
    owners: { type: "string", multiple: true },
    tags: { type: "string", multiple: true },
    related: { type: "string", multiple: true },
    supersedes: { type: "string", multiple: true },
    "source-ref": { type: "string", multiple: true },
    "body-file": { type: "string" },
    "body-stdin": { type: "boolean" },
    "from-issue-form": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  },
  // Exit 2 has to come before run() so a bad flag never reads the Bank or touches git.
  checkArgs(_positionals, values) {
    if (typeof values["from-issue-form"] === "string") {
      const clash = ["type", "title", "summary", "applies-to", "body-file", "body-stdin"].find((f) => values[f] !== undefined);
      if (clash) return `--from-issue-form and --${clash} can't be used together`;
      if (values["dry-run"] === true && values.json === true) return "--dry-run and --json can't be used together";
      return undefined;
    }
    const type = values.type;
    if (typeof type !== "string") return "missing required option --type";
    if (typeof values.title !== "string") return "missing required option --title";
    if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
      return `unknown memory type '${type}' (expected Decision, PolicyRule, Exception, or Context)`;
    }
    if (typeof values["body-file"] === "string" && values["body-stdin"] === true) {
      return "--body-file and --body-stdin can't be used together";
    }
    if (values["dry-run"] === true && values.json === true) return "--dry-run and --json can't be used together";
    return undefined;
  },
  async run(ctx) {
    const config = openBank(ctx, "propose");
    if (config === 1) return 1;

    let input: ProposalInput;
    let body: string | undefined;
    const formFile = ctx.values["from-issue-form"];
    if (typeof formFile === "string") {
      let parsed: ReturnType<typeof parseIssueForm>;
      try {
        parsed = parseIssueForm(readFileSync(formFile, "utf8"));
      } catch (e) {
        parsed = { error: `can't read the file: ${firstLine(e instanceof Error ? e.message : String(e))}` };
      }
      if ("error" in parsed) {
        ctx.err(`ltm propose: ${formFile}: ${parsed.error}\n`);
        return 1;
      }
      input = { ...parsed.input, source_refs: [...parsed.input.source_refs, ...many(ctx.values["source-ref"])] };
    } else {
      input = { type: ctx.values.type as MemoryType, title: ctx.values.title as string };
    }
    try {
      const file = ctx.values["body-file"];
      if (typeof file === "string") body = readFileSync(file, "utf8");
      // CommandContext carries no stdin, so the descriptor is read directly.
      else if (ctx.values["body-stdin"] === true) body = readFileSync(0, "utf8");
    } catch (e) {
      ctx.err(`ltm propose: can't read the body: ${firstLine(e instanceof Error ? e.message : String(e))}\n`);
      return 1;
    }

    if (typeof formFile !== "string" && typeof ctx.values.summary === "string") input.summary = ctx.values.summary;
    for (const [flag, key] of Object.entries(LIST_FLAGS)) {
      if (typeof formFile === "string" && (flag === "applies-to" || flag === "source-ref")) continue;
      const v = many(ctx.values[flag]);
      if (v.length > 0) input[key] = v;
    }
    if (body !== undefined) input.body = body;

    let date: string;
    try {
      date = today(ctx.env);
    } catch (e) {
      ctx.err(`ltm propose: ${firstLine(e instanceof Error ? e.message : String(e))}\n`);
      return 1;
    }

    const result = await proposeRecord(input, {
      config,
      today: date,
      env: ctx.env,
      dryRun: ctx.values["dry-run"] === true,
      onWarning: (line) => ctx.err(`ltm propose: ${line}\n`),
    });

    if ("refusal" in result) {
      for (const l of result.refusal.split("\n")) ctx.err(`ltm propose: ${l}\n`);
      if (result.url) ctx.err(`${result.url}\n`);
      return 1;
    }
    if (result.dryRun) {
      ctx.out(result.text);
      return 0;
    }
    if (ctx.values.json === true) {
      const { id, path, branch, url, adapter } = result;
      ctx.out(`${JSON.stringify({ id, path, branch, url, adapter }, null, 2)}\n`);
      return 0;
    }
    ctx.out(`path: ${result.path}\nbranch: ${result.branch}\n`);
    if (result.url) ctx.out(`review: ${result.url}\n`);
    else ctx.out(`review: open a change request for ${result.branch} on ${redactRemote(result.remoteUrl)}\n`);
    return 0;
  },
};
