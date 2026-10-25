import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const FALSIFIER_PREFIX = "_grep-falsifier-";

// Reader docs only. docs/plans, docs/adr, and docs/agents predate the glossary rules.
function pagePaths(dir: string): string[] {
  const d = join(repo, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((n) => n.endsWith(".md") && !n.startsWith(FALSIFIER_PREFIX))
    .map((n) => join(d, n));
}
const pages = [...pagePaths("docs"), ...pagePaths("docs/types")];
const typePages = pagePaths("docs/types");
const rel = (p: string) => relative(repo, p);

const PAGES_WITH_LINK_RULES = [
  "docs/retrieval-model.md",
  "docs/design-forces.md",
  "docs/supersession.md",
  "docs/types/decision.md",
  "docs/types/policy-rule.md",
  "docs/types/exception.md",
  "docs/types/context.md",
];
const linkRulePages = pages.filter((p) => PAGES_WITH_LINK_RULES.includes(rel(p)));

test("every page with link rules exists", () => {
  for (const p of PAGES_WITH_LINK_RULES) expect(existsSync(join(repo, p)), `${p} is missing`).toBe(true);
});

const linkTargets = (text: string): string[] =>
  [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!.split("#")[0]!)
    .filter((t) => t !== "" && !/^[a-z]+:/i.test(t));

describe("links", () => {
  for (const page of linkRulePages) {
    test(`${rel(page)} links to a docs page and to a schema or ADR`, () => {
      const targets = linkTargets(readFileSync(page, "utf8")).map((t) => resolve(dirname(page), t));
      for (const t of targets) expect(existsSync(t), `${rel(page)} links to missing ${rel(t)}`).toBe(true);
      const rels = targets.map(rel);
      expect(rels.some((r) => /^docs\/(types\/)?[^/]+\.md$/.test(r) && r !== rel(page))).toBe(true);
      expect(rels.some((r) => /^schema\/[^/]+\.json$/.test(r) || /^docs\/adr\/[^/]+\.md$/.test(r))).toBe(true);
    });
  }
});

describe("no field tables", () => {
  const FIELDS = ["title", "status", "date", "applies_to", "summary"];
  for (const page of pages) {
    test(rel(page), () => {
      const cells = readFileSync(page, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("|"))
        .flatMap((l) => l.split("|").map((c) => c.replaceAll("`", "").trim()));
      const hits = FIELDS.filter((f) => cells.includes(f));
      expect(hits.length, `${rel(page)} tabulates ${hits.join(", ")}`).toBeLessThan(3);
    });
  }
});

describe("fixture citations in docs/types", () => {
  const bank = join(repo, "fixtures/demo-bank");
  const ids = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        const m = /^id: (\S+)$/m.exec(readFileSync(p, "utf8"));
        if (m) ids.add(m[1]!);
      }
    }
  };
  walk(join(bank, "_memory"));
  // A digit and a capital keep field names like `applies_to` from reading as ids.
  const ID = /^(?=.*[0-9])(?=.*[A-Z])[A-Za-z0-9_-]{10}$/;

  for (const page of typePages) {
    test(rel(page), () => {
      const text = readFileSync(page, "utf8");
      for (const t of linkTargets(text).filter((x) => x.includes("fixtures/demo-bank/"))) {
        expect(existsSync(resolve(dirname(page), t)), `${rel(page)} cites missing ${t}`).toBe(true);
      }
      for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        if (ID.test(m[1]!)) expect(ids.has(m[1]!), `${rel(page)} cites unknown id ${m[1]}`).toBe(true);
      }
    });
  }
});

describe("glossary avoid-terms", () => {
  // Everyday words the pages need in their ordinary sense, so only the glossary sense is avoided.
  const SKIP = new Set([
    "rule", "scope", "entry", "tag", "label", "memory", "note", "document", "standard", "override",
    "background", "fact", "input", "import", "global", "dead", "draft", "approval", "adr",
  ]);
  const glossary = readFileSync(join(repo, "GLOSSARY.md"), "utf8");
  const terms = [
    ...new Set(
      glossary
        .split("\n")
        .filter((l) => l.startsWith("_Avoid_:"))
        .flatMap((l) =>
          l
            .slice("_Avoid_:".length)
            .replace(/\([^)]*\)/g, "")
            .split(",")
            .map((t) => t.trim().toLowerCase()),
        )
        .filter((t) => t !== "" && !SKIP.has(t)),
    ),
  ];

  const prose = (text: string): string[] =>
    text
      .split("\n")
      .reduce<{ out: string[]; fenced: boolean }>(
        (acc, line) => {
          // Delimiters keep a blank slot so a hit's index stays its real line number.
          if (line.startsWith("```")) {
            acc.fenced = !acc.fenced;
            acc.out.push("");
          } else acc.out.push(acc.fenced ? "" : line);
          return acc;
        },
        { out: [], fenced: false },
      )
      .out.map((l) =>
        l
          .replace(/`[^`]*`/g, "")
          .replace(/\]\([^)]*\)/g, "]")
          .replace(/"[^"]*"|“[^”]*”/g, ""),
      );

  test("prose keeps one slot per source line, fence delimiters included", () => {
    const lines = prose("a\n```sh\ngrep x\n```\nlast");
    expect(lines).toEqual(["a", "", "", "", "last"]);
  });

  test("the glossary yields avoid-terms", () => {
    expect(terms.length).toBeGreaterThan(10);
  });

  for (const page of pages) {
    test(rel(page), () => {
      const hits: string[] = [];
      prose(readFileSync(page, "utf8")).forEach((line, i) => {
        for (const t of terms) {
          const re = new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
          if (re.test(line)) hits.push(`${rel(page)}:${i + 1}: "${t}"`);
        }
      });
      expect(hits.join("\n")).toBe("");
    });
  }
});
