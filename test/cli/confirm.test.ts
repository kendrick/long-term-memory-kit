import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCommands } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));
const env = { LTM_TODAY: "2026-10-30" };
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env });

const H = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";
const B = "_memory/exceptions/search-service-plaintext-logs-bU2pR8aXf7.md";

const bytes = (dir: string, rel: string) => readFileSync(join(dir, rel));
const linesFor = (out: string, rel: string) => out.split("\n").filter((l) => l.startsWith(`${rel}: `));

describe("ltm confirm", () => {
  test("is registered right after accept, with deprecate after it", () => {
    const names = defaultCommands.map((c) => c.name);
    expect(names.slice(names.indexOf("accept"), names.indexOf("accept") + 3)).toEqual(["accept", "confirm", "deprecate"]);
  });

  test("falsifier: drops the stale-confirmed finding, keeps orphan, and adds only last_confirmed", async () => {
    await withScratch(demoBank, async (dir) => {
      const before = await ltm(dir, "doctor");
      expect(linesFor(before.stdout, H).map((l) => l.split(": ")[1])).toEqual(["stale-confirmed", "orphan"]);

      const r = await ltm(dir, "confirm", "hT5cY8dUa6");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${H}\n`);

      const after = await ltm(dir, "doctor");
      expect(linesFor(after.stdout, H).map((l) => l.split(": ")[1])).toEqual(["orphan"]);

      // Expected bytes come from the untouched fixture plus the one line, placed after `date` as the demo Bank's own confirmed Records place it.
      const original = readFileSync(join(demoBank, H), "utf8");
      expect(original).toContain("\ndate: 2026-04-22\n");
      expect(original).not.toContain("last_confirmed");
      expect(bytes(dir, H).toString("utf8")).toBe(original.replace("\ndate: 2026-04-22\n", "\ndate: 2026-04-22\nlast_confirmed: 2026-10-30\n"));

      const fmt = await ltm(dir, "fmt", "--check", H);
      expect(fmt.stderr).toBe("");
      expect(fmt.exitCode).toBe(0);
    });
  });

  test("falsifier: a Proposal named second refuses the whole run and leaves both files byte-identical", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await ltm(dir, "confirm", "hT5cY8dUa6", "bU2pR8aXf7");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`ltm confirm: ${B} is a Proposal; accept it with ltm accept\n`);
      expect(bytes(dir, H).equals(bytes(demoBank, H))).toBe(true);
      expect(bytes(dir, B).equals(bytes(demoBank, B))).toBe(true);
    });
  });

  test("takes a path as doctor prints it from the Bank root", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await ltm(dir, "confirm", H);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${H}\n`);
      expect(bytes(dir, H).toString("utf8")).toContain("\nlast_confirmed: 2026-10-30\n");
    });
  });

  test("resolves a relative path against a subfolder cwd", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await ltm(join(dir, "_memory/decisions"), "confirm", "adopt-message-queue-for-orders-hT5cY8dUa6.md");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${H}\n`);
      expect(bytes(dir, H).toString("utf8")).toContain("\nlast_confirmed: 2026-10-30\n");
      expect((await ltm(dir, "fmt", "--check", H)).exitCode).toBe(0);
    });
  });

  test("refuses a path that is not a Record in the Bank", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await ltm(dir, "confirm", "memory-bank.yaml");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("ltm confirm: memory-bank.yaml is not a Record in the Bank\n");
      expect(bytes(dir, "memory-bank.yaml").equals(bytes(demoBank, "memory-bank.yaml"))).toBe(true);
    });
  });

  test("a bad clock refuses before anything is written", async () => {
    await withScratch(demoBank, async (dir) => {
      const r = await run({ argv: ["confirm", "hT5cY8dUa6"], cwd: dir, env: { LTM_TODAY: "not-a-date" } });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toStartWith("ltm confirm: ");
      expect(bytes(dir, H).equals(bytes(demoBank, H))).toBe(true);
    });
  });

  test("confirming twice on the same day writes nothing the second time", async () => {
    await withScratch(demoBank, async (dir) => {
      expect((await ltm(dir, "confirm", "hT5cY8dUa6")).exitCode).toBe(0);
      const once = bytes(dir, H);
      const r = await ltm(dir, "confirm", "hT5cY8dUa6");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
      expect(bytes(dir, H).equals(once)).toBe(true);
    });
  });
});
