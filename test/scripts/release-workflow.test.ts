import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { homebrewFormula } from "../../scripts/homebrew-formula.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const text = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
const wf = parse(text, { logLevel: "error" });
const tmp = mkdtempSync(join(tmpdir(), "release-workflow-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let runs = 0;

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

  test("sign-macos re-signs the darwin binaries on a Mac after build", () => {
    const job = wf.jobs["sign-macos"];
    expect([job.needs].flat()).toContain("build");
    expect(job["runs-on"]).toStartWith("macos-");
    expect(job.steps.some((s: { run?: string }) => s.run?.includes("scripts/sign-darwin.sh"))).toBe(true);
    const last = job.steps[job.steps.length - 1];
    expect(last.uses).toStartWith("actions/upload-artifact@");
    expect(last.with.name).toBe("dist-signed");
  });

  test("smoke-macos, release and npm read the signed artifact", () => {
    for (const name of ["smoke-macos", "release", "npm"]) {
      const job = wf.jobs[name];
      expect([job.needs].flat()).toContain("sign-macos");
      const downloads = job.steps.filter((s: { uses?: string }) => s.uses?.startsWith("actions/download-artifact@"));
      expect(downloads.length).toBeGreaterThan(0);
      for (const d of downloads) expect(d.with.name).toBe("dist-signed");
    }
  });

  test("smoke-macos checks both darwin signatures", () => {
    const runs = wf.jobs["smoke-macos"].steps.map((s: { run?: string }) => s.run ?? "");
    expect(runs.some((r: string) => r.includes("scripts/smoke-binary.sh dist/ltm-darwin-arm64"))).toBe(true);
    expect(runs.some((r: string) => r.includes("codesign --verify --strict") && r.includes("dist/ltm-darwin-x64"))).toBe(true);
  });

  test("PRs touching sign-darwin.sh trigger the dry run", () => {
    expect(wf.on.pull_request.paths).toContain("scripts/sign-darwin.sh");
  });

  test("the Release attaches an install.sh built for its own tag", () => {
    const steps: { uses?: string; run?: string }[] = wf.jobs.release.steps;
    const checkout = steps.findIndex((s) => s.uses === "actions/checkout@v7");
    const build = steps.findIndex((s) => s.run === 'sh scripts/build-install.sh "$TAG" > dist/install.sh');
    const create = steps.findIndex((s) => s.run?.includes("gh release create"));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(checkout);
    expect(create).toBeGreaterThan(build);
    expect(steps[create]!.run).toContain("dist/install.sh");
  });

  // GITHUB_REF_NAME is the branch when release-please.yml calls this workflow, so a step reading it would release "main".
  test("every step reads the tag from TAG, which a call sets from its input", () => {
    expect(wf.on.workflow_call.inputs.tag.required).toBe(true);
    expect(wf.env.TAG).toBe("${{ inputs.tag || github.ref_name }}");
    const scripts = Object.values(wf.jobs).flatMap((j) => (j as { steps: { run?: string }[] }).steps.map((s) => s.run ?? ""));
    expect(scripts.filter((r) => r.includes("GITHUB_REF_NAME"))).toEqual([]);
  });

  // Release-please can report a release on a later push than the release PR's merge, so the default checkout would build newer code under the older tag.
  test("every checkout pins ref to the called tag", () => {
    const checkouts = Object.values(wf.jobs).flatMap((j) =>
      (j as { steps: { uses?: string; with?: { ref?: string } }[] }).steps.filter((s) => s.uses?.startsWith("actions/checkout@")),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const c of checkouts) expect(c.with?.ref).toBe("${{ inputs.tag }}");
  });

  // Runs the step's real bash against a stub gh, so the version comparison is checked as bash executes it.
  test("the Release step marks a tag latest only when no newer Release is latest", () => {
    const step = wf.jobs.release.steps.find((s: { run?: string }) => s.run?.includes("gh release upload"));
    const publish = (tag: string, latest: string, exists: boolean) => {
      const temp = join(tmp, `gh-${runs++}`);
      const bin = join(temp, "bin");
      mkdirSync(bin, { recursive: true });
      // `gh release view` with no tag prints the latest Release; with a tag it succeeds only when that Release exists.
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/bash\necho "$*" >> "$LOG"\nif [ "$1 $2" = "release view" ]; then\n  if [ "$3" = --repo ]; then [ -n "$LATEST" ] && echo "$LATEST"; exit 0; fi\n  [ "$EXISTS" = 1 ]; exit $?\nfi\n`,
      );
      chmodSync(join(bin, "gh"), 0o755);
      const log = join(temp, "log");
      const r = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
        env: { PATH: `${bin}:${process.env.PATH}`, TAG: tag, LATEST: latest, EXISTS: exists ? "1" : "0", LOG: log, GITHUB_REPOSITORY: "o/r" },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      return readFileSync(log, "utf8").split("\n").find((l) => l.startsWith(exists ? "release edit" : "release create"))!;
    };
    expect(publish("v0.3.0", "v0.2.0", true)).toMatch(/ --latest$/);
    expect(publish("v0.3.0", "v0.3.0", true)).toMatch(/ --latest$/);
    expect(publish("v0.3.0", "", true)).toMatch(/ --latest$/);
    expect(publish("v0.2.0", "v0.10.0", true)).toMatch(/ --latest=false$/);
    expect(publish("v0.2.1", "v0.3.0", false)).toContain(" --latest=false ");
    expect(publish("v0.4.0", "v0.3.0", false)).toContain(" --latest ");
  });

  test("homebrew waits on the Release and runs on tag pushes only", () => {
    expect([wf.jobs.homebrew.needs].flat()).toContain("release");
    expect(wf.jobs.homebrew.if).toBe("github.event_name == 'push'");
  });

  test("nothing needs homebrew, so a failed tap update can't hold back the Release or npm", () => {
    for (const job of Object.values(wf.jobs) as { needs?: string | string[] }[]) {
      expect([job.needs ?? []].flat()).not.toContain("homebrew");
    }
  });

  // Runs the step's own script, since a notice in the text proves nothing about what bash does with it.
  test("the homebrew token step exits 0 with a notice when HOMEBREW_TAP_TOKEN is empty, and flags it present otherwise", () => {
    const step = wf.jobs.homebrew.steps.find((s: { id?: string }) => s.id === "token");
    expect(step.run).toContain("::notice::");
    expect(step.run).toContain("exit 0");
    const run = (token: string) => {
      const out = join(tmp, `token-${runs++}`);
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
        env: { PATH: process.env.PATH, HOMEBREW_TAP_TOKEN: token, GITHUB_OUTPUT: out },
        encoding: "utf8",
      });
      return { status: r.status, stdout: r.stdout, output: readFileSync(out, "utf8") };
    };
    const empty = run("");
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("::notice::HOMEBREW_TAP_TOKEN is empty");
    expect(empty.output).not.toContain("present=true");
    const set = run("x");
    expect(set.status).toBe(0);
    expect(set.output).toContain("present=true");
  });

  // Runs the tap step's real bash against a stub git, which tests the guard as written without network access or a push.
  test("the tap step never replaces a newer or equal formula, and installs over an older one or none", () => {
    const step = wf.jobs.homebrew.steps.find((s: { run?: string }) => s.run?.includes("git push"));
    const sha = ["ltm-darwin-arm64", "ltm-darwin-x64", "ltm-linux-arm64", "ltm-linux-x64"].map((a) => `${"a".repeat(64)}  ${a}`).join("\n");
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\ncase "$1" in\n  clone) cp -R "$TAP" "$3" ;;\n  status) echo " M Formula/ltm.rb" ;;\n  push) echo pushed >> "$RUNNER_TEMP/log" ;;\nesac\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const release = (tag: string, tapVersion?: string) => {
      const temp = join(tmp, `tap-${runs++}`);
      const tap = join(temp, "fixture");
      mkdirSync(join(tap, "Formula"), { recursive: true });
      if (tapVersion) writeFileSync(join(tap, "Formula/ltm.rb"), homebrewFormula(tapVersion, sha));
      writeFileSync(join(temp, "ltm.rb"), homebrewFormula(tag, sha));
      const r = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
        env: { PATH: `${bin}:${process.env.PATH}`, TAG: tag, RUNNER_TEMP: temp, TAP: tap, HOMEBREW_TAP_TOKEN: "x" },
        encoding: "utf8",
      });
      const log = join(temp, "log");
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, pushed: existsSync(log) };
    };

    for (const [tag, tapVersion] of [["v0.1.1", "0.2.0"], ["v0.2.0", "0.2.0"], ["v0.9.0", "0.10.0"]]) {
      const r = release(tag!, tapVersion);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`::notice::The tap already has ltm ${tapVersion}`);
      expect(r.pushed).toBe(false);
    }
    for (const [tag, tapVersion] of [["v0.2.1", "0.2.0"], ["v0.10.0", "0.9.0"], ["v0.1.0", undefined]]) {
      const r = release(tag!, tapVersion);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
      expect(r.pushed).toBe(true);
    }
  });
});

describe("release-please.yml", () => {
  const rp = parse(readFileSync(join(ROOT, ".github/workflows/release-please.yml"), "utf8"), { logLevel: "error" });

  test("calls release.yml with the new tag, and only when a release was created", () => {
    expect(rp.jobs.release.uses).toBe("./.github/workflows/release.yml");
    expect(rp.jobs.release.if).toBe("needs.release-please.outputs.release_created == 'true'");
    expect(rp.jobs.release.with.tag).toBe("${{ needs.release-please.outputs.tag_name }}");
    expect(rp.jobs.release.secrets).toBe("inherit");
  });

  // The release job publishes the draft only after the gates pass, so a failed gate never leaves a Release without binaries at latest/download.
  test("release-please makes a tagged draft, which the release job then publishes", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8"));
    expect(config.draft).toBe(true);
    expect(config["force-tag-creation"]).toBe(true);
    const publish = wf.jobs.release.steps.find((s: { run?: string }) => s.run?.includes("--draft=false"));
    expect(publish.run).toContain("gh release upload");
  });
});
