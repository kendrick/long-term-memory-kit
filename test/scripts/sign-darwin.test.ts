import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../../scripts/sign-darwin.sh", import.meta.url).pathname;

let dir: string;
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
const sign = () => run("bash", [SCRIPT, dir]);
const verifies = (name: string) => run("codesign", ["--verify", "--strict", join(dir, name)]).status === 0;
const sums = () => readFileSync(join(dir, "SHA256SUMS"), "utf8");

// codesign only exists on macOS.
describe.skipIf(process.platform !== "darwin")("sign-darwin.sh", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ltm-sign-darwin-"));
    for (const name of ["ltm-darwin-arm64", "ltm-darwin-x64"]) {
      copyFileSync("/usr/bin/true", join(dir, name));
      chmodSync(join(dir, name), 0o755);
      expect(run("codesign", ["--remove-signature", name]).status).toBe(0);
    }
    copyFileSync("/usr/bin/false", join(dir, "ltm-linux-x64"));
    const r = run("shasum", ["-a", "256", "ltm-darwin-arm64", "ltm-darwin-x64", "ltm-linux-x64"]);
    writeFileSync(join(dir, "SHA256SUMS"), r.stdout);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const expectSignedAndSummed = (linuxBefore: string) => {
    expect(verifies("ltm-darwin-arm64")).toBe(true);
    expect(verifies("ltm-darwin-x64")).toBe(true);
    expect(run("shasum", ["-a", "256", "-c", "SHA256SUMS"]).status).toBe(0);
    const lines = sums().trim().split("\n");
    expect(lines.map((l) => l.split(/\s+/)[1]).sort()).toEqual(["ltm-darwin-arm64", "ltm-darwin-x64", "ltm-linux-x64"]);
    expect(lines).toContain(linuxBefore);
  };
  const linuxLine = () => sums().split("\n").find((l) => l.endsWith("ltm-linux-x64"))!;

  test("re-signs both darwin binaries so codesign --verify --strict passes", () => {
    expect(verifies("ltm-darwin-arm64")).toBe(false);
    expect(sign().status).toBe(0);
    expect(verifies("ltm-darwin-arm64")).toBe(true);
    expect(verifies("ltm-darwin-x64")).toBe(true);
  });

  test("rewrites SHA256SUMS over the re-signed bytes with the same file names", () => {
    const before = linuxLine();
    expect(sign().status).toBe(0);
    expectSignedAndSummed(before);
  });

  test("running it twice still passes", () => {
    const before = linuxLine();
    expect(sign().status).toBe(0);
    expect(sign().status).toBe(0);
    expectSignedAndSummed(before);
  });

  test("refuses a dist missing a darwin binary and signs nothing", () => {
    rmSync(join(dir, "ltm-darwin-x64"));
    const before = readFileSync(join(dir, "SHA256SUMS"));
    const r = sign();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("missing ltm-darwin-x64");
    expect(verifies("ltm-darwin-arm64")).toBe(false);
    expect(readFileSync(join(dir, "SHA256SUMS")).equals(before)).toBe(true);
  });
});
