import { describe, expect, test } from "bun:test";
import { defaultCommands } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/run.ts";

// A stub holds a planned command's slot in commands.ts so the lane that builds it edits
// only its own file. The table is whatever is still hidden, so a lane that ships its
// command (dropping `hidden`) needs no edit here.
const stubs = defaultCommands.filter((c) => c.hidden).map((c) => c.name);

describe("planned-command stubs", () => {
  test.each(stubs)("%s exits 1 and points at its issue", async (name) => {
    const r = await run({ argv: [name], cwd: "/", env: {} });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(new RegExp(`^ltm ${name}: not implemented yet \\(see #\\d+\\)\\n$`));
  });

  test("--help lists no hidden command", async () => {
    const r = await run({ argv: ["--help"], cwd: "/", env: {} });
    for (const name of stubs) expect(r.stdout).not.toMatch(new RegExp(`^  ${name}  `, "m"));
    expect(r.stdout).toMatch(/^  query  /m);
  });
});
