import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entrySlug, readAdr, readEntry, type PromoteSource } from "../../src/core/promote.ts";

const FIXTURE = join(import.meta.dir, "../../fixtures/consumer-repo");
const ADR_3 = "docs/adr/0003-use-ioredis.md";
const ADR_4 = "docs/adr/0004-retry-budget.md";
const LOG = "_working-memory/decisionLog.md";
const fixture = (rel: string): string => readFileSync(join(FIXTURE, rel), "utf8");

function source(r: PromoteSource | { refusal: string }): PromoteSource {
  if ("refusal" in r) throw new Error(`refused: ${r.refusal}`);
  return r;
}

function refusal(r: PromoteSource | { refusal: string }): string {
  if (!("refusal" in r)) throw new Error(`expected a refusal, got a ${r.kind}`);
  return r.refusal;
}

// What `after` adds to `before` and what it drops, as an LCS line diff reports it.
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) removed.push(a[i++]!);
    else added.push(b[j++]!);
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { added, removed };
}

describe("readAdr", () => {
  test("a Nygard ADR with no frontmatter takes its title from the heading and its body whole", () => {
    const text = fixture(ADR_3);
    const s = source(readAdr(ADR_3, text));
    expect(s.kind).toBe("adr");
    expect(s.title).toBe("3. Use ioredis for the Redis client");
    expect(s.existing).toBeNull();
    expect(s.body).toBe(text);
  });

  test("stamping an ADR with no frontmatter prepends a block and leaves the rest byte-identical", () => {
    const text = fixture(ADR_3);
    const stamped = source(readAdr(ADR_3, text)).stamp("promoted_to: X");
    const block = "---\npromoted_to: X\n---\n";
    expect(stamped.text.slice(0, block.length)).toBe(block);
    expect(stamped.text.slice(block.length)).toBe(text);
    expect(stamped.text).toBe(block + text);
    expect(stamped.line).toBe(2);
  });

  test("a MADR ADR with no title key takes the heading, and its body is the bytes after the fence", () => {
    const text = fixture(ADR_4);
    const s = source(readAdr(ADR_4, text));
    expect(s.title).toBe("Retry budget for outbound calls");
    expect(s.existing).toBeNull();
    const fence = "---\nstatus: accepted\ndate: 2026-06-15\ndecision-makers: [platform-team]\n---\n";
    expect(text.slice(0, fence.length)).toBe(fence);
    expect(s.body).toBe(text.slice(fence.length));
  });

  test("stamping a MADR ADR adds one line just above the closing fence and removes none", () => {
    const text = fixture(ADR_4);
    const stamped = source(readAdr(ADR_4, text)).stamp("promoted_to: acme:x");
    expect(lineDiff(text, stamped.text)).toEqual({ added: ["promoted_to: acme:x"], removed: [] });
    expect(stamped.line).toBe(5);
    expect(stamped.text.split("\n")[4]).toBe("promoted_to: acme:x");
    expect(stamped.text.split("\n")[5]).toBe("---");
    expect(stamped.text).toBe(
      "---\nstatus: accepted\ndate: 2026-06-15\ndecision-makers: [platform-team]\npromoted_to: acme:x\n---\n" + source(readAdr(ADR_4, text)).body,
    );
  });

  test("a title key wins over the heading", () => {
    const s = source(readAdr("a.md", "---\ntitle: From the key\n---\n# From the heading\n"));
    expect(s.title).toBe("From the key");
  });

  test("an empty or non-string title key falls back to the heading", () => {
    expect(source(readAdr("a.md", '---\ntitle: ""\n---\n# Heading\n')).title).toBe("Heading");
    expect(source(readAdr("a.md", "---\ntitle: 3\n---\n# Heading\n")).title).toBe("Heading");
  });

  test("a promoted_to key gives existing", () => {
    expect(source(readAdr("a.md", "---\npromoted_to: acme:abc\n---\n# T\n")).existing).toBe("acme:abc");
  });

  test("a promoted_to key with no value still counts as existing", () => {
    expect(source(readAdr("a.md", "---\npromoted_to:\n---\n# T\n")).existing).not.toBeNull();
  });

  test("CRLF frontmatter stamps with CRLF", () => {
    const text = "---\r\nstatus: accepted\r\n---\r\n# T\r\nbody\r\n";
    const s = source(readAdr("a.md", text));
    expect(s.title).toBe("T");
    expect(s.body).toBe("# T\r\nbody\r\n");
    const stamped = s.stamp("promoted_to: acme:x");
    expect(stamped.text).toBe("---\r\nstatus: accepted\r\npromoted_to: acme:x\r\n---\r\n# T\r\nbody\r\n");
    expect(stamped.line).toBe(3);
  });

  test("a CRLF file with no frontmatter gets a CRLF block", () => {
    const text = "# T\r\nbody\r\n";
    const s = source(readAdr("a.md", text));
    expect(s.title).toBe("T");
    expect(s.body).toBe(text);
    expect(s.stamp("promoted_to: acme:x").text).toBe("---\r\npromoted_to: acme:x\r\n---\r\n# T\r\nbody\r\n");
  });

  test("a # line inside a fenced block isn't taken as the title", () => {
    const text = "Intro\n\n```sh\n# not a title\n```\n\n# Real title\n";
    expect(source(readAdr("a.md", text)).title).toBe("Real title");
    expect(source(readAdr("a.md", "```\n# only in a fence\n```\n")).title).toBeNull();
  });

  test("trailing whitespace after the heading text is dropped", () => {
    expect(source(readAdr("a.md", "# Spaced   \nbody\n")).title).toBe("Spaced");
  });

  test("a file with no title anywhere gives a null title", () => {
    const text = "Just some text.\n## Not level one\n";
    const s = source(readAdr("a.md", text));
    expect(s.title).toBeNull();
    expect(s.body).toBe(text);
  });

  test("invalid YAML refuses", () => {
    expect(refusal(readAdr("docs/adr/x.md", "---\nkey: [unclosed\n---\n# T\n"))).toStartWith("docs/adr/x.md: frontmatter isn't valid YAML: ");
  });

  test("a frontmatter block that isn't a mapping refuses", () => {
    expect(refusal(readAdr("docs/adr/x.md", "---\n- a\n- b\n---\n# T\n"))).toBe("docs/adr/x.md: frontmatter is not a mapping");
  });
});

