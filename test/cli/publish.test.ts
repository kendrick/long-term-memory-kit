import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish } from "../../src/cli/publish.ts";
import { run, type RunResult } from "../../src/cli/run.ts";

const TOKEN = "t0k";
type Hit = { method: string; path: string; raw: string; auth: string | null; body: string };
let hits: Hit[] = [];
let failName = "";
let server: ReturnType<typeof Bun.serve>;
let env: Record<string, string | undefined> = {};
let dir = "";
const outputs: RunResult[] = [];

const FILES: Record<string, string> = {
  "accepted.docx": "accepted bytes",
  "org-wide.docx": "org-wide bytes",
  "service_3aorder-service.docx": "order bytes",
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = new URL(req.url).pathname;
      const path = decodeURIComponent(raw);
      hits.push({ method: req.method, path, raw, auth: req.headers.get("authorization"), body: await req.text() });
      if (failName && path.endsWith(`/${failName}:/content`)) return new Response("nope", { status: 500 });
      return new Response("{}", { status: 200 });
    },
  });
  env = { LTM_GRAPH_TOKEN: TOKEN, LTM_GRAPH_BASE_URL: `http://127.0.0.1:${server.port}` };
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ltm-publish-")));
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(dir, name), body);
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

const ltm = async (argv: string[], e = env): Promise<RunResult> => {
  const res = await run({ argv, cwd: dir, env: e }, [publish]);
  outputs.push(res);
  return res;
};
const flags = ["--site", "s", "--drive", "d", "--path", "Digest"];

describe("ltm publish sharepoint", () => {
  test("sends one PUT per file to the site, drive, and folder, with the file as the body", async () => {
    const res = await ltm(["publish", "sharepoint", ...flags, dir]);
    expect(res.exitCode).toBe(0);
    expect(hits.map((h) => [h.method, h.path, h.body])).toEqual(
      Object.entries(FILES).map(([name, body]) => ["PUT", `/sites/s/drives/d/root:/Digest/${name}:/content`, body]),
    );
    expect(hits.every((h) => h.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(res.stdout).toBe(Object.keys(FILES).map((n) => `uploaded ${n}\n`).join(""));
  });

  test("a failed file still lets the others upload, exits 1, and names the failed path", async () => {
    failName = "org-wide.docx";
    const res = await ltm(["publish", "sharepoint", ...flags, dir]);
    expect(res.exitCode).toBe(1);
    expect(hits.map((h) => h.path)).toEqual(Object.keys(FILES).map((n) => `/sites/s/drives/d/root:/Digest/${n}:/content`));
    expect(res.stderr).toBe(`ltm publish sharepoint: failed ${join(dir, "org-wide.docx")}: HTTP 500\n`);
  });

  test("with LTM_GRAPH_TOKEN unset, exits 2 naming the variable and sends nothing", async () => {
    for (const token of [undefined, ""]) {
      const res = await ltm(["publish", "sharepoint", ...flags, dir], { ...env, LTM_GRAPH_TOKEN: token });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("LTM_GRAPH_TOKEN");
    }
    expect(hits).toEqual([]);
  });

  test("--dry-run needs no token, sends nothing, and prints each target URL", async () => {
    const res = await ltm(["publish", "sharepoint", ...flags, "--dry-run", dir], { ...env, LTM_GRAPH_TOKEN: undefined });
    expect(res.exitCode).toBe(0);
    expect(hits).toEqual([]);
    expect(res.stdout).toBe(
      Object.keys(FILES)
        .map((n) => `${env.LTM_GRAPH_BASE_URL}/sites/s/drives/d/root:/Digest/${n}:/content\n`)
        .join(""),
    );
  });

  test("an unknown target or a missing --site exits 2", async () => {
    expect((await ltm(["publish", "teams", ...flags, dir])).exitCode).toBe(2);
    expect((await ltm(["publish", "sharepoint", "--drive", "d", "--path", "Digest", dir])).exitCode).toBe(2);
    expect((await ltm(["publish", "sharepoint", "--site", "a/b", "--drive", "d", "--path", "Digest", dir])).exitCode).toBe(2);
    expect((await ltm(["publish", "sharepoint", ...flags, dir], { ...env, LTM_GRAPH_BASE_URL: "http://example.com" })).exitCode).toBe(2);
    expect(hits).toEqual([]);
  });

  test("a dot segment or backslash in --site, --drive, or --path exits 2 naming the flag and sends nothing", async () => {
    const base = (skip: string) => ["site", "drive", "path"].filter((f) => f !== skip).flatMap((f) => [`--${f}`, f === "path" ? "Digest" : f[0]!]);
    const rows: [string, string, string[]][] = [
      ["path", "../..", []],
      ["path", "../..", ["--dry-run"]],
      ["site", "..", []],
      ["site", "a\\b", []],
      ["path", "../x", []],
      ["path", "a/./b", []],
      ["path", "./Digest", []],
      ["path", "Digest/.", []],
      ["path", "x\\y", []],
      ["site", ".", []],
      ["drive", "..", []],
      ["drive", "a\\b", []],
      ["site", "%2e%2e", []],
      ["drive", ".%2E", []],
    ];
    for (const [flag, value, extra] of rows) {
      const res = await ltm(["publish", "sharepoint", ...base(flag), `--${flag}`, value, ...extra, dir]);
      expect([flag, value, res.exitCode]).toEqual([flag, value, 2]);
      expect(res.stderr).toContain(`--${flag}`);
      expect(res.stdout).toBe("");
    }
    expect(hits).toEqual([]);
  });

  test("dotted values that are not dot segments upload, and the fake gets the dry-run URL", async () => {
    const cases: [string, string][] = [
      ["v1.2/Digest", "/sites/s/drives/d/root:/v1.2/Digest/accepted.docx:/content"],
      ["..notes", "/sites/s/drives/d/root:/..notes/accepted.docx:/content"],
      ["a//b", "/sites/s/drives/d/root:/a/b/accepted.docx:/content"],
    ];
    for (const [path, first] of cases) {
      const args = ["publish", "sharepoint", "--site", "s", "--drive", "d", "--path", path, dir];
      const dry = await ltm([...args, "--dry-run"]);
      expect(dry.exitCode).toBe(0);
      hits = [];
      const res = await ltm(args);
      expect(res.exitCode).toBe(0);
      const expected = dry.stdout.trim().split("\n").map((l) => new URL(l).pathname);
      expect(hits.map((h) => h.raw)).toEqual(expected);
      expect(hits[0]!.path).toBe(first);
    }
  });

  test("a missing or empty dir exits 1 naming it", async () => {
    const missing = join(dir, "gone");
    const res = await ltm(["publish", "sharepoint", ...flags, missing]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(missing);
    const empty = await ltm(["publish", "sharepoint", ...flags, join(dir, "nested")]);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toBe(`ltm publish sharepoint: no files to upload in ${join(dir, "nested")}\n`);
    expect(hits).toEqual([]);
  });

  // Runs last so it sees every output the tests above produced.
  test("the token appears in no stdout or stderr", () => {
    expect(outputs.length).toBeGreaterThan(5);
    for (const { stdout, stderr } of outputs) {
      expect(stdout).not.toContain(TOKEN);
      expect(stderr).not.toContain(TOKEN);
    }
  });
});
