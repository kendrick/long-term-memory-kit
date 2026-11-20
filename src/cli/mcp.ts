import { hostHeaderValidationResponse, localhostAllowedHostnames, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/server.ts";
import { BankLocator, parseTtl } from "../mcp/bank.ts";
import type { Command, CommandContext } from "./run.ts";

// Brackets come off an IPv6 host, because Bun.serve wants `::1`, not `[::1]`.
export function parseListen(spec: string): { hostname: string; port: number } | undefined {
  const m = /^(?:(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]\s/]+)):)?(\d{1,5})$/.exec(spec);
  if (m === null || Number(m[3]) > 65535) return undefined;
  return { hostname: m[1] ?? m[2] ?? "127.0.0.1", port: Number(m[3]) };
}

export const isLoopback = (hostname: string): boolean => hostname === "localhost" || hostname === "::1" || /^127\.\d+\.\d+\.\d+$/.test(hostname);

const urlHost = (hostname: string): string => (hostname.includes(":") ? `[${hostname}]` : hostname);
const set = (v: string | undefined): boolean => v !== undefined && v !== "";

async function serveHttp(ctx: CommandContext, spec: string): Promise<1> {
  const { hostname, port } = parseListen(spec) as { hostname: string; port: number };
  const loopback = isLoopback(hostname);
  // ADR 0007: ltm checks no tokens, so a non-loopback host needs a front door that authenticates callers.
  if (!loopback && ctx.values["trust-proxy-auth"] !== true) {
    ctx.err(`ltm mcp: --http ${spec} is not a loopback host; put a front door that authenticates callers in front of it, then pass --trust-proxy-auth\n`);
    return 1;
  }
  if (!set(ctx.env.LTM_BANK_URL) && !set(ctx.env.LTM_BANK_PATH)) {
    ctx.err("ltm mcp: --http needs LTM_BANK_URL or LTM_BANK_PATH; one HTTP server serves one Bank\n");
    return 1;
  }
  const locator = new BankLocator();
  const allowed = [...localhostAllowedHostnames(), urlHost(hostname)];
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname,
      port,
      // 255s is Bun's max. The default 10s drops the connection while the first query is still cloning the Bank.
      idleTimeout: 255,
      async fetch(req) {
        // The Host check stops a page in the developer's browser from reading the Bank through DNS rebinding. Off loopback the front door sets Host to its own FQDN, so the check would refuse every caller.
        const refused = loopback ? hostHeaderValidationResponse(req, allowed) : undefined;
        if (refused !== undefined) return refused;
        if (new URL(req.url).pathname !== "/mcp") return new Response("Not Found", { status: 404 });
        // A stateless transport throws on its second request, so each one gets its own server and transport.
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await createServer(ctx.env, ctx.cwd, { locator }).connect(transport);
        return transport.handleRequest(req);
      },
    });
  } catch (e) {
    ctx.err(`ltm mcp: can't listen on ${spec}: ${(e as Error).message}\n`);
    return 1;
  }
  // Straight to stderr: run() buffers ctx.err until the command returns, and this one never does.
  process.stderr.write(`ltm mcp: serving http://${urlHost(server.hostname ?? hostname)}:${server.port}/mcp\n`);
  // SIGTERM ends the process, which is what Container Apps sends.
  return new Promise(() => {});
}

export const mcp: Command = {
  name: "mcp",
  summary: "Serve the Bank to agents over MCP (stdio, or HTTP with --http)",
  options: {
    http: { type: "string", description: "Serve over Streamable HTTP on [host:]port; host defaults to 127.0.0.1" },
    "trust-proxy-auth": { type: "boolean", description: "Allow a non-loopback --http host; a front door must authenticate callers" },
  },
  checkArgs(_positionals, values) {
    if (values.http === undefined) return values["trust-proxy-auth"] === true ? "--trust-proxy-auth needs --http" : undefined;
    return parseListen(String(values.http)) === undefined ? `--http '${String(values.http)}' is not [host:]port` : undefined;
  },
  async run(ctx) {
    // Check before connecting. Once the transport owns stdout, a bad TTL could only surface as a per-request error.
    const ttl = parseTtl(ctx.env.LTM_BANK_TTL);
    if (typeof ttl !== "number") {
      ctx.err(`ltm mcp: ${ttl.error}\n`);
      return 1;
    }
    if (typeof ctx.values.http === "string") return serveHttp(ctx, ctx.values.http);
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
