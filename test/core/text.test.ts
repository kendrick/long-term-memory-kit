import { describe, expect, test } from "bun:test";
import { byCodeUnit, firstLine } from "../../src/core/text.ts";

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

describe("byCodeUnit", () => {
  test("orders by UTF-16 code unit, not locale", () => {
    expect(["b", "a", "B", "é", "e"].sort(byCodeUnit)).toEqual(["B", "a", "b", "e", "é"]);
  });

  test("returns 0 for equal strings", () => {
    expect(byCodeUnit("a", "a")).toBe(0);
  });
});
