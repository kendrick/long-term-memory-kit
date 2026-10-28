import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { scrubPaths } from "../../scripts/eval-plugin.js";

const ROOT = "/Users/me/repos/ltm";
const map: [string, string][] = [
  [ROOT, "."],
  ["/Users/me/repos/ltm-wt", "."],
  ["/private/tmp", "<tmp>"],
  ["/tmp", "<tmp>"],
  ["/var/folders/zz/abc/T", "<tmp>"],
  ["/private/var/folders/zz/abc/T", "<tmp>"],
  ["/Users/me", "~"],
];

describe("scrubPaths", () => {
  test("rewrites root, temp, and home paths anywhere in the tree", () => {
    const input = {
      cwd: ROOT,
      nested: [{ tracePath: "/private/tmp/e-abc/out/trace.jsonl" }],
      msg: `read ${ROOT}/evals/x and /var/folders/zz/abc/T/x`,
      home: "/Users/me/.config/ltm",
      "/tmp": "keys are untouched",
    };
    expect(scrubPaths(input, map)).toEqual({
      cwd: ".",
      nested: [{ tracePath: "<tmp>/e-abc/out/trace.jsonl" }],
      msg: "read ./evals/x and <tmp>/x",
      home: "~/.config/ltm",
      "/tmp": "keys are untouched",
    });
  });

  test("leaves non-path strings and look-alike prefixes byte-identical", () => {
    const same = ["hello world", "/tmpfoo/bar", "a/tmp/b", "/opt/ltm-other/x", "/Users/meow/x", "", "ratio 1/tmp"];
    expect(scrubPaths(same, map)).toEqual(same);
  });
});

describe("committed result", () => {
  test("carries no machine paths", () => {
    const text = readFileSync(new URL("../../evals/results/0.0.0/plugin-eval.json", import.meta.url), "utf8");
    for (const bad of ["/Users/", "/private/tmp", "/var/folders"]) expect(text).not.toContain(bad);
  });
});
