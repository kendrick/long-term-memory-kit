import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = new URL("../..", import.meta.url).pathname;
const skills = readdirSync(join(repo, "skills")).sort();

// A repo that vendors a skill looks right under the frontmatter for where it came from.
function headerLines(text: string): string[] {
  const lines = text.split("\n");
  const close = lines.indexOf("---", 1);
  return lines[0] === "---" && close > 0 ? lines.slice(close + 1, close + 3) : [];
}

describe("vendored skill headers", () => {
  test("the plugin ships exactly the three skills", () => {
    expect(skills).toEqual(["hydrate", "promote", "query-memory"]);
  });

  for (const name of skills) {
    test(`skills/${name} names its own path in VENDORED-FROM, right under the frontmatter`, () => {
      const text = readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8");
      const [vendored, version] = headerLines(text);
      expect(vendored).toBe(`<!-- VENDORED-FROM: kendrick/long-term-memory-kit skills/${name} -->`);
      expect(version).toMatch(/^<!-- VERSION: \S+ -->$/);
      expect(text).toMatch(new RegExp(`^name: ${name}$`, "m"));
    });
  }
});
