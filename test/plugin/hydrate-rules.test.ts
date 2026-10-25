import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = new URL("../..", import.meta.url).pathname;
const skill = readFileSync(join(repo, "skills/hydrate/SKILL.md"), "utf8");

// Sentences, not lines: the skill's paragraphs are one line each, so a line-level check would let a "never" in one sentence excuse an instruction in the next.
const sentences = (text: string): string[] => text.split("\n").flatMap((l) => l.split(/(?<=[.!?])\s+/));

function unguarded(text: string, phrase: string): string[] {
  return sentences(text).filter((s) => s.toLowerCase().includes(phrase) && !/\bnever\b/i.test(s));
}

describe("hydrate's never-rules", () => {
  for (const phrase of ["status: accepted", "default branch", "model api"]) {
    test(`"${phrase}" appears only inside a sentence that says never`, () => {
      expect(sentences(skill).some((s) => s.toLowerCase().includes(phrase))).toBe(true);
      expect(unguarded(skill, phrase)).toEqual([]);
    });
  }
});

describe("the never-rule check's falsifier", () => {
  test("an instruction to accept is caught", () => {
    expect(unguarded("Never call a model API. Then set `status: accepted`.", "status: accepted")).toHaveLength(1);
  });

  test("the same phrase inside a never sentence passes", () => {
    expect(unguarded("Never set `status: accepted` on a Proposal.", "status: accepted")).toEqual([]);
  });
});
