import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const root = new URL("../..", import.meta.url).pathname;
const demo = join(root, "fixtures/demo-bank");

const funnel = (): string[] => {
  const block = /```sh\n([\s\S]*?)```/.exec(readFileSync(join(demo, "AGENTS.md"), "utf8"));
  if (!block) throw new Error("no sh block in AGENTS.md");
  return block[1]!.trimEnd().split("\n");
};

const record = (id: string, facet: string, body: string): string =>
  `---\nschema: 1\nid: ${id}\nmemory_type: PolicyRule\ntitle: ${body}\nstatus: accepted\ndate: 2026-10-01\napplies_to: [${facet}]\n---\n\n${body}\n`;

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
    const greps = block![1]!.split("\n").filter((l) => l.startsWith("grep ") && !l.includes("| xargs"));
    expect(greps.length).toBeGreaterThan(0);
    for (const cmd of greps) {
      const r = spawnSync("sh", ["-c", cmd], { cwd: demo, encoding: "utf8" });
      expect({ cmd, status: r.status }).toEqual({ cmd, status: 0 });
      expect(r.stdout.trim()).not.toBe("");
    }
  });

  // ltm isn't on PATH under test; the shell commands are the fallback an agent can always run.
  test("every non-ltm command in the sh block runs and prints something", () => {
    const cmds = funnel().filter((l) => !l.includes("xargs -0 -r ltm"));
    expect(cmds.some((l) => l.includes("xargs -0 -r head"))).toBe(true);
    expect(cmds.some((l) => l.includes("xargs -0 -r cat"))).toBe(true);
    for (const cmd of cmds) {
      const r = spawnSync("sh", ["-c", cmd], { cwd: demo, encoding: "utf8" });
      expect({ cmd, status: r.status }).toEqual({ cmd, status: 0 });
      expect(r.stdout.trim()).not.toBe("");
    }
  });

  // #59: the read steps once globbed every PolicyRule instead of reading the files the grep matched.
  test("read steps print only the Records the facet grep matched", async () => {
    await withScratch(demo, async (dir) => {
      const policies = join(dir, "_memory/policy-rules");
      writeFileSync(join(policies, "scoped-in-aB3dE5gH7j.md"), record("aB3dE5gH7j", "service:order-service", "BODY-UNIQUE-TO-IN"));
      writeFileSync(join(policies, "scoped-out-kL9mN1pQ2r.md"), record("kL9mN1pQ2r", "service:other-service", "BODY-UNIQUE-TO-OUT"));
      const valid = await run({ argv: ["validate"], cwd: dir, env: {} });
      expect({ out: valid.stdout, code: valid.exitCode }).toEqual({ out: valid.stdout, code: 0 });

      const cli = `bun ${join(root, "src/cli/bin.ts")} `;
      const steps = readFileSync(join(dir, "AGENTS.md"), "utf8")
        .split("\n")
        .filter((l) => l.includes("| xargs -0 -r"))
        .map((l) => l.replace("xargs -0 -r ltm ", `xargs -0 -r ${cli}`));
      expect(steps).toHaveLength(3);
      const out = steps.map((cmd) => {
        const r = spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8" });
        expect({ cmd, status: r.status, stderr: r.stderr }).toEqual({ cmd, status: 0, stderr: "" });
        return r.stdout;
      });
      for (const o of out) {
        expect(o).not.toContain("scoped-out");
        expect(o).not.toContain("BODY-UNIQUE-TO-OUT");
      }
      const byTool = (tool: string) => out[steps.findIndex((c) => c.includes(`xargs -0 -r ${tool}`))]!;
      expect(byTool(cli)).toContain("scoped-in");
      expect(byTool("head -n 20")).toContain("scoped-in");
      expect(byTool("cat")).toContain("BODY-UNIQUE-TO-IN");
    });
  });

  // GNU xargs without -r runs the reader once with no paths on empty input, and `ltm head` then exits 2.
  // BSD xargs skips it anyway, so this only bites on Linux CI.
  test("read steps print nothing and exit 0 when no Record matches the facet", async () => {
    await withScratch(demo, async (dir) => {
      for (const f of readdirSync(join(dir, "_memory"), { recursive: true, withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        const p = join(f.parentPath, f.name);
        writeFileSync(p, readFileSync(p, "utf8").replaceAll("service:order-service", "service:elsewhere"));
      }
      const cli = `bun ${join(root, "src/cli/bin.ts")} `;
      const steps = readFileSync(join(dir, "AGENTS.md"), "utf8")
        .split("\n")
        .filter((l) => l.includes("| xargs -0 -r"))
        .map((l) => l.replace("xargs -0 -r ltm ", `xargs -0 -r ${cli}`));
      expect(steps).toHaveLength(3);
      for (const cmd of steps) {
        const r = spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8" });
        expect({ cmd, status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ cmd, status: 0, stdout: "", stderr: "" });
      }
    });
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
