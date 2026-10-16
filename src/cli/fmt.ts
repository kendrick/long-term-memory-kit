import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { isInside, isMapping, type BankConfig } from "../core/bank.ts";
import { formatRecordText } from "../core/fmt.ts";
import { listRecordFiles, type RecordFile } from "../core/query.ts";
import { splitFrontmatter } from "../core/record.ts";
import { firstLine } from "../core/text.ts";
import { openBank } from "./bank.ts";
import type { Command } from "./run.ts";

const toPosix = (p: string): string => p.split(sep).join("/");

// A Record whose frontmatter won't parse still gets formatted (or refused) on its own
// turn; here it just contributes no id, since it has none we could trust.
function existingId(text: string): string | null {
  const split = splitFrontmatter(text);
  if (!split) return null;
  try {
    const data: unknown = parse(split.frontmatterLines.join("\n"));
    return isMapping(data) && typeof data.id === "string" ? data.id : null;
  } catch {
    return null;
  }
}

function statusAliases(config: BankConfig): string[] {
  const aliases = isMapping(config.raw.heading_aliases) ? config.raw.heading_aliases.Status : undefined;
  return Array.isArray(aliases) && aliases.every((a) => typeof a === "string") ? (aliases as string[]) : [];
}

export const fmt: Command = {
  name: "fmt",
  summary: "Rewrite Record frontmatter canonically, leaving the body byte-identical",
  options: { check: { type: "boolean" } },
  positionals: [{ name: "path", required: false, variadic: true }],
  async run(ctx) {
    const config = openBank(ctx, "fmt");
    if (config === 1) return 1;
    const root = config.root;
    const skipped = new Set<string>();
    let failed = false;
    const namedRels = ctx.positionals.map((p) => {
      const abs = resolve(ctx.cwd, p);
      return isInside(root, abs) ? toPosix(relative(root, abs)) : p;
    });
    // Same rule as `ltm validate`: a skip fails the run when it could hide a Record we were
    // asked to check. fmt --check is a CI gate, so an unchecked Record must not read as a pass.
    // A skipped directory hides every named file beneath it, hence the prefix test.
    const touchesNamed = (rel: string): boolean =>
      namedRels.length === 0 || namedRels.some((n) => n === rel || n.startsWith(`${rel}/`));
    const files: RecordFile[] = listRecordFiles(config, (path, reason) => {
      skipped.add(path);
      ctx.err(`ltm fmt: skipped ${path}: ${reason}\n`);
      if (touchesNamed(path)) failed = true;
    });

    let targets = files;
    if (ctx.positionals.length > 0) {
      const byAbs = new Map(files.map((f) => [resolve(f.abs), f]));
      targets = [];
      for (const p of ctx.positionals) {
        const abs = resolve(ctx.cwd, p);
        const rel = isInside(root, abs) ? toPosix(relative(root, abs)) : p;
        const f = byAbs.get(abs);
        if (f) {
          if (!targets.includes(f)) targets.push(f);
        } else if (!skipped.has(rel)) {
          // A skipped path already got its own stderr line from the walk.
          ctx.err(`ltm fmt: ${rel}: not a Record file under any configured type folder\n`);
          failed = true;
        }
      }
    }

    // Seeded from every Record, named or not: a new id has to be unique across the
    // whole Bank, and formatRecordText adds each id it mints so the run stays unique too.
    const texts = new Map<string, string | Error>();
    const takenIds = new Set<string>();
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f.abs, "utf8");
      } catch (e) {
        texts.set(f.abs, e as Error);
        continue;
      }
      texts.set(f.abs, text);
      const id = existingId(text);
      if (id !== null) takenIds.add(id);
    }

    const aliases = statusAliases(config);
    let wouldChange = false;
    for (const f of targets) {
      const text = texts.get(f.abs)!;
      if (text instanceof Error) {
        ctx.err(`ltm fmt: ${f.rel}: ${firstLine(text.message)}\n`);
        failed = true;
        continue;
      }
      const result = formatRecordText(text, { folderType: f.type, statusAliases: aliases, takenIds });
      if ("reason" in result) {
        ctx.err(`ltm fmt: ${f.rel}: ${result.reason}\n`);
        failed = true;
        continue;
      }
      for (const w of result.warnings) ctx.err(`ltm fmt: warning: ${f.rel}: ${w}\n`);
      if (!result.changed) continue;
      if (ctx.values.check === true) {
        ctx.out(`${f.rel}\n`);
        wouldChange = true;
      } else {
        try {
          writeFileSync(f.abs, result.text);
        } catch (e) {
          ctx.err(`ltm fmt: ${f.rel}: ${firstLine((e as Error).message)}\n`);
          failed = true;
        }
      }
    }
    return failed || wouldChange ? 1 : 0;
  },
};
