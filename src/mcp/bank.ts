import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../core/bank.ts";
import { redactRemote } from "../core/propose.ts";
import type { Env } from "../core/resolve.ts";
import { firstLine } from "../core/text.ts";

export type Picked = { root: string | null; notes: string[] };

const run = promisify(execFile);
const DEFAULT_TTL = 300;

export function parseTtl(v: string | undefined): number | { error: string } {
  if (v === undefined) return DEFAULT_TTL;
  if (!/^\d+$/.test(v)) return { error: `LTM_BANK_TTL '${v}' is not a whole number of seconds` };
  return Number(v);
}

const stderrOf = (e: unknown): string => {
  const err = e as { stderr?: string; message?: string };
  return firstLine((err.stderr || err.message || String(e)).trim());
};

// One locator per server: lastFetch and the in-flight map are what keep a remote to one fetch per TTL, so tests need fresh ones.
export class BankLocator {
  private readonly lastFetch = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  // Kept until a refresh succeeds. A failed refresh holds off retries for the whole TTL, and every answer in that window is just as stale.
  private readonly staleNote = new Map<string, string>();

  async pickBank(input: { bank?: string }, env: Env, cwd: string): Promise<Picked | { error: string }> {
    const path = env.LTM_BANK_PATH;
    const url = env.LTM_BANK_URL;
    const envPicks = (path !== undefined && path !== "") || (url !== undefined && url !== "");
    if (envPicks && input.bank !== undefined && input.bank !== "") {
      return { error: "bank can't be set while LTM_BANK_PATH or LTM_BANK_URL picks the Bank" };
    }
    if (path !== undefined && path !== "") return { root: resolve(cwd, path), notes: [] };
    if (url === undefined || url === "") return { root: null, notes: [] };

    const dataDir = env.LTM_DATA_DIR;
    if (dataDir === undefined || dataDir === "") return { error: "LTM_BANK_URL needs LTM_DATA_DIR" };
    const ttl = parseTtl(env.LTM_BANK_TTL);
    if (typeof ttl !== "number") return ttl;
    const root = join(resolve(cwd, dataDir), "banks", createHash("sha1").update(url).digest("hex"));
    // No prompt can be answered over stdio, so a credential-gated remote must fail rather than hang.
    const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0" } as NodeJS.ProcessEnv;

    let attempt = this.inFlight.get(url);
    if (attempt === undefined) {
      const last = this.lastFetch.get(url);
      // `>=` so TTL 0 refreshes even when two requests land in the same millisecond.
      const due = !existsSync(root) || last === undefined || Date.now() - last >= ttl * 1000;
      if (!due) return { root, notes: this.notesFor(url) };
      attempt = this.ensure(url, root, gitEnv).finally(() => this.inFlight.delete(url));
      this.inFlight.set(url, attempt);
    }
    try {
      await attempt;
    } catch (e) {
      return { error: (e as Error).message };
    }
    return { root, notes: this.notesFor(url) };
  }

  private notesFor(url: string): string[] {
    const note = this.staleNote.get(url);
    return note === undefined ? [] : [note];
  }

  private async ensure(url: string, root: string, env: NodeJS.ProcessEnv): Promise<void> {
    this.staleNote.delete(url);
    if (!existsSync(root)) {
      try {
        await run("git", ["clone", "--quiet", url, root], { env });
      } catch (e) {
        throw new Error(`can't clone ${redactRemote(url)}: ${redactRemote(stderrOf(e))}`);
      }
      this.lastFetch.set(url, Date.now());
      return;
    }
    // Fetch and merge run separately, never `git pull`: the tests count fetches through a PATH wrapper. The fast-forward is the only write the server makes to the clone.
    try {
      await run("git", ["-C", root, "fetch", "--quiet", "origin"], { env });
      await run("git", ["-C", root, "merge", "--ff-only", "--quiet", "@{u}"], { env });
    } catch (e) {
      const sha = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", env }).stdout.trim();
      this.staleNote.set(url, `can't refresh Bank from ${redactRemote(url)}: ${redactRemote(stderrOf(e))}; answering from ${sha}, which may be stale`);
    } finally {
      // Set after a failed attempt too, so an unreachable remote costs one try per TTL, not one per request.
      this.lastFetch.set(url, Date.now());
    }
  }
}

export function bankCommits(roots: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const root of roots) {
    out[bankName(root)] = headOf(root);
  }
  return out;
}

// Same naming rule as resolveBankFlag, but a root without a readable memory-bank.yaml falls back to its basename instead of throwing.
function bankName(root: string): string {
  try {
    const name = loadConfig(root).raw.name;
    if (typeof name === "string" && name !== "") return name;
  } catch {}
  return basename(root);
}

function headOf(root: string): string | null {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