describe("readEntry", () => {
  const HEADING = "Cap retries at three per request";

  test("finds the entry, slugs it, and bounds its body at the next heading", () => {
    const text = fixture(LOG);
    const s = source(readEntry(LOG, text, HEADING));
    if (s.kind !== "entry") throw new Error("expected an entry");
    expect(s.slug).toBe("cap-retries-at-three-per-request");
    expect(s.title).toBe(HEADING);
    expect(s.existing).toBeNull();
    const start = text.indexOf(`## ${HEADING}\n`) + `## ${HEADING}\n`.length;
    const end = text.indexOf("## Keep order IDs as ULIDs\n");
    expect(s.body).toBe(text.slice(start, end));
    expect(s.body).toBe(
      "\nOutbound calls retry at most three times per request, with jittered backoff. Anything past that fails fast so a struggling provider can recover.\n\n",
    );
  });

  test("stamping inserts the line directly under the heading and leaves every other entry byte-identical", () => {
    const text = fixture(LOG);
    const stamped = source(readEntry(LOG, text, HEADING)).stamp("promoted_to: acme:x");
    const anchor = `## ${HEADING}\n`;
    const cut = text.indexOf(anchor) + anchor.length;
    expect(stamped.text).toBe(text.slice(0, cut) + "promoted_to: acme:x\n" + text.slice(cut));
    expect(stamped.text.slice(0, cut)).toBe(text.slice(0, cut));
    expect(stamped.text.slice(cut + "promoted_to: acme:x\n".length)).toBe(text.slice(cut));
    const lines = stamped.text.split("\n");
    expect(lines[stamped.line - 2]).toBe(anchor.slice(0, -1));
    expect(lines[stamped.line - 1]).toBe("promoted_to: acme:x");
    expect(stamped.line).toBe(text.slice(0, cut).split("\n").length);
  });

  test("the last entry's body runs to the end of the file", () => {
    const text = fixture(LOG);
    const s = source(readEntry(LOG, text, "Keep order IDs as ULIDs"));
    const anchor = "## Keep order IDs as ULIDs\n";
    expect(s.body).toBe(text.slice(text.indexOf(anchor) + anchor.length));
  });

  test("a promoted_to line in the entry gives existing", () => {
    const text = "# Log\n\n## A\npromoted_to: acme:abc\n\nText.\n\n## B\n\npromoted_to: acme:other\n";
    expect(source(readEntry("log.md", text, "A")).existing).toBe("acme:abc");
    expect(source(readEntry("log.md", "# Log\n\n## A\n\nText.\n\n## B\npromoted_to: acme:b\n", "A")).existing).toBeNull();
  });

  test("CRLF entries stamp with CRLF and match their heading without the \\r", () => {
    const text = "# Log\r\n\r\n## A\r\nText.\r\n## B\r\nMore.\r\n";
    const s = source(readEntry("log.md", text, "A"));
    expect(s.body).toBe("Text.\r\n");
    const stamped = s.stamp("promoted_to: acme:x");
    expect(stamped.text).toBe("# Log\r\n\r\n## A\r\npromoted_to: acme:x\r\nText.\r\n## B\r\nMore.\r\n");
    expect(stamped.line).toBe(4);
  });

  test("a heading on the file's last line, with no newline, stamps on a new line", () => {
    const text = "# Log\n\n## A";
    const s = source(readEntry("log.md", text, "A"));
    expect(s.body).toBe("");
    const stamped = s.stamp("promoted_to: acme:x");
    expect(stamped.text).toBe("# Log\n\n## A\npromoted_to: acme:x");
    expect(stamped.line).toBe(4);
  });

  test("a missing heading refuses", () => {
    expect(refusal(readEntry(LOG, fixture(LOG), "No such heading"))).toBe(`${LOG} has no '## No such heading' heading`);
  });

  test("a heading present twice refuses", () => {
    expect(refusal(readEntry("log.md", "## A\none\n## A\ntwo\n", "A"))).toBe("log.md has 2 '## A' headings");
  });

  test("the match is exact", () => {
    expect(refusal(readEntry("log.md", "## A thing\n", "a thing"))).toBe("log.md has no '## a thing' heading");
    expect(refusal(readEntry("log.md", "### A\n", "A"))).toBe("log.md has no '## A' heading");
  });

  test("a ## line inside a fence doesn't count, as a match or as a boundary", () => {
    expect(refusal(readEntry("log.md", "```\n## A\n```\n", "A"))).toBe("log.md has no '## A' heading");
    const text = "## A\nBefore.\n```md\n## B\n```\nAfter.\n## C\n";
    expect(source(readEntry("log.md", text, "A")).body).toBe("Before.\n```md\n## B\n```\nAfter.\n");
    expect(source(readEntry("log.md", "```\n## A\n```\n## A\nreal\n", "A")).body).toBe("real\n");
  });
});

describe("entrySlug", () => {
  test("lowercases and collapses each run of other characters to one dash", () => {
    expect(entrySlug("Use pnpm: v9 & up!")).toBe("use-pnpm-v9-up");
    expect(entrySlug("Cap retries at three per request")).toBe("cap-retries-at-three-per-request");
    expect(entrySlug("  --Leading and trailing--  ")).toBe("leading-and-trailing");
  });

  test("has no length cap", () => {
    const long = "word ".repeat(40).trim();
    expect(entrySlug(long)).toBe(Array(40).fill("word").join("-"));
  });
});
