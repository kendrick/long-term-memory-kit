import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/server.ts";
import { parseTtl } from "../mcp/bank.ts";
import type { Command } from "./run.ts";

export const mcp: Command = {
  name: "mcp",
  summary: "Serve the Bank to agents over stdio (MCP)",
  async run(ctx) {
    // Check before connecting. Once the transport owns stdout, a bad TTL could only surface as a per-request error.
    const ttl = parseTtl(ctx.env.LTM_BANK_TTL);
    if (typeof ttl !== "number") {
      ctx.err(`ltm mcp: ${ttl.error}\n`);
      return 1;
    }
    const transport = new StdioServerTransport();
    const closed = new Promise<void>((done) => {
      transport.onclose = done;
    });
    await createServer(ctx.env, ctx.cwd).connect(transport);
    // The transport closes itself when the client ends stdin.
    await closed;
    return 0;
  },
};
