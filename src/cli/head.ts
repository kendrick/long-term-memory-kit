import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitFrontmatter } from "../core/record.ts";
import type { Command } from "./run.ts";

export const head: Command = {
  name: "head",
  summary: "Print each file's frontmatter block, fences included, every line ending in a newline",
  positionals: [{ name: "path", required: true, variadic: true }],
  async run(ctx) {
    const many = ctx.positionals.length > 1;
    let failed = false;
    let printed = false;
    for (const path of ctx.positionals) {
      let text: string;
      try {
        text = readFileSync(resolve(ctx.cwd, path), "utf8");
      } catch (e) {
        ctx.err(`ltm head: ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
        failed = true;
        continue;
      }
      const split = splitFrontmatter(text);
      if (!split) {
        ctx.err(`ltm head: ${path}: no frontmatter\n`);
        failed = true;
        continue;
      }
      // closingLine counts from the opening fence at 0, so +1 includes the closing fence.
      const block = text
        .split("\n")
        .slice(0, split.closingLine + 1)
        .join("\n");
      // Headers and the blank-line separator mirror head(1) for multiple files.
      if (many) ctx.out(`${printed ? "\n" : ""}==> ${path} <==\n`);
      ctx.out(`${block}\n`);
      printed = true;
    }
    return failed ? 1 : 0;
  },
};
