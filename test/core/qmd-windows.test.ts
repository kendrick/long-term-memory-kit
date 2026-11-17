import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qmdBackend, qmdCommand, type Recall } from "../../src/core/qmd.ts";

// Batch files compare their args but never echo them, so a test can't pass by cmd.exe running injected text.
const WIN_QMD = [
  "@echo off",
  'if not "%~1"=="collection" goto ls',
  'if not "%~2"=="show" exit /b 1',
  'if not "%~3"=="decisions" exit /b 1',
  "echo Collection: decisions",
  "echo   Path:     %QMD_ROOT%",
  "exit /b 0",
  ":ls",
  'if not "%~1"=="ls" exit /b 1',
  'if not "%~2"=="decisions" exit /b 1',
  "exit /b 0",
  "",
].join("\r\n");
const INERT_QMD = "@exit /b 1\r\n";

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
const winBin = () => binWith(WIN_QMD);
const inertBin = () => binWith(INERT_QMD);
// cmd.exe needs these to start, and a real Windows env always carries them.
const winEnv = () => ({ SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, QMD_ROOT });

const RECALL: Recall = { backend: "qmd", mode: "search", collections: { Decision: "decisions" } };
const noWarn = (line: string) => {
  throw new Error(`unexpected warning: ${line}`);
};

test("windows tests run where CI expects them", () => {
  if (process.env.LTM_EXPECT_WINDOWS_TESTS === "1") expect(process.platform).toBe("win32");
});

test('qmdCommand stays "qmd" off Windows', () => {
  expect(qmdCommand({ PATH: "/usr/bin" }, "darwin")).toBe("qmd");
  expect(qmdCommand({ PATH: "/usr/bin" }, "linux")).toBe("qmd");
});

describe.skipIf(process.platform !== "win32")("qmd.cmd on Windows", () => {
  test("no qmd on PATH still reports qmd not found on PATH", () => {
    const empty = mkdtempSync(join(root, "empty-"));
    expect(qmdBackend(RECALL, bank, { ...winEnv(), PATH: empty }, noWarn).preflight()).toBe("qmd not found on PATH");
  });

  test("a qmd.cmd shim on Path (not PATH) resolves", () => {
    expect(qmdBackend(RECALL, bank, { ...winEnv(), Path: winBin() }, noWarn).preflight()).toBeNull();
  });

  test("a collection name with cmd metacharacters runs no command", () => {
    const marker = join(mkdtempSync(join(root, "marker-")), "pwned");
    const recall: Recall = { ...RECALL, collections: { Decision: `a&echo pwned>"${marker}"` } };
    const problem = qmdBackend(recall, bank, { ...winEnv(), PATH: inertBin() }, noWarn).preflight();
    expect(problem).toStartWith("recall.collections.Decision:");
    expect(existsSync(marker)).toBe(false);
  });

  test("qmd ls runs through the shim too", () => {
    const backend = qmdBackend(RECALL, bank, { ...winEnv(), Path: winBin() }, noWarn);
    const files = backend.indexed("decisions");
    expect(files).toBeInstanceOf(Set);
    expect(files.size).toBe(0);
  });
});
