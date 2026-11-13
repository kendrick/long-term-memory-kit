import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../..", import.meta.url).pathname;
const launcher = join(repo, "bin/ltm-launch");
const version = (JSON.parse(readFileSync(join(repo, ".claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
// System dirs only, so the developer's own ltm can't stand in for the one under test.
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const asset = Bun.spawnSync(["sh", "-c", `. "${join(repo, "bin/ltm-fetch.sh")}" && ltm_asset`]).stdout.toString().trim();
const fakeBinary = `#!/bin/sh\necho "fetched $*"\n`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Release = { status?: number; sums?: string };

let scratch: string;
let pluginData: string;
let cacheDir: string;
let requests: string[];
let release: Release;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ltm-launch-")));
  pluginData = join(scratch, "data");
  cacheDir = join(pluginData, "bin");
  mkdirSync(pluginData);
  requests = [];
  release = {};
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (release.status) return new Response("nope", { status: release.status });
      if (path === `/v${version}/${asset}`) return new Response(fakeBinary);
      if (path === `/v${version}/SHA256SUMS`) return new Response(release.sums ?? `${sha256(fakeBinary)}  ${asset}\n`);
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function fakeLtmOnPath(reports: string): string {
  const dir = join(scratch, "path-bin");
  mkdirSync(dir);
  writeFileSync(join(dir, "ltm"), `#!/bin/sh\nif [ "$1" = --version ]; then echo "${reports}"; exit 0; fi\necho "path ltm $*"\n`);
  chmodSync(join(dir, "ltm"), 0o755);
  return dir;
}

// Async spawn: a sync one would block the event loop the local server answers on.
async function launch(extraPath?: string) {
  const proc = Bun.spawn(["bash", launcher, "mcp"], {
    env: {
      PATH: extraPath ? `${extraPath}:${SYSTEM_PATH}` : SYSTEM_PATH,
      HOME: scratch,
      CLAUDE_PLUGIN_DATA: pluginData,
      LTM_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

function cacheEntries(): string[] {
  return existsSync(cacheDir) ? readdirSync(cacheDir) : [];
}

describe("bin/ltm-launch", () => {
  test("the test host has a supported asset and no ltm on the system PATH", () => {
    expect(asset).toMatch(/^ltm-(darwin|linux)-(x64|arm64)$/);
    expect(Bun.which("ltm", { PATH: SYSTEM_PATH })).toBeNull();
  });

  test("runs an ltm on PATH that reports the plugin's version, with no request", async () => {
    const r = await launch(fakeLtmOnPath(version));
    expect(r).toEqual({ stdout: "path ltm mcp\n", stderr: "", code: 0 });
    expect(requests).toEqual([]);
    expect(cacheEntries()).toEqual([]);
  });

  test("runs an ltm on PATH that reports another version, with no request", async () => {
    const r = await launch(fakeLtmOnPath("9.9.9"));
    expect(r).toEqual({ stdout: "path ltm mcp\n", stderr: "", code: 0 });
    expect(requests).toEqual([]);
    expect(cacheEntries()).toEqual([]);
  });

  test("with no ltm on PATH, downloads, verifies and runs the Release binary, then reuses it", async () => {
    const first = await launch();
    expect(first).toEqual({ stdout: "fetched mcp\n", stderr: "", code: 0 });
    expect(requests.sort()).toEqual([`/v${version}/${asset}`, `/v${version}/SHA256SUMS`].sort());
    expect(cacheEntries()).toEqual([`ltm-${version}`]);
    expect(readFileSync(join(cacheDir, `ltm-${version}`), "utf8")).toBe(fakeBinary);

    const second = await launch();
    expect(second).toEqual({ stdout: "fetched mcp\n", stderr: "", code: 0 });
    expect(requests).toHaveLength(2);
  });

  test("a binary that doesn't match SHA256SUMS fails and leaves nothing in the cache", async () => {
    release.sums = `${sha256("something else")}  ${asset}\n`;
    const r = await launch();
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`ltm: checksum mismatch for ${asset}; see https://github.com/kendrick/long-term-memory-kit#install\n`);
    expect(requests).toHaveLength(2);
    expect(cacheEntries()).toEqual([]);
  });

  test("a 404 from the Release fails, names the URL, and leaves nothing in the cache", async () => {
    release.status = 404;
    const r = await launch();
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    // curl -S prints its own reason first (a 404 here, a DNS error in the field), so ours is the last line.
    expect(r.stderr.trimEnd().split("\n").at(-1)).toBe(
      `ltm: download failed: http://127.0.0.1:${server.port}/v${version}/${asset}; see https://github.com/kendrick/long-term-memory-kit#install`,
    );
    expect(requests).toEqual([`/v${version}/${asset}`]);
    expect(cacheEntries()).toEqual([]);
  });
});
