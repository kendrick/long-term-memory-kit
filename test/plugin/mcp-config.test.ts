import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { git } from "../helpers/git-bank.ts";
import { withDemoGitBank } from "../helpers/mcp.ts";

const MCP_TEST_TIMEOUT = 60_000;
const repo = new URL("../..", import.meta.url).pathname;
const bin = join(repo, "src/cli/bin.ts");

type Server = { command: string; args?: string[]; env?: Record<string, string> };
type Manifest = { userConfig: Record<string, { default?: unknown }>; mcpServers: Record<string, Server> };

// Mirrors Claude Code's substitution so the test exercises the declared strings, not a copy of them typed into the test.
function interpolate(s: string, userConfig: Record<string, string>, pluginData: string): string {
  const out = s
    .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, key: string) => {
      if (!(key in userConfig)) throw new Error(`${s} names user_config.${key}, which userConfig doesn't declare`);
      return userConfig[key]!;
    })
    .replaceAll("${CLAUDE_PLUGIN_DATA}", pluginData);
  if (out.includes("${")) throw new Error(`unsubstituted placeholder left in ${JSON.stringify(out)}`);
  return out;
}

describe("plugin.json mcpServers.ltm", () => {
  test(
    "starts through an `ltm` on PATH and serves the six tools from the configured Bank",
    () =>
      withDemoGitBank(async (bank) => {
        const manifest = JSON.parse(readFileSync(join(repo, ".claude-plugin/plugin.json"), "utf8")) as Manifest;
        const server = manifest.mcpServers.ltm!;
        // Start from the declared defaults so a default the server would reject (say, a TTL that isn't a whole number) fails here.
        const userConfig = Object.fromEntries(Object.entries(manifest.userConfig).map(([k, v]) => [k, String(v.default ?? "")]));
        userConfig.bank_path = bank;

        const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ltm-plugin-")));
        try {
          const shimDir = join(scratch, "bin");
          const pluginData = join(scratch, "data");
          const cwd = join(scratch, "cwd");
          for (const d of [shimDir, pluginData, cwd]) mkdirSync(d);
          writeFileSync(join(shimDir, "ltm"), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
          chmodSync(join(shimDir, "ltm"), 0o755);

          const env = Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, interpolate(v, userConfig, pluginData)]));
          const transport = new StdioClientTransport({
            command: interpolate(server.command, userConfig, pluginData),
            args: (server.args ?? []).map((a) => interpolate(a, userConfig, pluginData)),
            env: { ...(process.env as Record<string, string>), PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`, ...env },
            cwd,
          });
          const client = new Client({ name: "ltm-plugin-test", version: "0.0.0" });
          await client.connect(transport);
          try {
            const { tools } = await client.listTools();
            expect(tools.map((t) => t.name).sort()).toEqual(["facets", "head", "propose", "query", "read", "validate"]);
            // cwd holds no Bank, so this commit can only come from the env the manifest mapped bank_path into.
            const r = await client.callTool({ name: "query", arguments: {} });
            expect(r.isError ?? false).toBe(false);
            expect((r.structuredContent as { bank_commits: unknown }).bank_commits).toEqual({ acme: git(bank, "rev-parse", "HEAD").trim() });
          } finally {
            await client.close();
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }),
    MCP_TEST_TIMEOUT,
  );
});
