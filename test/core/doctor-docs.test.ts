import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHECKS } from "../../src/core/doctor.ts";

const LABELS = ["Fields", "Threshold", "Report line", "False positives", "Dismissal"];

// Split per `## ` heading so a label in one section can't satisfy another section's check.
function sectionsOf(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of doc.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    out.set(part.slice(0, nl).trim(), part.slice(nl + 1));
  }
  return out;
}

const doc = readFileSync(fileURLToPath(new URL("../../docs/doctor.md", import.meta.url)), "utf8");
const sections = sectionsOf(doc);

describe("docs/doctor.md", () => {
  test("has a section for every check the code can emit, and no others", () => {
    expect([...sections.keys()].sort()).toEqual(CHECKS.map((c) => c.name).sort());
  });

  for (const { name } of CHECKS) {
    describe(name, () => {
      for (const label of LABELS) {
        test(`has a ${label} paragraph`, () => {
          const body = sections.get(name) ?? "";
          expect(body).toMatch(new RegExp(`^\\*\\*${label}:\\*\\*`, "m"));
        });
      }

      test("quotes a report line for its own check", () => {
        const body = sections.get(name) ?? "";
        const line = body.split("\n").find((l) => l.startsWith("**Report line:**")) ?? "";
        expect(line).toMatch(new RegExp("`[^`]+: " + name + ": [^`]+`"));
      });
    });
  }
});
