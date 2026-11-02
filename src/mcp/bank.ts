import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../core/bank.ts";
import { redactRemote } from "../core/propose.ts";
import type { Env } from "../core/resolve.ts";
import { firstLine } from "../core/text.ts";

export type Picked = { root: string | null; notes: string[] };

const run = promisify(execFile);
const DEFAULT_TTL = 300;
const BANK_CONFIG = "memory-bank.yaml";

// Mirrors findBank: a directory named memory-bank.yaml doesn't count, or locateBank() walks up to a parent Bank. A symlink does, so core refuses it with its own message.
const hasBankConfig = (root: string): boolean => {
  try {
    const s = lstatSync(join(root, BANK_CONFIG));
    return s.isFile() || s.isSymbolicLink();
  } catch {
    return false;
  }
};

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
  // Per-root readers-writer guard. `merge --ff-only` rewrites worktree files before it moves HEAD, so a read that overlaps it can pair new bytes with the old commit.
  private readonly readers = new Map<string, number>();
  private readonly merging = new Map<string, Promise<void>>();

  // Runs one read of `roots` while no merge touches them. fn must never call pickBank, because a refresh it starts would wait on this read forever.
  async reading<T>(roots: string[], fn: () => Promise<T>): Promise<T> {
    // No await between the last check and the increments, so no merge can start in that gap.
    for (let w = this.mergeOn(roots); w !== undefined; w = this.mergeOn(roots)) await w;
    for (const r of roots) this.readers.set(r, (this.readers.get(r) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const r of roots) {
        const n = (this.readers.get(r) ?? 1) - 1;
        if (n === 0) this.readers.delete(r);
        else this.readers.set(r, n);
      }
    }
  }

  private mergeOn(roots: string[]): Promise<void> | undefined {
    for (const r of roots) {
      const w = this.merging.get(r);
      if (w !== undefined) return w;
    }
    return undefined;
  }

  async pickBank(input: { bank?: string }, env: Env, cwd: string): Promise<Picked | { error: string }> {
    const path = env.LTM_BANK_PATH;
    const url = env.LTM_BANK_URL;
    const envPicks = (path !== undefined && path !== "") || (url !== undefined && url !== "");
    if (envPicks && input.bank !== undefined && input.bank !== "") {
      return { error: "bank can't be set while LTM_BANK_PATH or LTM_BANK_URL picks the Bank" };
    }
    if (path !== undefined && path !== "") {
      const root = resolve(cwd, path);
      // Without this, facets/validate/propose run the CLI with `root` as cwd and locateBank() walks up to a parent Bank.
      if (!hasBankConfig(root)) return { error: `LTM_BANK_PATH '${path}' has no ${BANK_CONFIG}` };
      return { root, notes: [] };
    }
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
      if (!due) return this.rooted(url, root);
      attempt = this.ensure(url, root, gitEnv).finally(() => this.inFlight.delete(url));
      this.inFlight.set(url, attempt);
    }
    try {
      await attempt;
    } catch (e) {
      return { error: (e as Error).message };
    }
    return this.rooted(url, root);
  }

  private rooted(url: string, root: string): Picked | { error: string } {
    if (!hasBankConfig(root)) return { error: `${redactRemote(url)} has no ${BANK_CONFIG} at its root` };
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
    // Fetch and merge run separately, never `git pull`: the tests count fetches through a PATH wrapper. The fast-forward is the server's only write to the worktree, so it alone takes the guard's write side. Fetch writes only under .git/, which no tool reads.
    try {
      await run("git", ["-C", root, "fetch", "--quiet", "origin"], { env });
      // Set before the drain, so new reads queue behind the merge and a steady stream of them can't hold it off for good.
      const done = Promise.withResolvers<void>();
      this.merging.set(root, done.promise);
      try {
        // shortcut: polls every 10ms with no timeout, so one hung read wedges this refresh and every read queued behind it. Reads are in-process file reads, and a timeout would reopen the race. Switch to a wake-up callback if the polling latency shows, and rethink the wait if a read ever goes over the network.
        while ((this.readers.get(root) ?? 0) > 0) await new Promise((r) => setTimeout(r, 10));
        await run("git", ["-C", root, "merge", "--ff-only", "--quiet", "@{u}"], { env });
      } finally {
        this.merging.delete(root);
        done.resolve();
      }
    } catch (e) {
      const sha = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", env }).stdout.trim();
      this.staleNote.set(url, `can't refresh Bank from ${redactRemote(url)}: ${redactRemote(stderrOf(e))}; answering from ${sha}, which may be stale`);
    } finally {
      // Set after a failed attempt too, so an unreachable remote costs one try per TTL, not one per request.
      this.lastFetch.set(url, Date.now());
    }
  }
}

// Keyed by the caller's names, which must be the ones `ltm query` puts in each row's `bank`. Two Banks can share a memory-bank.yaml `name`, so deriving it here would let one overwrite the other.
export function bankCommits(banks: { name: string; root: string }[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const { name, root } of banks) out[name] = headOf(root);
  return out;
}

// Naming for roots no resolver named (env picks, the clone, a Bank found from cwd). Same rule as resolveBankFlag, but a root without a readable memory-bank.yaml falls back to its basename instead of throwing.
export function namedRoot(root: string): { name: string; root: string } {
  try {
    const name = loadConfig(root).raw.name;
    if (typeof name === "string" && name !== "") return { name, root };
  } catch {}
  return { name: basename(root), root };
}

function headOf(root: string): string | null {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
