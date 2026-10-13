import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type BankConfig } from "../../src/core/bank.ts";
import {
  BEGIN,
  CLAUDE_REGION,
  COPILOT_REGION,
  END,
  normalizeRegion,
  readRegion,
  renderAgentsRegion,
  replaceRegion,
  stringList,
} from "../../src/core/init.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

// Read at test time, so a property added to the schema fails this test until the
// region covers it.
const schema = JSON.parse(
  readFileSync(new URL("../../schema/record.schema.json", import.meta.url), "utf8"),
) as { properties: Record<string, { description?: string }>; required: string[] };

const demoConfig = (): BankConfig => loadConfig(demoBank);

const configWith = (raw: Record<string, unknown>, folders: Partial<BankConfig["folders"]> = {}): BankConfig => ({
  root: "/tmp/some-bank",
  folders: {
    Decision: "_memory/decisions",
    PolicyRule: "_memory/policy-rules",
    Exception: "_memory/exceptions",
    Context: "_memory/context",
    ...folders,
  },
  raw,
});

const cells = (md: string): string[][] =>
  md
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

const root = fileURLToPath(new URL("../..", import.meta.url));

// Runs the real formatters so the test can't agree with a copy of their rules. A Bank
// that formats its Markdown must see no change in the region, or `init --check` flaps.
function formatted(tool: "prettier" | "oxfmt", text: string): string {
  const args =
    tool === "prettier"
      ? ["--no-config", "--stdin-filepath", "x.md"]
      : ["-c", join(root, "templates/formatters/oxfmtrc.json"), "--stdin-filepath=x.md"];
  const r = spawnSync(join(root, "node_modules/.bin", tool), args, { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${tool} failed: ${r.stderr}`);
  return r.stdout;
}

describe("renderAgentsRegion", () => {
  test("names every property in record.schema.json, marking the required ones", () => {
    const region = renderAgentsRegion(demoConfig(), schema);
    const names = Object.keys(schema.properties);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const row = cells(region).find((r) => r[0] === `\`${name}\``);
      expect(row, `no table row for ${name}`).toBeDefined();
      expect(row![1]).toBe(schema.required.includes(name) ? "yes" : "");
    }
  });

  test("uses the first consumers Facet as the example in the applies_to grep", () => {
    const region = renderAgentsRegion(demoConfig(), schema);
    expect(region).toContain(
      "grep -rl 'applies_to:.*service:order-service' _memory/decisions _memory/policy-rules _memory/exceptions _memory/context\n",
    );
    expect(region).toContain("grep -rl '^memory_type: PolicyRule$' _memory/policy-rules\n");
  });

  test("falls back to <first prefix>:example without consumers, and follows folder overrides", () => {
    const region = renderAgentsRegion(
      configWith({ name: "x", facet_prefixes: ["team", "service"] }, { Decision: "docs/adr" }),
      schema,
    );
    expect(region).toContain("grep -rl 'applies_to:.*team:example' docs/adr _memory/policy-rules");
    expect(region).toContain("ls docs/adr\n");
    expect(region).not.toContain("_memory/decisions");
  });

  test("lists the declared Facet prefixes, so adding one changes the region", () => {
    const before = renderAgentsRegion(configWith({ name: "x", facet_prefixes: ["service"] }), schema);
    const after = renderAgentsRegion(configWith({ name: "x", facet_prefixes: ["service", "region"] }), schema);
    expect(after).toContain("`region`");
    expect(before).not.toBe(after);
  });

  test("the funnel reads headers, then the full file, after grep has narrowed", () => {
    const region = renderAgentsRegion(demoConfig(), schema);
    const lines = /```sh\n([\s\S]*?)```/.exec(region)![1]!.trimEnd().split("\n");
    expect(lines).toContain("ltm head _memory/policy-rules/*.md");
    expect(lines).toContain("head -n 20 _memory/policy-rules/*.md");
    expect(lines).toContain("cat _memory/policy-rules/*.md");
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    expect(at("ls ")).toBeLessThan(at("grep "));
    expect(lines.findLastIndex((l) => l.startsWith("grep "))).toBeLessThan(at("ltm head "));
    expect(at("ltm head ")).toBeLessThan(at("cat "));
    expect(at("head -n 20 ")).toBeLessThan(at("cat "));
    expect(at("cat ")).toBe(lines.length - 1);
  });

  test("shell-quotes a folder that needs it", () => {
    const region = renderAgentsRegion(
      configWith({ name: "x", facet_prefixes: ["service"] }, { Context: "docs/team notes" }),
      schema,
    );
    expect(region).toContain("ls 'docs/team notes'\n");
  });
});

const v = "1.2.3";
const region = "generated line one\ngenerated line two\n";

