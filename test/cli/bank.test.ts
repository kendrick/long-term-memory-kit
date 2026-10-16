import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";

const ltm = (cwd: string, argv: string[]) => run({ argv, cwd, env: {} });

async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ltm-bank-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const READING: string[][] = [["query"], ["facets"], ["fmt"], ["discover", "."]];

describe("Bank opening across commands", () => {
  test("a broken memory-bank.yaml gives every Bank-reading command one stderr shape", async () => {
    const tails: string[] = [];
    for (const argv of READING) {
      await inTemp(async (dir) => {
        const cfg = join(dir, "memory-bank.yaml");
        writeFileSync(cfg, "name: [unclosed\n");
        const r = await ltm(dir, argv);
        const prefix = `ltm ${argv[0]}: `;
        expect({ argv, exitCode: r.exitCode, stdout: r.stdout }).toEqual({ argv, exitCode: 1, stdout: "" });
        expect(r.stderr).toStartWith(`${prefix}${cfg}:2: `);
        // The path differs per mkdtemp dir, so compare what follows it.
        tails.push(r.stderr.slice(`${prefix}${cfg}`.length));
      });
    }
    expect(tails.length).toBe(READING.length);
    expect(new Set(tails).size).toBe(1);
  });

  for (const argv of [...READING, ["validate"]]) {
    test(`a symlinked memory-bank.yaml is refused by ltm ${argv.join(" ")}`, async () => {
      await inTemp(async (dir) => {
        await inTemp(async (elsewhere) => {
          const real = join(elsewhere, "real.yaml");
          writeFileSync(real, "schema: 1\nname: acme\n");
          const cfg = join(dir, "memory-bank.yaml");
          symlinkSync(real, cfg);
          const r = await ltm(dir, argv);
          expect(r).toEqual({
            exitCode: 1,
            stdout: "",
            stderr: `ltm ${argv[0]}: ${cfg}: memory-bank.yaml is a symlink, not followed\n`,
          });
        });
      });
    });
  }

  // query and discover are left out: neither fails without a Bank above cwd.
  for (const argv of [["facets"], ["fmt"], ["validate"]]) {
    test(`ltm ${argv[0]} outside any Bank names the directory it searched`, async () => {
      await inTemp(async (dir) => {
        const r = await ltm(dir, argv);
        expect(r).toEqual({
          exitCode: 1,
          stdout: "",
          stderr: `ltm ${argv[0]}: no memory-bank.yaml in ${dir} or any parent directory\n`,
        });
      });
    });
  }
});
