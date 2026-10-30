import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { run } from "../src/cli/run.ts";

const repo = new URL("..", import.meta.url).pathname;
const FALSIFIER_PREFIX = "_command-falsifier-";
const MIN_COMMANDS = 25;
// Internal planning and agent docs, not reader docs (same split as docs-pages.test.ts).
const SKIP_DIRS = ["docs/plans", "docs/adr", "docs/agents"].map((d) => join(repo, d));

function markdownUnder(dir: string): string[] {
  if (!existsSync(dir) || SKIP_DIRS.includes(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return markdownUnder(p);
    // The falsifier writes and removes one of these; skipping them keeps a leftover or
    // concurrent run out of the real collection.
    return e.name.endsWith(".md") && !e.name.startsWith(FALSIFIER_PREFIX) ? [p] : [];
  });
}

const pagesInScope = (): string[] => [
  ...(existsSync(join(repo, "README.md")) ? [join(repo, "README.md")] : []),
  ...markdownUnder(join(repo, "guide")),
  ...markdownUnder(join(repo, "docs")),
];

type Cmd = { file: string; line: number; command: string };

// A bare ```sh fence is checked; ```bash and ```text hold lines no test runs.
function collect(path: string, text: string): Cmd[] {
  const found: Cmd[] = [];
  let fence: "sh" | "other" | null = null;
  text.split("\n").forEach((line, i) => {
    if (fence === null) {
      if (line === "```sh") fence = "sh";
      else if (line.startsWith("```")) fence = "other";
      return;
    }
    if (line.trim() === "```") fence = null;
    else if (fence === "sh" && line.startsWith("ltm ")) {
      found.push({ file: relative(repo, path), line: i + 1, command: line });
    }
  });
  return found;
}

const collectAll = (): Cmd[] => pagesInScope().flatMap((f) => collect(f, readFileSync(f, "utf8")));

const ltm = (...argv: string[]) => run({ argv, cwd: repo, env: {} });
const flagsIn = (s: string) => new Set(s.match(/--[a-z][a-z-]*/g) ?? []);
// Only the flag column counts, so a description that names another flag can't make that flag look known.
const helpFlagsIn = (help: string) => new Set([...help.matchAll(/^ {2}(--[a-z][a-z-]*)/gm)].map((m) => m[1]!));

let subcommands: Set<string> | undefined;
const helpFlags = new Map<string, Promise<Set<string>>>();

async function subcommandList(): Promise<Set<string>> {
  subcommands ??= new Set(
    [...(await ltm("--help")).stdout.matchAll(/^ {2}(\S+) {2}/gm)].map((m) => m[1]!),
  );
  return subcommands;
}

function flagsOf(sub: string): Promise<Set<string>> {
  if (!helpFlags.has(sub)) helpFlags.set(sub, ltm(sub, "--help").then((r) => helpFlagsIn(r.stdout)));
  return helpFlags.get(sub)!;
}

async function failure(c: Cmd): Promise<string | null> {
  const where = `${c.file}:${c.line}: ${c.command}`;
  const words = c.command.split(/\s+/);
  const body = c.command.split(/\s#/)[0]!;
  const used = flagsIn(body);
  const sub = words[1]!;
  // ltm --help and ltm --version are the top-level forms.
  if (sub === "--help" || sub === "--version") return null;
  if (!(await subcommandList()).has(sub)) return `${where}\nno subcommand "${sub}"`;
  const known = await flagsOf(sub);
  const missing = [...used].filter((f) => f !== "--help" && !known.has(f));
  return missing.length ? `${where}\n${sub} has no ${missing.join(", ")}` : null;
}

function withFalsifier<T>(body: string, fn: (cmds: Cmd[]) => T): T {
  const path = join(repo, "guide", `${FALSIFIER_PREFIX}${process.pid}.md`);
  writeFileSync(path, body);
  try {
    return fn(collect(path, readFileSync(path, "utf8")));
  } finally {
    rmSync(path, { force: true });
  }
}

describe("documented ltm commands", () => {
  test(`at least ${MIN_COMMANDS} ltm command lines are documented`, () => {
    expect(collectAll().length).toBeGreaterThanOrEqual(MIN_COMMANDS);
  });

  test("every documented ltm command and flag exists", async () => {
    const failures = (await Promise.all(collectAll().map(failure))).filter((f) => f !== null);
    expect(failures.join("\n")).toBe("");
  });
});

describe("the command check's falsifier", () => {
  const fence = (kind: string, line: string) => `\`\`\`${kind}\n${line}\n\`\`\`\n`;

  test("a flag ltm query lacks fails", async () => {
    const cmds = withFalsifier(fence("sh", "ltm query --facets x"), (c) => c);
    expect(cmds).toHaveLength(1);
    expect(await failure(cmds[0]!)).not.toBeNull();
  });

  test("the real flag passes", async () => {
    const cmds = withFalsifier(fence("sh", "ltm query --facet x"), (c) => c);
    expect(cmds).toHaveLength(1);
    expect(await failure(cmds[0]!)).toBeNull();
  });

  test("the same bad line in a text fence isn't collected", () => {
    withFalsifier(fence("text", "ltm query --facets x"), (c) => expect(c).toHaveLength(0));
  });
});

const slug = (h: string) =>
  h.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");

function headingSlugs(text: string): Set<string> {
  let fenced = false;
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced) {
      const m = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
      if (m) out.add(slug(m[1]!.replace(/`/g, "")));
    }
  }
  return out;
}

function brokenLinks(path: string, text: string): string[] {
  const prose = text
    .split("\n")
    .reduce<{ out: string[]; fenced: boolean }>(
      (acc, line) => {
        // Keep a blank slot per fence line so reported line numbers stay real.
        if (line.startsWith("```")) {
          acc.fenced = !acc.fenced;
          acc.out.push("");
        } else acc.out.push(acc.fenced ? "" : line.replace(/`[^`]*`/g, ""));
        return acc;
      },
      { out: [], fenced: false },
    ).out;
  const bad: string[] = [];
  prose.forEach((line, i) => {
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [file, anchor] = target.split("#") as [string, string | undefined];
      const dest = file === "" ? path : resolve(dirname(path), file);
      const at = `${relative(repo, path)}:${i + 1}: ${target}`;
      if (!existsSync(dest)) bad.push(`${at} (no such file)`);
      else if (anchor && !(dest.endsWith(".md") && headingSlugs(readFileSync(dest, "utf8")).has(anchor)))
        bad.push(`${at} (no such anchor)`);
    }
  });
  return bad;
}

describe("relative links and anchors", () => {
  test("none is broken", () => {
    const bad = pagesInScope().flatMap((f) => brokenLinks(f, readFileSync(f, "utf8")));
    expect(bad.join("\n")).toBe("");
  });

  test("a missing file and a missing anchor are both caught", () => {
    const path = join(repo, "docs", "doctor.md");
    const real = [...headingSlugs(readFileSync(path, "utf8"))][0]!;
    const text = `[a](nope.md) [b](#${real}) [c](#absent) [d](supersession.md) \`[e](nope.md)\`\n\`\`\`sh\n[f](nope.md)\n\`\`\`\n`;
    expect(brokenLinks(path, text)).toEqual([
      "docs/doctor.md:1: nope.md (no such file)",
      "docs/doctor.md:1: #absent (no such anchor)",
    ]);
  });
});

describe("README", () => {
  test("Promote a decision is its second, third, or fourth ## heading", () => {
    const headings = readFileSync(join(repo, "README.md"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim());
    expect([1, 2, 3]).toContain(headings.indexOf("Promote a decision"));
  });
});
