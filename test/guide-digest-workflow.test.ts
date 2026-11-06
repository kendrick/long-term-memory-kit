import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Step = { name?: string; run?: string };
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
