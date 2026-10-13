import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });

// #56: only a symlink the walk would have read as a Record (or descended into) is a skip.
// A non-.md symlink is ignored like a regular non-.md file, so it must not fail either command.
const cases: { name: string; link: (dir: string) => void; exit: 0 | 1; path: string }[] = [
  {
    name: "diagram.png -> /etc/hosts is ignored",
    link: (dir) => symlinkSync("/etc/hosts", join(dir, "_memory/decisions/diagram.png")),
    exit: 0,
    path: "_memory/decisions/diagram.png",
  },
  {
    name: "x.md -> a file is reported",
    link: (dir) => symlinkSync("/etc/hosts", join(dir, "_memory/decisions/x.md")),
    exit: 1,
    path: "_memory/decisions/x.md",
  },
  {
    name: "a symlinked directory is reported",
    link: (dir) => {
      mkdirSync(join(dir, "elsewhere"));
      symlinkSync(join(dir, "elsewhere"), join(dir, "_memory/decisions/linked-dir"));
    },
    exit: 1,
    path: "_memory/decisions/linked-dir",
  },
];

describe("symlinks beside Records (#56)", () => {
  for (const c of cases) {
    for (const cmd of [["fmt", "--check"], ["validate"]]) {
      test(`${cmd.join(" ")}: ${c.name}, exit ${c.exit}`, async () => {
        await withScratch(demo, async (dir) => {
          c.link(dir);
          const r = await ltm(dir, ...cmd);
          expect(r.exitCode).toBe(c.exit);
          // Tie the exit code to its cause. fmt reports on stderr, validate on stdout.
          const out = r.stdout + r.stderr;
          if (c.exit === 1) {
            expect(out).toContain(c.path);
            expect(out).toContain("symlink, not followed");
          } else expect(out).not.toContain("symlink, not followed");
        });
      });
    }
  }
});
