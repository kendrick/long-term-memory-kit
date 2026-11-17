import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Exits 3 at the first call, which is --version, the same spot a binary that won't launch fails on the Windows runner.
const failingBin = () => {
  const dir = mkdtempSync(join(tmpdir(), "ltm-smoke-win-"));
  dirs.push(dir);
  const bin = join(dir, "ltm-windows-x64.exe");
  writeFileSync(bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  return bin;
};
// pwsh takes 2-3 s to start, which runs past bun's 5 s default once the full suite loads the machine.
const PWSH_TIMEOUT = 30_000;
const smoke = (bin: string) =>
  spawnSync("pwsh", ["-NoProfile", "-File", join(ROOT, "scripts/smoke-windows.ps1"), bin], { encoding: "utf8" });

// pwsh ships on ubuntu-latest and windows-latest, so CI runs these.
describe.skipIf(!Bun.which("pwsh"))("smoke-windows.ps1", () => {
  test("a missing binary exits 2", () => {
    const r = smoke(join(tmpdir(), "no-such-ltm.exe"));
    expect(r.status).toBe(2);
  }, PWSH_TIMEOUT);

  test("a binary that fails --version fails the smoke there", () => {
    const r = smoke(failingBin());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("smoke: FAIL --version");
    expect(r.stdout).not.toContain("smoke: PASS");
  }, PWSH_TIMEOUT);

  test("the no-runtime check passes before the binary runs", () => {
    const r = smoke(failingBin());
    expect(r.stdout).toContain("smoke: ok no-runtime");
  }, PWSH_TIMEOUT);
});
