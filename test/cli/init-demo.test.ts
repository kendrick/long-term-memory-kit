import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { run } from "../../src/cli/run.ts";

const root = new URL("../..", import.meta.url).pathname;
const demo = join(root, "fixtures/demo-bank");

const funnel = (): string[] => {
  const block = /```sh\n([\s\S]*?)```/.exec(readFileSync(join(demo, "AGENTS.md"), "utf8"));
  if (!block) throw new Error("no sh block in AGENTS.md");
  return block[1]!.trimEnd().split("\n");
};

const tree = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .map((abs) => [relative(dir, abs), readFileSync(abs, "utf8")])
      .sort(([a], [b]) => a!.localeCompare(b!)),
  );

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

  // ltm isn't on PATH under test; the shell commands are the fallback an agent can always run.
  test("every non-ltm command in the sh block runs and prints something", () => {
    const cmds = funnel().filter((l) => !l.startsWith("ltm "));
    expect(cmds.some((l) => l.startsWith("head "))).toBe(true);
    expect(cmds.some((l) => l.startsWith("cat "))).toBe(true);
    for (const cmd of cmds) {
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

  // The script rewrites fixtures/reflowed under its own root, so it runs from a copy
  // outside every checkout and the committed trees are only read.
  test("regen-reflowed.sh reproduces the committed fixtures/reflowed", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ltm-regen-")));
    try {
      mkdirSync(join(tmp, "scripts"));
      cpSync(join(root, "scripts/regen-reflowed.sh"), join(tmp, "scripts/regen-reflowed.sh"));
      cpSync(demo, join(tmp, "fixtures/demo-bank"), { recursive: true });
      symlinkSync(join(root, "node_modules"), join(tmp, "node_modules"));
      const regen = spawnSync("bash", [join(tmp, "scripts/regen-reflowed.sh")], { encoding: "utf8" });
      expect({ status: regen.status, stderr: regen.stderr }).toEqual({ status: 0, stderr: "" });
      for (const tool of ["prettier", "oxfmt"]) {
        expect(tree(join(tmp, "fixtures/reflowed", tool))).toEqual(tree(join(root, "fixtures/reflowed", tool)));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
