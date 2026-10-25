import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
// The fake platform binary is a /bin/sh script, so Windows has nothing to run.
const runnable = process.platform !== "win32" && Bun.which("node") !== null;

let dir: string;
let shim: string;
let binary: string;
const pidFile = () => join(dir, "child.pid");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(25);
  return ok();
};
// Deletes the PID file first so a test never reads the PID an earlier test's child wrote.
const startShim = (args: string[]) => {
  rmSync(pidFile(), { force: true });
  const p = spawn("node", [shim, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  const ended = new Promise<{ code: number | null; signal: string | null }>((res) => p.on("exit", (code, signal) => res({ code, signal })));
  return { p, ended };
};

describe.skipIf(!runnable)("npm shim", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ltm-shim-"));
    const main = join(dir, "node_modules/@fake/ltm");
    const plat = join(dir, `node_modules/@fake/ltm-${process.platform}-${process.arch}`);
    mkdirSync(join(main, "bin"), { recursive: true });
    mkdirSync(join(plat, "bin"), { recursive: true });
    writeFileSync(join(main, "package.json"), JSON.stringify({ name: "@fake/ltm" }));
    writeFileSync(join(plat, "package.json"), JSON.stringify({ name: `@fake/ltm-${process.platform}-${process.arch}` }));
    shim = join(main, "bin/ltm.js");
    // LTM_SHIM_SRC points a run at another shim version, to prove the test can fail.
    copyFileSync(process.env.LTM_SHIM_SRC ?? join(ROOT, "npm/ltm/bin/ltm.js"), shim);
    binary = join(plat, "bin/ltm");
    writeFileSync(
      binary,
      `#!/bin/sh
case "$1" in
  exit) printf '%s\\n' "$*" > '${join(dir, "argv")}'; exit "$2" ;;
  wait) echo $$ > '${pidFile()}'; exec sleep 60 ;;
  selfterm) kill -TERM $$ ;;
esac
`,
    );
    chmodSync(binary, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("passes argv and the exit code through", () => {
    const r = spawnSync("node", [shim, "exit", "42", "extra"]);
    expect(r.status).toBe(42);
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("exit 42 extra");
  });

  test("SIGTERM to the shim reaches the child and the shim ends by SIGTERM", async () => {
    const { p, ended } = startShim(["wait"]);
    expect(await until(() => existsSync(pidFile()) && readFileSync(pidFile(), "utf8").trim() !== "")).toBe(true);
    const childPid = Number(readFileSync(pidFile(), "utf8"));
    p.kill("SIGTERM");
    const { signal } = await ended;
    expect(await until(() => !alive(childPid))).toBe(true);
    expect(signal).toBe("SIGTERM");
  });

  test("a child killed by SIGTERM makes the shim end by SIGTERM", async () => {
    const { signal } = await startShim(["selfterm"]).ended;
    expect(signal).toBe("SIGTERM");
  });
});
