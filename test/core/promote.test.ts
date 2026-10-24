import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../../src/core/bank.ts";
import type { ChangeRequest, ForgeAdapter } from "../../src/core/forge.ts";
import { entrySlug, promoteSource, readAdr, readEntry, type PromoteRequest, type PromoteResult, type PromoteSource } from "../../src/core/promote.ts";
import { splitFrontmatter } from "../../src/core/record.ts";
import { withConsumerRepo } from "../helpers/consumer-repo.ts";
import { git, withGitBank } from "../helpers/git-bank.ts";

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

  test("a # line inside a ~~~ fence isn't taken as the title", () => {
    const text = "~~~\n# Not a title\n~~~\n\nBody.\n";
    expect(source(readAdr("a.md", text)).title).toBeNull();
  });

  test("flow-style frontmatter refuses, since a stamp line would break the YAML", () => {
    const r = refusal(readAdr("docs/adr/flow.md", "---\n{title: Example}\n---\n# Example\n"));
    expect(r).toContain("docs/adr/flow.md");
    expect(r).toContain("by hand");
  });

  test("block-style frontmatter with nested values still stamps", () => {
    const text = "---\ntitle: X\ntags:\n  - a\n  - b\n---\n# X\n";
    expect(source(readAdr("a.md", text)).stamp("promoted_to: b:1").text).toBe("---\ntitle: X\ntags:\n  - a\n  - b\npromoted_to: b:1\n---\n# X\n");
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

  test("a four-backtick fence around a triple-backtick example keeps its ## line inside the entry", () => {
    const text = "# Log\n\n## A\n\n````md\n```\n## not a heading\n```\n````\n\nAfter.\n\n## B\n\nText.\n";
    const s = source(readEntry("log.md", text, "A"));
    expect(s.body).toBe("\n````md\n```\n## not a heading\n```\n````\n\nAfter.\n\n");
    expect(refusal(readEntry("log.md", text, "not a heading"))).toContain("no '## not a heading'");
  });

  test("a ~~~ fence hides a ## line", () => {
    const text = "# Log\n\n## A\n\n~~~\n## hidden\n~~~\n\n## B\n";
    expect(source(readEntry("log.md", text, "A")).body).toBe("\n~~~\n## hidden\n~~~\n\n");
    expect(refusal(readEntry("log.md", text, "hidden"))).toContain("no '## hidden'");
  });

  test("a promoted_to line inside a fenced block isn't a stamp", () => {
    const text = "# Log\n\n## A\n\n```yaml\npromoted_to: acme:example\n```\n\n## B\n";
    expect(source(readEntry("log.md", text, "A")).existing).toBeNull();
  });

  test("a promoted_to line directly under the heading still counts when an earlier entry has a fence", () => {
    const text = "# Log\n\n## Z\n\n```\nx\n```\n\n## A\npromoted_to: acme:abc\n\nText.\n";
    expect(source(readEntry("log.md", text, "A")).existing).toBe("acme:abc");
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

// Each test spawns many git processes; bun's 5s default flakes under load.
const GIT_TEST_TIMEOUT = 30_000;
const TODAY = "2026-10-09";
const REPO = "acme/order-service";

function fakeAdapter(onOpen?: () => void): ForgeAdapter & { calls: ChangeRequest[] } {
  const calls: ChangeRequest[] = [];
  return {
    name: "github",
    calls,
    async openChangeRequest(req) {
      calls.push(req);
      onOpen?.();
      return { url: "https://example.invalid/pr/1" };
    },
  };
}

const throwingAdapter = (): ForgeAdapter => ({
  name: "github",
  async openChangeRequest() {
    throw new Error("forge is down");
  },
});

function promote(clone: string, repoDir: string, rel: string, forge: ForgeAdapter, extra: Partial<PromoteRequest> = {}, dryRun = false): Promise<PromoteResult> {
  return promoteSource(
    { abs: join(repoDir, rel), rel, repo: REPO, type: "Decision", ...extra },
    { config: loadConfig(clone), today: TODAY, env: {}, forge, dryRun },
  );
}

function stamped(r: PromoteResult) {
  if ("refusal" in r) throw new Error(`refused: ${r.refusal}`);
  if (r.dryRun) throw new Error("expected a real run, got a dry run");
  return r;
}

describe("promoteSource", () => {
  test("an ADR opens one Proposal carrying its bytes, then gains the stamp", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const before = readFileSync(join(repo, ADR_3), "utf8");
        const forge = fakeAdapter();
        const r = stamped(await promote(clone, repo, ADR_3, forge));
        expect(forge.calls).toHaveLength(1);
        const split = splitFrontmatter(r.text)!;
        const fm = parse(split.frontmatterLines.join("\n")) as Record<string, unknown>;
        expect(fm.memory_type).toBe("Decision");
        expect(fm.status).toBe("proposed");
        expect(fm.title).toBe("3. Use ioredis for the Redis client");
        expect(fm.promoted_from).toBe(`${REPO}:${ADR_3}`);
        expect(fm.applies_to).toEqual(["service:order-service", "domain:commerce"]);
        expect(split.body).toBe(before);
        expect(readFileSync(join(repo, ADR_3), "utf8")).toBe(`---\npromoted_to: acme:${r.id}\n---\n${before}`);
        expect(r.stamped).toEqual({ path: ADR_3, line: 2 });
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("applies_to overrides the consumers mapping", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const r = stamped(await promote(clone, repo, ADR_3, fakeAdapter(), { applies_to: ["domain:payments"] }));
        const fm = parse(splitFrontmatter(r.text)!.frontmatterLines.join("\n")) as Record<string, unknown>;
        expect(fm.applies_to).toEqual(["domain:payments"]);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("an entry run anchors promoted_from and stamps under its heading only", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const before = readFileSync(join(repo, LOG), "utf8");
        const heading = "Cap retries at three per request";
        const r = stamped(await promote(clone, repo, LOG, fakeAdapter(), { entry: heading }));
        const fm = parse(splitFrontmatter(r.text)!.frontmatterLines.join("\n")) as Record<string, unknown>;
        expect(fm.promoted_from).toBe(`${REPO}:${LOG}#cap-retries-at-three-per-request`);
        expect(fm.title).toBe(heading);
        const marker = `## ${heading}\n`;
        const at = before.indexOf(marker) + marker.length;
        expect(readFileSync(join(repo, LOG), "utf8")).toBe(`${before.slice(0, at)}promoted_to: acme:${r.id}\n${before.slice(at)}`);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("a dry run returns the Proposal and leaves the source alone", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const before = readFileSync(join(repo, ADR_3), "utf8");
        const forge = fakeAdapter();
        const r = await promote(clone, repo, ADR_3, forge, {}, true);
        expect("dryRun" in r && r.dryRun).toBe(true);
        expect(forge.calls).toHaveLength(0);
        expect(readFileSync(join(repo, ADR_3), "utf8")).toBe(before);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test.each(["Acme: Engineering", "acme #1"])("a Bank named '%s' refuses before any push and leaves the ADR alone", async (name) => {
    await withGitBank(async ({ bare, clone }) => {
      await withConsumerRepo(async (repo) => {
        const before = readFileSync(join(repo, ADR_3), "utf8");
        const refsBefore = git(bare, "for-each-ref");
        const config = loadConfig(clone);
        const forge = fakeAdapter();
        const r = await promoteSource(
          { abs: join(repo, ADR_3), rel: ADR_3, repo: REPO, type: "Decision" },
          { config: { ...config, raw: { ...config.raw, name } }, today: TODAY, env: {}, forge, dryRun: false },
        );
        expect("refusal" in r && r.refusal).toContain("memory-bank.yaml");
        expect("refusal" in r && r.refusal).toContain(name);
        expect("refusal" in r && r.refusal).toContain("promoted_to line safely");
        expect(forge.calls).toHaveLength(0);
        expect(git(bare, "for-each-ref")).toBe(refsBefore);
        expect(readFileSync(join(repo, ADR_3), "utf8")).toBe(before);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("an adapter that throws refuses and leaves the ADR byte-identical", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const before = readFileSync(join(repo, ADR_3), "utf8");
        const r = await promote(clone, repo, ADR_3, throwingAdapter());
        expect("refusal" in r && r.refusal).toContain("opening the review failed");
        expect(readFileSync(join(repo, ADR_3), "utf8")).toBe(before);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("a source rewritten while the Proposal opened is not stamped over", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const rewritten = "# Rewritten by someone else\n";
        const forge = fakeAdapter(() => writeFileSync(join(repo, ADR_3), rewritten));
        const r = await promote(clone, repo, ADR_3, forge);
        expect("refusal" in r && r.refusal).toMatch(
          new RegExp(`^pushed ltm/propose/\\S+, but ${ADR_3} changed while the Proposal opened; add 'promoted_to: acme:\\S+' to it by hand$`),
        );
        expect(readFileSync(join(repo, ADR_3), "utf8")).toBe(rewritten);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("a stamp that can't be written reports the pushed branch and the line to add", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const abs = join(repo, ADR_3);
        const before = readFileSync(abs, "utf8");
        const forge = fakeAdapter(() => chmodSync(abs, 0o444));
        const r = await promote(clone, repo, ADR_3, forge);
        chmodSync(abs, 0o644);
        // Root ignores the mode bit, so there the write succeeds and there's no failure to see.
        if (!("refusal" in r)) return;
        expect(r.refusal).toMatch(new RegExp(`^pushed ltm/propose/\\S+, but stamping ${ADR_3} failed: .+; add 'promoted_to: acme:\\S+' to it by hand$`));
        expect(readFileSync(abs, "utf8")).toBe(before);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("refuses an already-stamped source, a nameless Bank, and a titleless source, touching nothing", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const forge = fakeAdapter();
        const stampedAdr = "---\npromoted_to: acme:X\n---\n# T\n";
        writeFileSync(join(repo, ADR_3), stampedAdr);
        const again = await promote(clone, repo, ADR_3, forge);
        expect("refusal" in again && again.refusal).toBe(`${ADR_3} already has promoted_to 'acme:X'`);

        const untitled = "docs/adr/0009-untitled.md";
        writeFileSync(join(repo, untitled), "no heading here\n");
        const notitle = await promote(clone, repo, untitled, forge);
        expect("refusal" in notitle && notitle.refusal).toBe(`${untitled} has no title; pass --title`);

        const cfg = loadConfig(clone);
        const nameless = await promoteSource(
          { abs: join(repo, ADR_4), rel: ADR_4, repo: REPO, type: "Decision" },
          { config: { ...cfg, raw: { ...cfg.raw, name: undefined } }, today: TODAY, env: {}, forge },
        );
        expect("refusal" in nameless && nameless.refusal).toBe(`${cfg.root}/memory-bank.yaml has no name to stamp promoted_to with`);

        expect(forge.calls).toHaveLength(0);
        expect(readFileSync(join(repo, ADR_3), "utf8")).toBe(stampedAdr);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("an empty --title on a titleless source reaches proposeRecord, which refuses it", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const untitled = "docs/adr/0009-untitled.md";
        writeFileSync(join(repo, untitled), "no heading here\n");
        const r = await promote(clone, repo, untitled, fakeAdapter(), { title: "" });
        expect("refusal" in r).toBe(true);
        expect(readFileSync(join(repo, untitled), "utf8")).toBe("no heading here\n");
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("flow-style ADR frontmatter refuses before any push and leaves the file alone", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const rel = "docs/adr/0009-flow.md";
        const text = "---\n{title: Example}\n---\n# Example\n";
        writeFileSync(join(repo, rel), text);
        const forge = fakeAdapter();
        const r = await promote(clone, repo, rel, forge);
        expect("refusal" in r && r.refusal).toContain("by hand");
        expect(forge.calls).toHaveLength(0);
        expect(readFileSync(join(repo, rel), "utf8")).toBe(text);
      });
    });
  }, GIT_TEST_TIMEOUT);

  test("a source reader refusal passes through", async () => {
    await withGitBank(async ({ clone }) => {
      await withConsumerRepo(async (repo) => {
        const r = await promote(clone, repo, LOG, fakeAdapter(), { entry: "No such heading" });
        expect("refusal" in r && r.refusal).toBe(`${LOG} has no '## No such heading' heading`);
      });
    });
  }, GIT_TEST_TIMEOUT);
});
