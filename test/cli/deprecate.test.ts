import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));
const env = { LTM_TODAY: "2026-10-30" };
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env });

const H = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";
const P = "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md";
const Y = "_memory/policy-rules/shared-sftp-for-partner-files-yF4kP7tNs2.md";

const bytes = (dir: string, rel: string) => readFileSync(join(dir, rel));

describe("ltm deprecate", () => {
  test("retires an accepted Record so doctor stops reporting it, and the file passes fmt --check", async () => {
    await withScratch(demoBank, async (dir) => {
      expect((await ltm(dir, "doctor")).stdout).toContain(`${H}: `);

      const r = await ltm(dir, "deprecate", "hT5cY8dUa6");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${H}\n`);

      expect((await ltm(dir, "doctor")).stdout).not.toContain(H);
      const original = readFileSync(join(demoBank, H), "utf8");
      expect(bytes(dir, H).toString("utf8")).toBe(original.replace("\nstatus: accepted\n", "\nstatus: deprecated\n"));

      const fmt = await ltm(dir, "fmt", "--check", H);
      expect(fmt.stderr).toBe("");
      expect(fmt.exitCode).toBe(0);
    });
  });

  test("refuses a Proposal and writes nothing", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await ltm(dir, "deprecate", "pL2sG4nVq0");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`ltm deprecate: ${P} is a Proposal; accept it with ltm accept\n`);
      expect(bytes(dir, P).equals(bytes(demoBank, P))).toBe(true);
    });
  });

  test("refuses an already-deprecated Record, and an accepted one named with it stays unwritten", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await ltm(dir, "deprecate", "hT5cY8dUa6", "yF4kP7tNs2");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`ltm deprecate: ${Y} has status 'deprecated', not 'accepted'\n`);
      expect(bytes(dir, H).equals(bytes(demoBank, H))).toBe(true);
      expect(bytes(dir, Y).equals(bytes(demoBank, Y))).toBe(true);
    });
  });

  test("never reads the clock, so a bad LTM_TODAY does not block it", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await run({ argv: ["deprecate", "hT5cY8dUa6"], cwd: dir, env: { LTM_TODAY: "not-a-date" } });
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
    });
  });
});
