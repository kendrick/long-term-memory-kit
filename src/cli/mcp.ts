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
const nonEmpty = (v: string | undefined): boolean => v !== undefined && v !== "";

async function serveHttp(ctx: CommandContext, spec: string): Promise<0 | 1> {
  const listen = parseListen(spec);
  // checkArgs already rejected anything parseListen refuses; the guard only narrows the type.
  if (listen === undefined) return 1;
  const { hostname, port } = listen;
  const loopback = isLoopback(hostname);
  // ADR 0007: ltm checks no tokens, so a non-loopback host needs a front door that authenticates callers.
  if (!loopback && ctx.values["trust-proxy-auth"] !== true) {
    ctx.err(`ltm mcp: --http ${spec} is not a loopback host; put a front door that authenticates callers in front of it, then pass --trust-proxy-auth\n`);
    return 1;
  }
  if (!nonEmpty(ctx.env.LTM_BANK_URL) && !nonEmpty(ctx.env.LTM_BANK_PATH)) {
    ctx.err("ltm mcp: --http needs LTM_BANK_URL or LTM_BANK_PATH; one HTTP server serves one Bank\n");
    return 1;
  }
  // Accepts any key `identityFromPath` can build from a checkout's origin, including GitLab subgroups and dotted orgs, so a `consumers` key that works for `ltm query` in a checkout also works here. The value isn't trimmed, because a stray newline from a shell-built `--env-vars` should stop the server and show the broken deploy config.
  const consumerRepo = nonEmpty(ctx.env.LTM_CONSUMER_REPO) ? ctx.env.LTM_CONSUMER_REPO : undefined;
  if (consumerRepo !== undefined && !/^[^\s/]+(?:\/[^\s/]+)+$/.test(consumerRepo)) {
    ctx.err(`ltm mcp: LTM_CONSUMER_REPO must be <org>/<repo>, got '${consumerRepo}'\n`);
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
        await createServer(ctx.env, ctx.cwd, { locator, consumerRepo }).connect(transport);
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
    return parseListen(String(values.http)) === undefined ? `invalid --http '${String(values.http)}' (expected [host:]port)` : undefined;
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
