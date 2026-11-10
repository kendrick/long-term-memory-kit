import { describe, expect, test } from "bun:test";
import { connectRegion, spliceConnectRegion } from "../../src/core/connect.ts";

const R = connectRegion("## Org memory\nx\n");
const R2 = connectRegion("## Org memory\ny\n");

describe("connectRegion", () => {
  test("fences the section with blank lines inside the markers", () => {
    expect(R).toBe("<!-- ltm:connect:begin -->\n\n## Org memory\nx\n\n<!-- ltm:connect:end -->\n");
  });
});

describe("spliceConnectRegion", () => {
  test("null and empty files become the region", () => {
    expect(spliceConnectRegion(null, R)).toBe(R);
    expect(spliceConnectRegion("", R)).toBe(R);
  });

  test("appends with exactly one blank line", () => {
    expect(spliceConnectRegion("# A\nhand\n", R)).toBe(`# A\nhand\n\n${R}`);
    expect(spliceConnectRegion("# A", R)).toBe(`# A\n\n${R}`);
    expect(spliceConnectRegion("# A\n\n", R)).toBe(`# A\n\n${R}`);
  });

  test("is idempotent", () => {
    const t = "# A\nhand\n";
    const once = spliceConnectRegion(t, R);
    expect(spliceConnectRegion(once, R)).toBe(once);
    expect(once.match(/^## Org memory$/gm)).toHaveLength(1);
  });

  test("replacing keeps every byte outside the region", () => {
    const pre = "# A\n\n";
    const post = "\n## Later\ntail";
    expect(spliceConnectRegion(pre + R + post, R2)).toBe(pre + R2 + post);
  });

  test("a hand-written heading outside markers is left alone and a region is appended", () => {
    const hand = "## Org memory\nhand\n";
    const out = spliceConnectRegion(hand, R);
    expect(out.startsWith(hand)).toBe(true);
    expect(out.match(/^## Org memory$/gm)).toHaveLength(2);
  });

  test("an inline marker mention is not a marker", () => {
    const t = "see `<!-- ltm:connect:begin -->` here\n";
    expect(spliceConnectRegion(t, R)).toBe(`${t}\n${R}`);
  });

  test("malformed marker states throw", () => {
    expect(() => spliceConnectRegion("x\n<!-- ltm:connect:begin -->\n## Org memory\n", R)).toThrow(
      "the ltm:connect begin marker has no matching end marker",
    );
    expect(() => spliceConnectRegion("x\n<!-- ltm:connect:end -->\n", R)).toThrow(
      "an ltm:connect end marker with no begin marker",
    );
    expect(() => spliceConnectRegion(`${R}\n${R}`, R)).toThrow(
      "2 ltm:connect begin markers and 2 end markers; leave one block",
    );
  });

  test("CRLF files keep what follows the region", () => {
    const crlf = "<!-- ltm:connect:begin -->\r\nold\r\n<!-- ltm:connect:end -->\r\nafter\r\n";
    expect(spliceConnectRegion(crlf, R)).toBe(`${R}after\r\n`);
  });
});
