import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../..", import.meta.url).pathname;
// System dirs only, so a real brew (or ltm) on the developer's PATH can't stand in for the fake.
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const asset = Bun.spawnSync(["sh", "-c", `. "${join(repo, "bin/ltm-fetch.sh")}" && ltm_asset`]).stdout.toString().trim();
const fakeBinary = `#!/bin/sh\necho "fetched $*"\n`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const TAGS = ["v9.9.9", "v1.2.3"];

type Release = { status?: number; sums?: string };

let buildDir: string;
let built: string;
let builtPath: string;
let scratch: string;
let dir: string;
let requests: string[];
let release: Release;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  buildDir = realpathSync(mkdtempSync(join(tmpdir(), "ltm-install-build-")));
  const r = Bun.spawnSync(["sh", join(repo, "scripts/build-install.sh"), "v9.9.9"]);
  if (r.exitCode !== 0) throw new Error(`build-install.sh failed: ${r.stderr.toString()}`);
  built = r.stdout.toString();
  builtPath = join(buildDir, "install.sh");
  writeFileSync(builtPath, built);
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ltm-install-")));
  dir = join(scratch, "my bin");
  requests = [];
  release = {};
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (release.status) return new Response("nope", { status: release.status });
      for (const tag of TAGS) {
        if (path === `/${tag}/${asset}`) return new Response(fakeBinary);
        if (path === `/${tag}/SHA256SUMS`) return new Response(release.sums ?? `${sha256(fakeBinary)}  ${asset}\n`);
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function fakeBrew(exitCode = 0): string {
  const brewDir = join(scratch, "brew-bin");
  mkdirSync(brewDir);
  writeFileSync(join(brewDir, "brew"), `#!/bin/sh\necho "$*" >> "${join(scratch, "brew.log")}"\nexit ${exitCode}\n`);
  chmodSync(join(brewDir, "brew"), 0o755);
  return brewDir;
}

type Run = { argv?: string[]; stdin?: string | null; env?: Record<string, string>; extraPath?: string; path?: string };

// Async spawn: a sync one would block the event loop the local server answers on.
// Defaults to `sh -s` with the built script on stdin, the way `curl … | sh` runs it.
async function install({ argv = ["sh", "-s"], stdin = built, env = {}, extraPath, path = SYSTEM_PATH }: Run = {}) {
  const proc = Bun.spawn(argv, {
    env: {
      PATH: extraPath ? `${extraPath}:${path}` : path,
      HOME: scratch,
      LTM_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}`,
      ...env,
    },
    stdin: stdin === null ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

function entries(d: string): string[] {
  return existsSync(d) ? readdirSync(d) : [];
}

function expectInstalled(r: { code: number; stderr: string }, target: string, tag = "v9.9.9") {
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  const ltm = join(target, "ltm");
  expect(statSync(ltm).mode & 0o111).not.toBe(0);
  expect(Bun.spawnSync([ltm, "x"]).stdout.toString()).toBe("fetched x\n");
  expect(requests).toEqual([`/${tag}/${asset}`, `/${tag}/SHA256SUMS`]);
}

describe("install.sh", () => {
  test("the test host has a supported asset and no brew on the system PATH", () => {
    expect(asset).toMatch(/^ltm-(darwin|linux)-(x64|arm64)$/);
    expect(Bun.which("brew", { PATH: SYSTEM_PATH })).toBeNull();
  });

  test("1: with brew on PATH, hands off to brew install and makes no request", async () => {
    const r = await install({ extraPath: fakeBrew(), env: { LTM_INSTALL_DIR: dir } });
    expect(r.code).toBe(0);
    expect(readFileSync(join(scratch, "brew.log"), "utf8")).toBe("install kendrick/tap/ltm\n");
    expect(requests).toEqual([]);
    expect(entries(dir)).toEqual([]);
  });

  test("1b: a failing brew's exit status is the script's", async () => {
    const r = await install({ extraPath: fakeBrew(7) });
    expect(r.code).toBe(7);
    expect(readFileSync(join(scratch, "brew.log"), "utf8")).toBe("install kendrick/tap/ltm\n");
    expect(requests).toEqual([]);
  });

  test("2: with no brew, downloads, verifies and installs ltm in LTM_INSTALL_DIR", async () => {
    const r = await install({ env: { LTM_INSTALL_DIR: dir } });
    expectInstalled(r, dir);
    expect(r.stdout).toContain(`ltm: installed v9.9.9 to ${dir}/ltm\n`);
  });

  test("3: falsifier: with no brew, a Homebrew-looking install dir still gets the downloaded binary", async () => {
    const target = join(scratch, "opt/homebrew/bin");
    const r = await install({ env: { LTM_INSTALL_DIR: target } });
    expectInstalled(r, target);
  });

  test("4: LTM_VERSION overrides the stamped tag", async () => {
    const r = await install({ env: { LTM_INSTALL_DIR: dir, LTM_VERSION: "v1.2.3" } });
    expectInstalled(r, dir, "v1.2.3");
  });

  test("5: a mismatched SHA256SUMS fails with one line and leaves no ltm or temp file", async () => {
    release.sums = `${sha256("something else")}  ${asset}\n`;
    const r = await install({ env: { LTM_INSTALL_DIR: dir } });
    expect(r.code).not.toBe(0);
    expect(r.stderr.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.stderr).toContain("checksum mismatch");
    expect(entries(dir)).toEqual([]);
  });

  test("6: a mismatch leaves an existing ltm byte-for-byte unchanged", async () => {
    mkdirSync(dir);
    writeFileSync(join(dir, "ltm"), "old");
    release.sums = `${sha256("something else")}  ${asset}\n`;
    const r = await install({ env: { LTM_INSTALL_DIR: dir } });
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(dir, "ltm"), "utf8")).toBe("old");
    expect(entries(dir)).toEqual(["ltm"]);
  });

  test("7: a 404 fails, names the URL, and leaves no ltm", async () => {
    release.status = 404;
    const r = await install({ env: { LTM_INSTALL_DIR: dir } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`download failed: http://127.0.0.1:${server.port}/v9.9.9/${asset}`);
    expect(entries(dir)).not.toContain("ltm");
  });

  test("8: prints the PATH line only when the install dir isn't on PATH", async () => {
    const off = await install({ env: { LTM_INSTALL_DIR: dir } });
    expect(off.code).toBe(0);
    expect(off.stdout.trimEnd().split("\n").at(-1)).toContain(`export PATH="${dir}:$PATH"`);

    rmSync(dir, { recursive: true });
    const on = await install({ env: { LTM_INSTALL_DIR: dir }, path: `${SYSTEM_PATH}:${dir}` });
    expect(on.code).toBe(0);
    expect(on.stdout).not.toContain("export PATH");
  });

  test("9: the unstamped repo install.sh refuses to guess a tag and makes no request", async () => {
    const r = await install({ argv: ["sh", join(repo, "install.sh")], stdin: null, env: { LTM_INSTALL_DIR: dir } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("set LTM_VERSION");
    expect(requests).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test("10: the build inlines ltm-fetch.sh, stamps the tag, and needs a tag", () => {
    expect(built).not.toContain("@ltm-fetch.sh@");
    expect(built).not.toContain("@LTM_TAG@");
    expect(built).toContain("ltm_fetch()");
    expect(built).toContain("LTM_TAG=v9.9.9");
    const r = Bun.spawnSync(["sh", join(repo, "scripts/build-install.sh")]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("usage");
  });

  test("11: the built script run as a file installs the same way", async () => {
    const r = await install({ argv: ["sh", builtPath], stdin: null, env: { LTM_INSTALL_DIR: dir } });
    expectInstalled(r, dir);
  });

  const dash = Bun.which("dash");
  test.skipIf(!dash)("12: under dash -s, installs the same way", async () => {
    const r = await install({ argv: [dash as string, "-s"], env: { LTM_INSTALL_DIR: dir } });
    expectInstalled(r, dir);
  });

  test("13: sh -n passes on install.sh, build-install.sh and the built output", () => {
    for (const f of [join(repo, "install.sh"), join(repo, "scripts/build-install.sh"), builtPath]) {
      const r = Bun.spawnSync(["sh", "-n", f]);
      expect({ f, code: r.exitCode, stderr: r.stderr.toString() }).toEqual({ f, code: 0, stderr: "" });
    }
  });

  const shellcheck = Bun.which("shellcheck");
  test.skipIf(!shellcheck)("13: shellcheck -s sh passes on install.sh, build-install.sh and the built output", () => {
    for (const f of [join(repo, "install.sh"), join(repo, "scripts/build-install.sh"), builtPath]) {
      const r = Bun.spawnSync([shellcheck as string, "-s", "sh", f]);
      expect({ f, code: r.exitCode, out: r.stdout.toString() }).toEqual({ f, code: 0, out: "" });
    }
  });
});
