import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConfigError, findBank, loadConfig, type BankConfig } from "../core/bank.ts";
import { firstLine } from "../core/text.ts";
import type { CommandContext } from "./run.ts";

// A null line (unreadable file, non-mapping config) has no position to print, and yaml appends a multi-line code frame to its messages, so only the first line is the diagnosis.
export function configErrorLine(command: string, e: ConfigError): string {
  return `ltm ${command}: ${e.path}${e.line === null ? "" : `:${e.line}`}: ${firstLine(e.message)}\n`;
}

export function noBankLine(command: string, cwd: string): string {
  return `ltm ${command}: no memory-bank.yaml in ${cwd} or any parent directory\n`;
}

// Callers differ on what a missing Bank means (query resolves elsewhere, discover runs without one), so null goes back for them to decide.
export function locateBank(ctx: CommandContext, command: string): string | null | 1 {
  try {
    return findBank(ctx.cwd);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    ctx.err(configErrorLine(command, e));
    return 1;
  }
}

// A path names its Bank, not the cwd. A directory starts the walk at itself (so the Bank root works as a path); anything else starts at its dirname, so a missing file still finds its Bank.
export function locateBankFrom(ctx: CommandContext, command: string, paths: readonly string[]): string | 1 {
  let first: string | undefined;
  for (const p of paths) {
    const abs = resolve(ctx.cwd, p);
    let start = dirname(abs);
    try {
      if (statSync(abs).isDirectory()) start = abs;
    } catch {
      // Missing or unreadable: the dirname walk above stands.
    }
    let root: string | null;
    try {
      root = findBank(start);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      ctx.err(configErrorLine(command, e));
      return 1;
    }
    if (root === null) {
      ctx.err(noBankLine(command, start));
      return 1;
    }
    first ??= root;
    if (root !== first) {
      ctx.err(`ltm ${command}: paths span two Banks: ${first} and ${root}\n`);
      return 1;
    }
  }
  return first!;
}

export function loadBankAt(ctx: CommandContext, command: string, root: string): BankConfig | 1 {
  try {
    return loadConfig(root);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    ctx.err(configErrorLine(command, e));
    return 1;
  }
}

export function openBank(ctx: CommandContext, command: string): BankConfig | 1 {
  const root = locateBank(ctx, command);
  if (root === 1) return 1;
  if (root === null) {
    ctx.err(noBankLine(command, ctx.cwd));
    return 1;
  }
  return loadBankAt(ctx, command, root);
}
