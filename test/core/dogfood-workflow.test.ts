import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Step = { name?: string; uses?: string; run?: string; "working-directory"?: string; [key: string]: unknown };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const load = (path: string) => parse(readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8")) as Workflow;
const after = (steps: Step[], marker: (s: Step) => boolean) => {
  const i = steps.findIndex(marker);
  expect(i).toBeGreaterThanOrEqual(0);
  return steps.slice(i + 1);
};

const BANK = "fixtures/demo-bank";

test("ltm-validate-dogfood runs exactly the template's steps after install, against the demo Bank", () => {
  const template = after(load("templates/github/workflows/ltm-validate.yml").jobs["ltm-validate"]!.steps, (s) => s.run?.includes("releases/download") === true);
  const dogfood = after(load(".github/workflows/ci.yml").jobs["ltm-validate-dogfood"]!.steps, (s) => s.run?.includes("bun build --compile") === true);

  // An empty tail on both sides would compare equal and prove nothing.
  expect(template.length).toBeGreaterThan(0);
  // The template runs at the repo root, which is the Bank root in a user's repo; here the Bank is the fixture.
  for (const s of dogfood) expect(s["working-directory"]).toBe(BANK);
  expect(dogfood.map(({ "working-directory": _, ...s }) => s)).toEqual(template);
});
