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
