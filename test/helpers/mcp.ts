import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, IDENTITY } from "./git-bank.ts";

const bin = new URL("../../src/cli/bin.ts", import.meta.url).pathname;
const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;

// Spawns the real `ltm mcp` the way an agent host would, so the suite covers stdio framing as well as the handlers.
export async function withMcp<T>(env: Record<string, string | undefined>, cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const defined = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: defined, cwd });
  const client = new Client({ name: "ltm-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// A scratch copy of the demo Bank committed to its own repo, so bank_commits has a HEAD to report. `edit` lands in the seed commit, so a test can serve a broken Bank from a clean tree.
export async function withDemoGitBank<T>(fn: (root: string) => Promise<T>, edit?: (root: string) => void): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ltm-mcp-bank-")));
  try {
    cpSync(demo, root, { recursive: true });
    edit?.(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "add", "-A");
    git(root, ...IDENTITY, "commit", "--quiet", "-m", "seed");
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
