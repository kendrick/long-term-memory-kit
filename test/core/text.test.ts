import { describe, expect, test } from "bun:test";
import { firstLine } from "../../src/core/text.ts";

describe("firstLine", () => {
  // Expected values are literals, not a second split call: a helper that trims "\r" or falls back on "" must fail here.
  test.each([
    ["a\nb", "a"],
    ["a\r\nb", "a\r"],
    ["a", "a"],
    ["", ""],
  ])("firstLine(%j) is %j", (input, expected) => {
    expect(firstLine(input)).toBe(expected);
    expect(firstLine(input)).toBe(input.split("\n")[0]!);
  });
});
