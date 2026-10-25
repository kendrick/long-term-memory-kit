import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run } from "../../src/cli/run.ts";

// Read independently of run's own import so the test can't agree with itself.
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const base = { cwd: "/", env: {} };

test("--version prints the bare package version", async () => {
  expect(await run({ argv: ["--version"], ...base })).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
});

test("--version --json adds the declared schema versions", async () => {
  const r = await run({ argv: ["--version", "--json"], ...base });
  expect(r).toEqual({ exitCode: 0, stdout: `{"version":"${version}","schemas":[1]}\n`, stderr: "" });
});

test("--version rejects any other argument", async () => {
  expect(await run({ argv: ["--version", "--bogus"], ...base })).toEqual({
    exitCode: 2,
    stdout: "",
    stderr: "ltm: unexpected argument '--bogus'\n",
  });
  expect((await run({ argv: ["--version", "--json", "x"], ...base })).exitCode).toBe(2);
});
