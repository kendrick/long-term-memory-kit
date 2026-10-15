import { describe, expect, test } from "bun:test";
import { firstLine } from "../../src/core/text.ts";

describe("firstLine", () => {
  // The literals are the real check, so a helper that trims "\r" or falls back on "" fails here. The split comparison only pins parity with the idiom the call sites used.
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
