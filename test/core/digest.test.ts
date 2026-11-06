import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/core/bank.ts";
import {
  digestFiles,
  digestRecords,
  facetFileName,
  PLACEHOLDER_MARK,
  renderDigest,
  SIZE_LIMIT,
  sizeWarnings,
  writeDigest,
} from "../../src/core/digest.ts";
import { listRecords, selectRecords } from "../../src/core/query.ts";
import { withScratch } from "../helpers/scratch.ts";

const DEMO = resolve(import.meta.dir, "../../fixtures/demo-bank");
const RULE = "cA9wE6uJr3";
const EXC = "wJ3nC7hTy4";
const ORG = "aW7kC3oRf2";

const load = (dir: string) => {
  const config = loadConfig(dir);
  return { config, all: listRecords(config, () => {}) };
};
const ids = (rs: { frontmatter: Record<string, unknown> }[]) => rs.map((r) => r.frontmatter.id as string).sort();
const pathOf = (dir: string, id: string): string => {
  const p = listRecords(loadConfig(dir), () => {}).find((r) => r.frontmatter.id === id)!.path;
  return join(dir, p);
};
const edit = (dir: string, id: string, from: string, to: string) => {
  const p = pathOf(dir, id);
  const text = readFileSync(p, "utf8");
  expect(text).toContain(from);
  writeFileSync(p, text.replace(from, to));
};
const entryOf = (md: string, id: string): string => {
  const start = md.indexOf(`(${id})\n`);
  expect(start).toBeGreaterThan(-1);
  const next = md.indexOf("\n### ", start);
  return md.slice(start, next === -1 ? undefined : next);
};
const readAll = (dir: string) =>
  Object.fromEntries(readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), "utf8")]));

