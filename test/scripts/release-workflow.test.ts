import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = new URL("../..", import.meta.url).pathname;
const text = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
const wf = parse(text, { logLevel: "error" });

describe("release.yml", () => {
  test("the GitHub Release needs the smokes and bench-gate but not npm, so a failed or skipped publish can't hold back the binaries", () => {
    expect(wf.jobs.release.needs).toEqual(expect.arrayContaining(["bench-gate", "smoke-linux", "smoke-macos"]));
    expect(wf.jobs.release.needs).not.toContain("npm");
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

  test("bench-gate always runs and blocks both the Release and npm, so nothing ships below the committed hit rate", () => {
    expect(wf.jobs).toHaveProperty("bench-gate");
    expect(wf.jobs["bench-gate"]).not.toHaveProperty("if");
    expect(wf.jobs.release.needs).toContain("bench-gate");
    expect(wf.jobs.npm.needs).toContain("bench-gate");
  });

  test("plugin-eval runs on tag pushes only and gates nothing", () => {
    expect(wf.jobs["plugin-eval"].if).toBe("github.event_name == 'push'");
    for (const job of Object.values(wf.jobs) as { needs?: string | string[] }[]) {
      expect([job.needs ?? []].flat()).not.toContain("plugin-eval");
    }
  });

  test("plugin-eval uploads its report last, even when the eval step fails", () => {
    const steps = wf.jobs["plugin-eval"].steps;
    const last = steps[steps.length - 1];
    expect(last.uses).toStartWith("actions/upload-artifact@");
    expect(last.if).toContain("always()");
    expect(last.with.path).not.toContain("*");
  });
});
