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

  test("scrubs a prefix after // or before a sentence-ending dot, but not before .name", () => {
    expect(scrubPaths(["file:///Users/me/x", "see /tmp.", "in /Users/me. Done", `at ${ROOT}.`, ], map)).toEqual([
      "file://~/x", "see <tmp>.", "in ~. Done", "at ..",
    ]);
    const same = ["/Users/me.config", "/tmp.d/x", "/Users/me-other", "-I/Users/me/inc"];
    expect(scrubPaths(same, map)).toEqual(same);
  });
});

describe("scrubPaths idempotence and URLs", () => {
  test("leaves already-scrubbed paths alone", () => {
    const same = ["~/tmp/x", "~/Users/me/x", "<tmp>/Users/me/x", "<tmp>/tmp/x", "./tmp/x", "./Users/me/x"];
    expect(scrubPaths(same, map)).toEqual(same);
  });

  test("leaves non-file URLs and scheme-less // paths alone", () => {
    const same = ["http://tmp/x", "https://tmp/x", "https://host/Users/me/x", "//tmp/x"];
    expect(scrubPaths(same, map)).toEqual(same);
  });

  test("$HOME/tmp/x becomes ~/tmp/x, and a second scrub changes nothing", () => {
    const once = scrubPaths("/Users/me/tmp/x", map);
    expect(once).toBe("~/tmp/x");
    expect(scrubPaths(once, map)).toBe("~/tmp/x");
  });

  test("scrub(scrub(s)) equals scrub(s) for every fixture string", () => {
    const all = [
      ROOT, `${ROOT}/evals/x`, `${ROOT}.`, "/private/tmp/e-abc/out/trace.jsonl", "/var/folders/zz/abc/T/x",
      "/Users/me/.config/ltm", "hello world", "/tmpfoo/bar", "a/tmp/b", "/opt/ltm-other/x", "/Users/meow/x", "", "ratio 1/tmp",
      "file:///Users/me/x", "see /tmp.", "in /Users/me. Done", "//tmp/x", "/Users/me.config", "/tmp.d/x",
      "/Users/me-other", "-I/Users/me/inc", "~/tmp/x", "~/Users/me/x", "http://tmp/x", "https://tmp/x",
      "https://host/Users/me/x", "/Users/me/tmp/x", "/tmp/tmp/x", "/tmp/Users/me/x", `${ROOT}/tmp/x`, `${ROOT}/Users/me/x`,
      "/Users/me/Users/me/x", "file:///tmp/x", "file:///tmp/tmp/x",
    ];
    for (const s of all) expect(scrubPaths(scrubPaths(s, map), map)).toBe(scrubPaths(s, map));
  });
});

describe("committed result", () => {
  test("carries no machine paths", () => {
    const text = readFileSync(new URL("../../evals/results/0.0.0/plugin-eval.json", import.meta.url), "utf8");
    for (const bad of ["/Users/", "/private/tmp", "/var/folders"]) expect(text).not.toContain(bad);
  });
});