describe("replaceRegion", () => {
  test("creates a missing file holding only the marked region", () => {
    expect(replaceRegion(null, region, v)).toBe(
      `<!-- ltm:generated:begin v1.2.3 -->\n\n${region}\n<!-- ltm:generated:end -->\n`,
    );
    expect(BEGIN(v)).toBe("<!-- ltm:generated:begin v1.2.3 -->");
    expect(END).toBe("<!-- ltm:generated:end -->");
  });

  test("appends after one blank line to a file without markers, keeping its bytes as a prefix", () => {
    const original = "# Our repo\n\nHand-written notes.\n";
    const out = replaceRegion(original, region, v);
    expect(out.startsWith(original)).toBe(true);
    expect(out).toBe(`${original}\n${BEGIN(v)}\n\n${region}\n${END}\n`);

    const noNewline = "# Our repo";
    expect(replaceRegion(noNewline, region, v)).toBe(`${noNewline}\n\n${BEGIN(v)}\n\n${region}\n${END}\n`);
  });

  test("on a file with markers, changes only the region and leaves outside text alone", () => {
    const before = "# Top\n\nkeep me\n";
    const after = "\n## Bottom\n\nkeep me too\n";
    const file = `${before}${BEGIN("0.0.1")}\nstale region\n${END}\n${after}`;
    const out = replaceRegion(file, region, v);
    expect(out.startsWith(before)).toBe(true);
    expect(out.endsWith(`${END}\n${after}`)).toBe(true);
    expect(readRegion(out)).toBe(region);
  });

  test("is idempotent", () => {
    for (const start of [null, "", "# Notes\n", `x\n${BEGIN(v)}\nold\n${END}\ny\n`]) {
      const once = replaceRegion(start, region, v);
      expect(replaceRegion(once, region, v)).toBe(once);
    }
  });

  test("refuses a begin marker with no end marker rather than appending a second region", () => {
    expect(() => replaceRegion(`${BEGIN(v)}\nhalf\n`, region, v)).toThrow();
  });
});

describe("a whole marked file", () => {
  // Formatting the region alone misses the blank lines both tools put around the markers.
  test.each(["prettier", "oxfmt"] as const)("comes back byte-identical from %s, for all three regions", (tool) => {
    for (const r of [renderAgentsRegion(demoConfig(), schema), CLAUDE_REGION, COPILOT_REGION]) {
      for (const start of [null, "# Our repo\n\nHand-written notes.\n"]) {
        const file = replaceRegion(start, r, v);
        expect(formatted(tool, file)).toBe(file);
      }
    }
  });
});

describe("normalizeRegion", () => {
  test("drops blank lines at either end and ends the body with one newline", () => {
    expect(normalizeRegion("\n\nbody\nmore\n\n\n")).toBe("body\nmore\n");
    expect(normalizeRegion("body")).toBe("body\n");
    expect(normalizeRegion("\n  \n")).toBe("");
    expect(normalizeRegion("a\n\nb\n")).toBe("a\n\nb\n");
  });
});

describe("stringList", () => {
  test("keeps only the strings of an array", () => {
    expect(stringList(["a", 1, "b", null])).toEqual(["a", "b"]);
    expect(stringList("a")).toEqual([]);
  });
});

describe("readRegion", () => {
  test("reads a formatter's blank-line-padded region and the unpadded shape the same", () => {
    const padded = `${BEGIN(v)}\n\n${region}\n${END}\n`;
    const tight = `${BEGIN(v)}\n${region}${END}\n`;
    expect(readRegion(padded)).toBe(region);
    expect(readRegion(tight)).toBe(region);
  });

  test("ignores the version in the begin marker", () => {
    const a = `pre\n${BEGIN("0.0.1")}\n${region}${END}\npost\n`;
    const b = `pre\n${BEGIN("9.9.9")}\n${region}${END}\npost\n`;
    expect(readRegion(a)).toBe(region);
    expect(readRegion(b)).toBe(readRegion(a));
  });

  test("returns null when there are no markers", () => {
    expect(readRegion("# just notes\n")).toBeNull();
  });
});

describe("duplicate and stray markers", () => {
  const block = `${BEGIN(v)}\n\n${region}\n${END}\n`;
  const twoBlocks = `${block}\nmiddle\n\n${block}`;
  const strayEnd = `${block}\nmiddle\n${END}\n`;
  const endFirst = `${END}\n${block}`;

  test.each([
    ["two complete blocks", twoBlocks, "2 ltm:generated begin markers and 2 end markers; leave one block"],
    ["a second begin after a complete block", `${block}${BEGIN(v)}\nhalf\n`, "2 ltm:generated begin markers and 1 end marker; leave one block"],
    ["an end marker after the block", strayEnd, "1 ltm:generated begin marker and 2 end markers; leave one block"],
    ["an end marker with no begin", `${END}\n`, "an ltm:generated end marker with no begin marker"],
    ["an end marker before the begin", `${END}\n${BEGIN(v)}\n`, "an ltm:generated end marker before the begin marker"],
    ["a begin with no end", `${BEGIN(v)}\nhalf\n`, "the ltm:generated begin marker has no matching end marker"],
  ])("replaceRegion throws on %s, naming the case without a version", (_name, file, message) => {
    expect(() => replaceRegion(file, region, v)).toThrow(new Error(message));
  });

  test("the message names the marker family, not the current version, for a file from another version", () => {
    const old = `${BEGIN("0.0.1")}\n\nx\n${END}\n${BEGIN("0.0.1")}\n\nx\n${END}\n`;
    let message = "";
    try {
      replaceRegion(old, region, v);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("2 ltm:generated begin markers and 2 end markers; leave one block");
    expect(message).not.toContain(v);
  });

  test("readRegion returns null on two blocks and on a stray end, so --check calls them stale", () => {
    expect(readRegion(twoBlocks)).toBeNull();
    expect(readRegion(strayEnd)).toBeNull();
    expect(readRegion(endFirst)).toBeNull();
  });
});
