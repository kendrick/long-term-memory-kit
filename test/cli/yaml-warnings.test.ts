import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const bin = new URL("../../src/cli/bin.ts", import.meta.url).pathname;
const ADOPT = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";

// The yaml library warns through process.emitWarning after parse returns, so run() can't see it; only a spawned process shows it.
test.each<string[]>([["query", "--json", "id=hT5cY8dUa6"], ["validate"], ["fmt", "--check"]])(
  "ltm %s prints no yaml Warning: on a collection map key",
  async (...argv: string[]) => {
    await withScratch(demo, async (dir) => {
      const file = join(dir, ADOPT);
      const ls = readFileSync(file, "utf8").split("\n");
      ls.splice(ls.indexOf("---", 1), 0, "? [a]", ": x");
      writeFileSync(file, ls.join("\n"));

      const r = spawnSync(process.execPath, [bin, ...argv], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      expect(r.stderr.split("\n").filter((l) => l.startsWith("Warning:"))).toEqual([]);
    });
  },
  30_000,
);
