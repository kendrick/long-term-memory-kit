import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homebrewFormula } from "../../scripts/homebrew-formula.ts";

const SCRIPT = new URL("../../scripts/homebrew-formula.ts", import.meta.url).pathname;
const h = (c: string) => c.repeat(64);
const HASH = { arm: h("a"), x64: h("b"), larm: h("c"), lx64: h("d"), win: h("e") };
const sums = (o: { darm?: string; extra?: boolean; reverse?: boolean; skip?: string } = {}) => {
  const lines = [
    `${o.darm ?? HASH.arm}  ltm-darwin-arm64`,
    `${HASH.x64}  ltm-darwin-x64`,
    `${HASH.larm}  ltm-linux-arm64`,
    `${HASH.lx64}  ltm-linux-x64`,
    `${HASH.win}  ltm-windows-x64.exe`,
  ].filter((l) => !o.skip || !l.endsWith(o.skip));
  if (o.extra) lines.push(`${h("f")}  ltm-windows-x64.exe`);
  if (o.reverse) lines.reverse();
  return `${lines.join("\n")}\n`;
};

// The platform's `sha256` and `url`, read from inside its os/arch block rather than found anywhere in the text.
const blockOf = (formula: string, os: string, arch: string) => {
  const m = new RegExp(`on_${os} do[\\s\\S]*?on_${arch} do\\n([\\s\\S]*?)\\n\\s*end`).exec(formula);
  if (!m) throw new Error(`no ${os}/${arch} block`);
  return { text: m[1]!, url: /url "([^"]+)"/.exec(m[1]!)![1]!, sha: /sha256 "([^"]*)"/.exec(m[1]!)![1]! };
};

const dir = mkdtempSync(join(tmpdir(), "ltm-formula-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });

describe("homebrewFormula", () => {
  const f = homebrewFormula("1.2.3", sums());
  const base = "https://github.com/kendrick/long-term-memory-kit/releases/download/v1.2.3";

  test("each block's url names its asset under the release tag", () => {
    expect(blockOf(f, "macos", "arm").url).toBe(`${base}/ltm-darwin-arm64`);
    expect(blockOf(f, "macos", "intel").url).toBe(`${base}/ltm-darwin-x64`);
    expect(blockOf(f, "linux", "arm").url).toBe(`${base}/ltm-linux-arm64`);
    expect(blockOf(f, "linux", "intel").url).toBe(`${base}/ltm-linux-x64`);
  });

  test("each block's sha256 is its own asset's line", () => {
    expect(blockOf(f, "macos", "arm").sha).toBe(HASH.arm);
    expect(blockOf(f, "macos", "intel").sha).toBe(HASH.x64);
    expect(blockOf(f, "linux", "arm").sha).toBe(HASH.larm);
    expect(blockOf(f, "linux", "intel").sha).toBe(HASH.lx64);
  });

  test("a leading v on the version is stripped", () => {
    expect(homebrewFormula("v1.2.3", sums())).toBe(f);
  });

  test("changing the darwin-arm64 hash moves only that block", () => {
    const g = homebrewFormula("1.2.3", sums({ darm: h("9") }));
    expect(blockOf(g, "macos", "arm").sha).toBe(h("9"));
    for (const [os, arch] of [["macos", "intel"], ["linux", "arm"], ["linux", "intel"]] as const) {
      expect(blockOf(g, os, arch)).toEqual(blockOf(f, os, arch));
    }
    expect(g.replace(h("9"), HASH.arm)).toBe(f);
  });

  test("reordering lines or adding a windows line leaves the output byte-identical", () => {
    expect(homebrewFormula("1.2.3", sums({ reverse: true }))).toBe(f);
    expect(homebrewFormula("1.2.3", sums({ extra: true }))).toBe(f);
    expect(homebrewFormula("1.2.3", sums({ skip: "ltm-windows-x64.exe" }))).toBe(f);
  });

  test("accepts shasum binary-mode lines", () => {
    expect(homebrewFormula("1.2.3", sums().replace(/  /g, " *"))).toBe(f);
  });
});

describe("homebrew-formula CLI", () => {
  test("prints the formula to stdout", () => {
    const p = join(dir, "SHA256SUMS");
    writeFileSync(p, sums());
    const r = run("1.2.3", p);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(homebrewFormula("1.2.3", sums()));
  });

  test("a missing asset exits 2 with one stderr line and no stdout", () => {
    const p = join(dir, "SHA256SUMS.short");
    writeFileSync(p, sums({ skip: "ltm-linux-arm64" }));
    const r = run("1.2.3", p);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("ltm-linux-arm64");
  });

  test("wrong arity exits 2", () => {
    expect(run("1.2.3").status).toBe(2);
    expect(run().status).toBe(2);
  });
});

const ruby = Bun.which("ruby");
// ruby ships with macOS but not every CI image; the syntax check is only meaningful where it exists.
(ruby ? test : test.skip)("generated formula passes ruby -c (skipped: ruby not on PATH)", () => {
  const p = join(dir, "ltm.rb");
  writeFileSync(p, homebrewFormula("1.2.3", sums()));
  const r = spawnSync(ruby!, ["-c", p], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});
