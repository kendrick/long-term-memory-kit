import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPH_BASE, graphBase, listUploads, uploadAll, uploadUrl } from "../../src/core/sharepoint.ts";

const token = "s3cr3t-t0k";

type Hit = { method: string; path: string; auth: string | null; body: Uint8Array };
let hits: Hit[] = [];
let failName = "";
let server: ReturnType<typeof Bun.serve>;
let base = "";
let dir = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const auth = req.headers.get("authorization");
      hits.push({ method: req.method, path, auth, body: new Uint8Array(await req.arrayBuffer()) });
      // Echo the token back in both body and statusText so a reason built from either would leak it.
      if (failName && path.endsWith(`/${failName}:/content`)) return new Response(`bad ${auth}`, { status: 500, statusText: `${auth}` });
      return new Response("{}", { status: 200 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  dir = mkdtempSync(join(tmpdir(), "ltm-sharepoint-"));
  writeFileSync(join(dir, "accepted.docx"), new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]));
  writeFileSync(join(dir, "org-wide.docx"), "org-wide bytes");
  writeFileSync(join(dir, "service_3aorder-service.docx"), "order bytes");
  writeFileSync(join(dir, ".DS_Store"), "skip me");
  mkdirSync(join(dir, "nested"));
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  hits = [];
  failName = "";
});

const opts = () => ({ base, token, site: "s", drive: "d", folder: "Digest/acme", dir, names: listUploads(dir) });

describe("uploadUrl", () => {
  test("builds the Graph path-addressed upload URL", () => {
    expect(uploadUrl(GRAPH_BASE, "s", "d", "Digest/acme", "service_3aorder-service.docx")).toBe(
      "https://graph.microsoft.com/v1.0/sites/s/drives/d/root:/Digest/acme/service_3aorder-service.docx:/content",
    );
    expect(uploadUrl(GRAPH_BASE, "s", "d", "Team Digest", "a.docx")).toBe(
      "https://graph.microsoft.com/v1.0/sites/s/drives/d/root:/Team%20Digest/a.docx:/content",
    );
  });
});

describe("listUploads", () => {
  test("returns regular non-dot files in code-unit order", () => {
    expect(listUploads(dir)).toEqual(["accepted.docx", "org-wide.docx", "service_3aorder-service.docx"]);
  });

  test("throws on a missing dir", () => {
    expect(() => listUploads(join(dir, "nope"))).toThrow();
  });
});

describe("uploadAll", () => {
  test("sends one PUT per name with the bearer token and the file's bytes", async () => {
    const res = await uploadAll(opts());
    expect(res).toEqual({ sent: ["accepted.docx", "org-wide.docx", "service_3aorder-service.docx"], failed: [] });
    expect(hits.map((h) => [h.method, h.path, h.auth])).toEqual([
      ["PUT", "/sites/s/drives/d/root:/Digest/acme/accepted.docx:/content", `Bearer ${token}`],
      ["PUT", "/sites/s/drives/d/root:/Digest/acme/org-wide.docx:/content", `Bearer ${token}`],
      ["PUT", "/sites/s/drives/d/root:/Digest/acme/service_3aorder-service.docx:/content", `Bearer ${token}`],
    ]);
    expect([...hits[0]!.body]).toEqual([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    expect(new TextDecoder().decode(hits[2]!.body)).toBe("order bytes");
  });

  test("keeps uploading past a failed name and records its status", async () => {
    failName = "org-wide.docx";
    const res = await uploadAll(opts());
    expect(hits.map((h) => h.path)).toEqual([
      "/sites/s/drives/d/root:/Digest/acme/accepted.docx:/content",
      "/sites/s/drives/d/root:/Digest/acme/org-wide.docx:/content",
      "/sites/s/drives/d/root:/Digest/acme/service_3aorder-service.docx:/content",
    ]);
    expect(res.sent).toEqual(["accepted.docx", "service_3aorder-service.docx"]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.name).toBe("org-wide.docx");
    expect(res.failed[0]!.reason).toContain("500");
  });

  test("no reason carries the token, whether the server echoes it or the connection fails", async () => {
    failName = "accepted.docx";
    const echoed = await uploadAll(opts());
    // Port 1 on loopback refuses the connection, so fetch throws.
    const refused = await uploadAll({ ...opts(), base: "http://127.0.0.1:1" });
    const reasons = [...echoed.failed, ...refused.failed].map((f) => f.reason);
    expect(echoed.failed).toHaveLength(1);
    expect(refused.failed).toHaveLength(3);
    for (const r of reasons) expect(r).not.toContain(token);
  });
});

describe("graphBase", () => {
  test.each([
    [{}, GRAPH_BASE],
    [{ LTM_GRAPH_BASE_URL: "https://x" }, "https://x"],
    [{ LTM_GRAPH_BASE_URL: "http://127.0.0.1:1234" }, "http://127.0.0.1:1234"],
    [{ LTM_GRAPH_BASE_URL: "http://localhost:1" }, "http://localhost:1"],
  ])("accepts %j", (env, want) => {
    expect(graphBase(env)).toBe(want);
  });

  test("rejects plain http off loopback, naming the variable", () => {
    const got = graphBase({ LTM_GRAPH_BASE_URL: "http://example.com" });
    expect(typeof got).toBe("object");
    expect((got as { error: string }).error).toContain("LTM_GRAPH_BASE_URL");
  });
});
