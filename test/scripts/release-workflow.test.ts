import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = new URL("../..", import.meta.url).pathname;
const text = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
const wf = parse(text, { logLevel: "error" });

describe("release.yml", () => {
  test("the GitHub Release waits on npm, so a failed publish leaves no Release behind", () => {
    expect(wf.jobs.release.needs).toEqual(expect.arrayContaining(["npm", "smoke-linux", "smoke-macos"]));
    expect(wf.jobs.npm.needs).not.toContain("release");
  });

  test("workflow_dispatch declares no inputs and nothing mentions dry_run", () => {
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.on.workflow_dispatch ?? {}).not.toHaveProperty("inputs");
    expect(text).not.toContain("dry_run");
  });

  test("both publish paths gate on a push", () => {
    expect(wf.jobs.release.if).toBe("github.event_name == 'push'");
    const publish = wf.jobs.npm.steps.find((s: { name?: string }) => s.name === "Publish");
    expect(publish.if).toBe("github.event_name == 'push'");
  });
});
