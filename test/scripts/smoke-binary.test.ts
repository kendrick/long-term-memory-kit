import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
// Darwin binaries only run on a Mac, and codesign only exists there.
const isMac = process.platform === "darwin";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// /usr/bin/true stands in for ltm: the smoke gets past codesign, then fails at `query`, which is all these tests need.
const fixture = (sign: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "ltm-smoke-"));
  dirs.push(dir);
  const bin = join(dir, "ltm-darwin-arm64");
  copyFileSync("/usr/bin/true", bin);
  chmodSync(bin, 0o755);
  const args = sign ? ["--force", "-s", "-"] : ["--remove-signature"];
  const r = spawnSync("codesign", [...args, bin]);
  expect(r.status).toBe(0);
  return bin;
};
const smoke = (bin: string) => spawnSync("bash", [join(ROOT, "scripts/smoke-binary.sh"), bin], { encoding: "utf8" });

describe.skipIf(!isMac)("smoke-binary.sh codesign check", () => {
  test("an unsigned darwin binary fails at the codesign step", () => {
    const r = smoke(fixture(false));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("smoke: FAIL codesign");
    expect(r.stdout).not.toContain("smoke: ok no-runtime");
  });

  test("an ad-hoc signed darwin binary gets past the codesign step", () => {
    const r = smoke(fixture(true));
    expect(r.stderr).not.toContain("FAIL codesign");
    expect(r.stdout).toContain("smoke: ok codesign");
    expect(r.stdout).toContain("smoke: ok no-runtime");
  });
});
