import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";

const root = new URL("../..", import.meta.url).pathname;
const demo = join(root, "fixtures/demo-bank");

describe("the demo Bank's generated files", () => {
  test("every grep in the AGENTS.md sh block matches at least one file", () => {
    const agents = readFileSync(join(demo, "AGENTS.md"), "utf8");
    const block = /```sh\n([\s\S]*?)```/.exec(agents);
    expect(block).not.toBeNull();
    const greps = block![1]!.split("\n").filter((l) => l.startsWith("grep "));
    expect(greps.length).toBeGreaterThan(0);
    for (const cmd of greps) {
      const r = spawnSync("sh", ["-c", cmd], { cwd: demo, encoding: "utf8" });
      expect({ cmd, status: r.status }).toEqual({ cmd, status: 0 });
      expect(r.stdout.trim()).not.toBe("");
    }
  });

  test("ltm init --check exits 0", async () => {
    const r = await run({ argv: ["init", "--check", demo], cwd: root, env: {} });
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("regen-reflowed.sh leaves fixtures/reflowed unchanged", () => {
    const diff = () => spawnSync("git", ["diff", "--exit-code", "fixtures/reflowed"], { cwd: root, encoding: "utf8" });
    const before = diff();
    const regen = spawnSync("bash", ["scripts/regen-reflowed.sh"], { cwd: root, encoding: "utf8" });
    expect(regen.status).toBe(0);
    const after = diff();
    // Compare to the pre-run state so an uncommitted regeneration doesn't fail locally; CI starts from a clean checkout.
    expect({ status: after.status, out: after.stdout }).toEqual({ status: before.status, out: before.stdout });
  }, 60_000);
});
