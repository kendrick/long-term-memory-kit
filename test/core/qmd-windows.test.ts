import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { npmShimTarget, qmdBackend, qmdCommand, type Recall } from "../../src/core/qmd.ts";

// npm's cmd-shim (v6/v7) output for a node bin, byte for byte apart from the target.
const npmShim = (target: string, eol = "\r\n") =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join(eol);

// Compares its args but never echoes them, so a test can't pass by anything running injected text.
const FAKE_CLI = `const a = process.argv.slice(2);
const is = (...w) => a.length === w.length && w.every((x, i) => a[i] === x);
if (is("collection", "show", "decisions")) {
  process.stdout.write("Collection: decisions\\n  Path:     " + process.env.QMD_ROOT + "\\n");
  process.exit(0);
}
process.exit(is("ls", "decisions") ? 0 : 1);
`;

const root = mkdtempSync(join(tmpdir(), "ltm-qmdcmd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bank = join(root, "bank");
cpSync(join(import.meta.dir, "../../fixtures/demo-bank"), bank, { recursive: true });
const QMD_ROOT = join(bank, "_memory/decisions");

const binWith = (script: string) => {
  const dir = mkdtempSync(join(root, "bin-"));
  writeFileSync(join(dir, "qmd.cmd"), script);
  return dir;
};
const npmBin = () => {
  const dir = binWith(npmShim("node_modules\\fake-qmd\\cli.js"));
  mkdirSync(join(dir, "node_modules", "fake-qmd"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "fake-qmd", "cli.js"), FAKE_CLI);
  // `npm i -g` writes all three, and the extensionless sh script must never win over qmd.cmd.
  writeFileSync(join(dir, "qmd"), '#!/bin/sh\nexec node "$basedir/node_modules/fake-qmd/cli.js" "$@"\n');
  writeFileSync(join(dir, "qmd.ps1"), "#!/usr/bin/env pwsh\nexit 1\n");
  return dir;
};
// The shim's node comes from PATH, as on the runner, where no node.exe sits beside qmd.cmd.
const pathWith = (bin: string) => [bin, dirname(Bun.which("node")!)].join(delimiter);
// A real Windows env always carries these, and Bun.which reads PATHEXT.
const winEnv = () => ({ SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, QMD_ROOT });

const RECALL: Recall = { backend: "qmd", mode: "search", collections: { Decision: "decisions" } };
const noWarn = (line: string) => {
  throw new Error(`unexpected warning: ${line}`);
};

// describe.skipIf would report a non-Windows runner as all-green skips, so CI fails here instead.
test("the test-windows job really runs on Windows", () => {
  if (process.env.LTM_EXPECT_WINDOWS_TESTS === "1") expect(process.platform).toBe("win32");
});

test('qmdCommand stays "qmd" off Windows', () => {
  expect(qmdCommand({ PATH: "/usr/bin" }, "darwin")).toEqual({ file: "qmd", prefix: [] });
  expect(qmdCommand({ PATH: "/usr/bin" }, "linux")).toEqual({ file: "qmd", prefix: [] });
});

describe("npmShimTarget", () => {
  test("reads a scoped package's script from npm's shim, CRLF or LF", () => {
    const target = "node_modules\\@tobilu\\qmd\\dist\\qmd.js";
    expect(npmShimTarget(npmShim(target))).toBe(target);
    expect(npmShimTarget(npmShim(target, "\n"))).toBe(target);
  });

  test("reads an unscoped package's script", () => {
    expect(npmShimTarget(npmShim("node_modules\\fake-qmd\\cli.js"))).toBe("node_modules\\fake-qmd\\cli.js");
  });

  test("rejects a .cmd with no %dp0% target", () => {
    expect(npmShimTarget("@exit /b 1\r\n")).toBeNull();
    expect(npmShimTarget('@"C:\\tools\\qmd.exe" %*\r\n')).toBeNull();
  });

  test("rejects a shim whose runtime isn't node", () => {
    const sh = npmShim("node_modules\\x\\qmd.sh").replaceAll('SET "_prog=node"', 'SET "_prog=sh"');
    expect(npmShimTarget(sh)).toBeNull();
  });
});

describe.skipIf(process.platform !== "win32")("qmd.cmd on Windows", () => {
  test("no qmd on PATH still reports qmd not found on PATH", () => {
    const empty = mkdtempSync(join(root, "empty-"));
    expect(qmdBackend(RECALL, bank, { ...winEnv(), PATH: empty }, noWarn).preflight()).toBe("qmd not found on PATH");
  });

  test("a qmd.cmd shim on Path (not PATH) resolves", () => {
    expect(qmdBackend(RECALL, bank, { ...winEnv(), Path: pathWith(npmBin()) }, noWarn).preflight()).toBeNull();
  });

  test("the shim runs under node, not cmd.exe", () => {
    const cmd = qmdCommand({ ...winEnv(), PATH: pathWith(npmBin()) });
    if ("problem" in cmd) throw new Error(cmd.problem);
    expect(cmd.file).toMatch(/\\node\.exe$/i);
    expect(cmd.prefix).toHaveLength(1);
    // Bun.which may hand back the temp dir in another spelling, so match the tail and check the file is real.
    expect(cmd.prefix[0]).toMatch(/\\node_modules\\fake-qmd\\cli\.js$/);
    expect(existsSync(cmd.prefix[0]!)).toBe(true);
  });

  test("a collection name with cmd metacharacters runs no command", () => {
    const marker = join(mkdtempSync(join(root, "marker-")), "pwned");
    const recall: Recall = { ...RECALL, collections: { Decision: `a&echo pwned>"${marker}"` } };
    const problem = qmdBackend(recall, bank, { ...winEnv(), PATH: pathWith(npmBin()) }, noWarn).preflight();
    expect(problem).toStartWith("recall.collections.Decision:");
    expect(existsSync(marker)).toBe(false);
  });

  test("a %VAR% collection name reaches qmd unexpanded", () => {
    // cmd.exe expands %NAME% even inside quotes, and the fake knows only `decisions`, so expansion would make preflight pass.
    const recall: Recall = { ...RECALL, collections: { Decision: "%LTM_PCT_PROBE%" } };
    const env = { ...winEnv(), LTM_PCT_PROBE: "decisions", PATH: pathWith(npmBin()) };
    expect(qmdBackend(recall, bank, env, noWarn).preflight()).toStartWith("recall.collections.Decision:");
  });

  test("qmd ls runs through the shim too", () => {
    const backend = qmdBackend(RECALL, bank, { ...winEnv(), Path: pathWith(npmBin()) }, noWarn);
    const files = backend.indexed("decisions");
    expect(files).toBeInstanceOf(Set);
    expect(files.size).toBe(0);
  });

  test("a qmd.cmd that isn't an npm shim is named and never run", () => {
    const marker = join(mkdtempSync(join(root, "marker-")), "ran");
    const bin = binWith(`@echo ran>"${marker}"\r\n`);
    const problem = qmdBackend(RECALL, bank, { ...winEnv(), PATH: pathWith(bin) }, noWarn).preflight();
    expect(problem).toMatch(/\\qmd\.cmd is not an npm shim, and ltm won't run qmd through cmd\.exe$/i);
    expect(existsSync(marker)).toBe(false);
  });
});
