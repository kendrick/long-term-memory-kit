import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> };
type Workflow = { concurrency?: unknown; jobs: Record<string, { steps: Step[] }> };

const guide = readFileSync(fileURLToPath(new URL("../guide/m365-copilot.md", import.meta.url)), "utf8");
const block = [...guide.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map((m) => m[1]!).find((y) => y.startsWith("name: ltm-digest\n"));

test("the guide's ltm-digest workflow pushes digest/ only after the upload succeeds, one run at a time", () => {
  expect(block).toBeDefined();
  const wf = parse(block!) as Workflow;
  const steps = wf.jobs["ltm-digest"]!.steps;
  const upload = steps.findIndex((s) => s.run?.includes("ltm publish sharepoint") === true);
  const push = steps.findIndex((s) => s.run?.includes("git push") === true);
  expect(upload).toBeGreaterThanOrEqual(0);
  // The change gate diffs against the committed digest/, so a push before a failed upload hides that upload from every later run.
  expect(push).toBeGreaterThan(upload);
  // Two overlapping runs could otherwise upload an older Digest after a newer one was pushed.
  expect(wf.concurrency).toBeDefined();
});

const section = (heading: string) => guide.split(/^## /m).find((s) => s.startsWith(heading)) ?? "";

test.each(["Route 1:", "Route 3:"])("%s names every Graph step a reader must drop from the workflow", (heading) => {
  const steps = (parse(block!) as Workflow).jobs["ltm-digest"]!.steps;
  // A Graph step kept without its secrets fails the job, and the commit now comes after it.
  const graph = steps.filter((s) => s.run?.includes("ltm publish sharepoint") || Object.values(s.env ?? {}).some((v) => v.includes("ENTRA_")));
  expect(graph.length).toBe(2);
  const text = section(heading);
  expect(text).not.toBe("");
  for (const s of graph) expect(text).toContain(s.name!);
});

const headCheck = () => {
  const steps = (parse(block!) as Workflow).jobs["ltm-digest"]!.steps;
  const i = steps.findIndex((s) => ["git fetch", "origin main", "git rev-parse FETCH_HEAD", "git rev-parse HEAD"].every((t) => s.run?.includes(t)));
  return { steps, i, check: steps[i]! };
};

test("a step before the upload compares HEAD with the fetched main, and every later step reads its output", () => {
  const { steps, i, check } = headCheck();
  expect(i).toBeGreaterThanOrEqual(0);
  expect(check.id).toBeDefined();
  expect(i).toBe(steps.findIndex((s) => s.id === "render") + 1);
  const upload = steps.findIndex((s) => s.run?.includes("ltm publish sharepoint") === true);
  expect(i).toBeLessThan(upload);
  for (const name of ["Convert to Word", "Save the Word files", "Get a Graph token", "Upload to SharePoint", "Commit the Digest"]) {
    const gate = steps.find((s) => s.name === name)?.if;
    expect(gate).toContain("steps.render.outputs.changed == 'true'");
    expect(gate).toContain(`steps.${check.id}.outputs.current == 'true'`);
  }
});

test("the head check writes current=false on an older commit and current=true on main's head", () => {
  const { check } = headCheck();
  const root = mkdtempSync(join(tmpdir(), "ltm-head-"));
  const env = {
    PATH: process.env.PATH!,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always",
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-b", "main", origin);
  const work = join(root, "work");
  git(root, "init", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  git(work, "commit", "--allow-empty", "-m", "x");
  const x = git(work, "rev-parse", "HEAD");
  git(work, "push", "origin", "main");
  git(work, "commit", "--allow-empty", "-m", "z");
  const z = git(work, "rev-parse", "HEAD");
  git(work, "push", "origin", "main");
  for (const [sha, expected] of [[x, "false"], [z, "true"]] as const) {
    const clone = join(root, `clone-${expected}`);
    const url = `file://${origin}`;
    if (sha === x) {
      git(root, "clone", url, clone);
      git(clone, "checkout", "--detach", x);
    } else {
      git(root, "clone", "--depth=1", "--branch", "main", url, clone);
    }
    const out = join(root, `out-${expected}`);
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", check.run!], { cwd: clone, env: { ...env, GITHUB_OUTPUT: out }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`current=${expected}\n`);
  }
});

test("the guide says re-running an old run uploads nothing once main has moved on", () => {
  const text = section("Route 2:");
  expect(text).toContain("Re-running an old workflow run");
  expect(text).toContain("uploads nothing");
});

test("Route 1 names the head check, since Commit the Digest reads its output", () => {
  expect(section("Route 1:")).toContain(headCheck().check.name!);
});