describe("digest", () => {
  test("1: selects the same ids as ltm query --status accepted", async () => {
    await withScratch(DEMO, async (dir) => {
      const { all } = load(dir);
      const expected = selectRecords(all, { filters: [], statuses: ["accepted"], facets: [], all: false });
      expect(ids(digestRecords(all, "2026-11-05"))).toEqual(ids(expected));
    });
  });

  test("2: an Exception drops the day after effective_to, not on it", async () => {
    await withScratch(DEMO, async (dir) => {
      const { all } = load(dir);
      expect(ids(digestRecords(all, "2027-04-01"))).not.toContain(EXC);
      expect(ids(digestRecords(all, "2027-03-31"))).toContain(EXC);
    });
  });

  test("3: status edit removes an id; title edit keeps it; applies_to edit moves it between split files", async () => {
    await withScratch(DEMO, async (dir) => {
      edit(dir, ORG, "status: accepted", "status: proposed");
      edit(dir, RULE, "title: No cross-service DB reads", "title: Renamed rule");
      const { all } = load(dir);
      const got = ids(digestRecords(all, "2026-11-05"));
      expect(got).not.toContain(ORG);
      expect(got).toContain(RULE);
    });
    await withScratch(DEMO, async (dir) => {
      const config = loadConfig(dir);
      const before = digestFiles({ config, all: load(dir).all, today: "2026-11-05", split: true });
      const rule = load(dir).all.find((r) => r.frontmatter.id === RULE)!;
      const old = readFileSync(pathOf(dir, RULE), "utf8").match(/^applies_to: .*$/m)![0];
      edit(dir, RULE, old, "applies_to: [domain:moved-away]");
      const { all } = load(dir);
      expect(ids(digestRecords(all, "2026-11-05"))).toContain(RULE);
      const single = digestFiles({ config, all, today: "2026-11-05", split: false })[0]!.content;
      expect(single).toContain(`(${RULE})`);
      const after = digestFiles({ config, all, today: "2026-11-05", split: true });
      const has = (fs: typeof after, n: string) => fs.find((f) => f.name === n)?.content.includes(`(${RULE})\n`);
      expect(has(after, facetFileName("domain:moved-away"))).toBe(true);
      expect(rule).toBeDefined();
      for (const f of before) if (f.content.includes(`(${RULE})\n`)) expect(has(after, f.name) ?? false).toBe(false);
    });
  });

  test("4: PolicyRule lists its Exception and the Exception quotes the PolicyRule", () => {
    const { config, all } = load(DEMO);
    const picked = digestRecords(all, "2026-11-05");
    const md = renderDigest({ config, all, picked, scope: "all accepted Records" });
    expect(entryOf(md, RULE)).toContain(`(${EXC})`);
    const rule = all.find((r) => r.frontmatter.id === RULE)!.frontmatter;
    const exc = entryOf(md, EXC);
    expect(exc).toContain(`${rule.title} (${RULE})`);
    expect(exc).toContain(rule.summary as string);
  });

  test("4b: under --split the PolicyRule's file still lists an Exception filed under another Facet", () => {
    const { config, all } = load(DEMO);
    const files = digestFiles({ config, all, today: "2026-11-05", split: true });
    const commerce = files.find((f) => f.name === facetFileName("domain:commerce"))!;
    expect(commerce.content).not.toContain(`(${EXC})\n`);
    expect(entryOf(commerce.content, RULE)).toContain(`(${EXC})`);
  });

  test("4c: a malformed applies_to appears in the single file only", async () => {
    await withScratch(DEMO, async (dir) => {
      const old = readFileSync(pathOf(dir, RULE), "utf8").match(/^applies_to: .*$/m)![0];
      edit(dir, RULE, old, "applies_to: {a: b}");
      const { config, all } = load(dir);
      const at = (split: boolean) => digestFiles({ config, all, today: "2026-11-05", split });
      expect(at(false)[0]!.content).toContain(`(${RULE})\n`);
      expect(at(true).some((f) => f.content.includes(`(${RULE})\n`))).toBe(false);
    });
  });

  test("5: a superseded PolicyRule leaves the Exception with a not-in-force note", async () => {
    await withScratch(DEMO, async (dir) => {
      edit(dir, RULE, "status: accepted", "status: superseded");
      const { config, all } = load(dir);
      const md = renderDigest({ config, all, picked: digestRecords(all, "2026-11-05"), scope: "x" });
      expect(entryOf(md, EXC)).toContain("That PolicyRule is no longer in force.");
    });
  });

  test("6: bodies appear in full and no markdown table survives outside a fence", async () => {
    await withScratch(DEMO, async (dir) => {
      const p = pathOf(dir, RULE);
      writeFileSync(p, `${readFileSync(p, "utf8")}\n| a | b |\n|---|---|\n| 1 | 2 |\n\nName | Port\n--- | ---\napi | 8080\n`);
      const { config, all } = load(dir);
      const picked = digestRecords(all, "2026-11-05");
      const md = renderDigest({ config, all, picked, scope: "x" });
      for (const r of picked) {
        const body = readFileSync(join(dir, r.path), "utf8").split(/^---\r?$/m).slice(2).join("---").trim();
        for (const row of body.split("\n").filter((l) => l.trim().startsWith("|"))) expect(md).toContain(row);
        expect(md).toContain(body.split("\n")[0]!);
      }
      const fencedPlain = md.split("```text\n").some((chunk) => chunk.startsWith("Name | Port\n--- | ---\napi | 8080\n```"));
      expect(fencedPlain).toBe(true);
      let fenced = false;
      for (const line of md.split("\n")) {
        if (line.startsWith("```")) fenced = !fenced;
        else if (!fenced) expect(/^\s*\|.*\|\s*$/.test(line)).toBe(false);
      }
    });
  });

  test("6b: a foreign .md in the out dir survives; split always writes org-wide.md", async () => {
    await withScratch(DEMO, async (dir) => {
      const out = join(dir, "out");
      mkdirSync(out);
      writeFileSync(join(out, "README.md"), "# mine\n\nhello\n");
      const old = readFileSync(pathOf(dir, ORG), "utf8").match(/^applies_to: .*$/m)?.[0];
      if (old) edit(dir, ORG, old, "applies_to: [team:x]");
      else edit(dir, ORG, "owners:", "applies_to: [team:x]\nowners:");
      const { config, all } = load(dir);
      const files = digestFiles({ config, all, today: "2026-11-05", split: true });
      const org = files.find((f) => f.name === "org-wide.md")!;
      expect(org).toBeDefined();
      expect(org.content).not.toContain("### ");
      writeDigest(out, files, true, "2026-11-05");
      expect(readFileSync(join(out, "README.md"), "utf8")).toBe("# mine\n\nhello\n");
    });
  });

  test("7: facet file names escape every byte outside a-z0-9-", () => {
    expect(facetFileName("service:order-service")).toBe("service_3aorder-service.md");
    expect(facetFileName("a_b")).toBe("a_5fb.md");
  });

  test("8: split writes one file per Facet plus org-wide.md", () => {
    const { config, all } = load(DEMO);
    const files = digestFiles({ config, all, today: "2026-11-05", split: true });
    const facets = new Set<string>();
    for (const r of digestRecords(all, "2026-11-05")) {
      const a = r.frontmatter.applies_to;
      if (Array.isArray(a)) for (const f of a) facets.add(f as string);
    }
    expect(files.map((f) => f.name)).toEqual([...facets.keys()].map(facetFileName).concat("org-wide.md").sort());
    const withOrg = files.filter((f) => f.content.includes(`(${ORG})`)).map((f) => f.name);
    expect(withOrg).toEqual(["org-wide.md"]);
    const two = digestRecords(all, "2026-11-05").find((r) => Array.isArray(r.frontmatter.applies_to) && r.frontmatter.applies_to.length > 1);
    if (two) {
      const id = two.frontmatter.id as string;
      expect(files.filter((f) => f.content.includes(`(${id})`)).length).toBe((two.frontmatter.applies_to as string[]).length);
    }
  });

  test("9: two runs leave every file byte-identical", async () => {
    await withScratch(DEMO, async (dir) => {
      const { config, all } = load(dir);
      for (const split of [false, true]) {
        const out = join(dir, "out");
        const run = () => writeDigest(out, digestFiles({ config, all, today: "2026-11-05", split }), split, "2026-11-05");
        run();
        const first = readAll(out);
        run();
        expect(readAll(out)).toEqual(first);
        mkdirSync(join(dir, "out2"), { recursive: true });
      }
    });
  });

  test("10: switching modes writes placeholders, leaves them alone, and spares non-.md files", async () => {
    await withScratch(DEMO, async (dir) => {
      const { config, all } = load(dir);
      const out = join(dir, "out");
      const go = (split: boolean, today: string) =>
        writeDigest(out, digestFiles({ config, all, today, split }), split, today);
      go(false, "2026-11-05");
      writeFileSync(join(out, "notes.txt"), "keep");
      go(true, "2026-11-05");
      const acc = readFileSync(join(out, "accepted.md"), "utf8");
      expect(acc.startsWith(PLACEHOLDER_MARK)).toBe(true);
      expect(acc).toContain("the per-Facet files");
      go(true, "2026-11-06");
      expect(readFileSync(join(out, "accepted.md"), "utf8")).toBe(acc);
      go(false, "2026-11-06");
      const facet = readFileSync(join(out, "service_3aorder-service.md"), "utf8");
      expect(facet.startsWith(PLACEHOLDER_MARK)).toBe(true);
      expect(facet).toContain("accepted.md");
      expect(readFileSync(join(out, "accepted.md"), "utf8")).not.toContain(PLACEHOLDER_MARK);
      expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("keep");
    });
  });

  test("11: size warning fires only over the limit", () => {
    const f = (n: number) => [{ name: "accepted.md", content: "x".repeat(n) }];
    const w = sizeWarnings(f(SIZE_LIMIT + 1));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("--split facet");
    expect(sizeWarnings(f(SIZE_LIMIT))).toEqual([]);
  });
});
