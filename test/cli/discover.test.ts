import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const sources = join(repo, "fixtures/hydration-sources");
const demo = join(repo, "fixtures/demo-bank");
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });
type Row = { path: string; kind: string; title: string; bytes: number; cited_by: string[] | null };
const rows = (stdout: string) => JSON.parse(stdout) as Row[];
const kindOf = (stdout: string, path: string) => rows(stdout).find((r) => r.path === path)?.kind;
const POSTGRES = "fixtures/hydration-sources/adr/0001-postgres.md";
const RECORD = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";

describe("ltm discover", () => {
  test("1: the corpus lists seven entries with the expected kinds", async () => {
    const r = await ltm(repo, "discover", "fixtures/hydration-sources", "--json", "--bank", "fixtures/demo-bank");
    expect(r.exitCode).toBe(0);
    const got = rows(r.stdout);
    expect(got.map((e) => [e.path, e.kind])).toEqual([
      ["fixtures/hydration-sources/adr/0001-postgres.md", "adr"],
      ["fixtures/hydration-sources/adr/0002-event-bus.md", "adr"],
      ["fixtures/hydration-sources/adr/0003-no-shared-db.md", "adr"],
      ["fixtures/hydration-sources/notes.md", "document"],
      ["fixtures/hydration-sources/pr-1234.json", "pr"],
      ["fixtures/hydration-sources/prd-checkout.md", "prd"],
      ["fixtures/hydration-sources/transcripts/arch-sync-2026-09.vtt", "transcript"],
    ]);
    expect(got.find((e) => e.path === POSTGRES)?.cited_by).toEqual(["kQ7vN2xLp4"]);
  });

  test("2: headings classify a moved ADR; Background needs an alias", async () => {
    await withScratch(sources, async (dir) => {
      mkdirSync(join(dir, "misc"));
      renameSync(join(dir, "adr/0002-event-bus.md"), join(dir, "misc/event-bus.md"));
      const r1 = await ltm(dir, "discover", ".", "--json");
      expect(kindOf(r1.stdout, "misc/event-bus.md")).toBe("adr");

      const file = join(dir, "misc/event-bus.md");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("## Context and Problem Statement", "## Background"),
      );
      const readBack = readFileSync(file, "utf8");
      expect(readBack).toContain("## Background\n");
      expect(readBack).not.toContain("Context and Problem Statement");
      const r2 = await ltm(dir, "discover", ".", "--json");
      expect(kindOf(r2.stdout, "misc/event-bus.md")).toBe("document");

      await withScratch(demo, async (bank) => {
        const cfg = join(bank, "memory-bank.yaml");
        writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\nheading_aliases: { Context: [Background] }\n`);
        expect(readFileSync(cfg, "utf8")).toContain("heading_aliases: { Context: [Background] }\n");
        const r3 = await ltm(dir, "discover", ".", "--json", "--bank", bank);
        expect(r3.exitCode).toBe(0);
        expect(kindOf(r3.stdout, "misc/event-bus.md")).toBe("adr");
      });
    });
  });

  test("3: four speaker lines are a document, five a transcript", async () => {
    await withScratch(sources, async (dir) => {
      const lines = ["Ana: hi", "Ben: hello", "Ana: status?", "Ben: green", "Ana: ship it"];
      const file = join(dir, "talk.txt");
      writeFileSync(file, `${lines.slice(0, 4).join("\n")}\n`);
      expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(4);
      expect(kindOf((await ltm(dir, "discover", "talk.txt", "--json")).stdout, "talk.txt")).toBe("document");
      writeFileSync(file, `${lines.join("\n")}\n`);
      expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(5);
      expect(kindOf((await ltm(dir, "discover", "talk.txt", "--json")).stdout, "talk.txt")).toBe("transcript");
    });
  });

  test("4: only source_refs counts as a citation", async () => {
    await withScratch(demo, async (bank) => {
      const cited = async () =>
        rows((await ltm(repo, "discover", "fixtures/hydration-sources/adr/0001-postgres.md", "--json", "--bank", bank)).stdout)[0]!
          .cited_by;
      expect(await cited()).toEqual(["kQ7vN2xLp4"]);

      const file = join(bank, RECORD);
      const original = readFileSync(file, "utf8");
      const line = `source_refs: [${POSTGRES}]\n`;
      expect(original).toContain(line);

      const stripped = original.replace(line, "");
      writeFileSync(file, stripped);
      expect(readFileSync(file, "utf8")).not.toContain("source_refs");
      expect(await cited()).toEqual([]);

      const related = stripped.replace("tags: [database, postgres]\n", `tags: [database, postgres]\nrelated: [${POSTGRES}]\n`);
      writeFileSync(file, related);
      expect(readFileSync(file, "utf8")).toContain(`related: [${POSTGRES}]\n`);
      expect(await cited()).toEqual([]);

      const body = related.replace("## Consequences\n", `## Consequences\nSee ${POSTGRES}.\n`);
      writeFileSync(file, body);
      expect(readFileSync(file, "utf8")).toContain(`See ${POSTGRES}.\n`);
      expect(await cited()).toEqual([]);
    });
  });

  test("5: outside any Bank, cited_by is null on every entry", async () => {
    await withScratch(sources, async (dir) => {
      const r = await ltm(dir, "discover", ".", "--json");
      expect(r.exitCode).toBe(0);
      expect(rows(r.stdout)).toHaveLength(7);
      expect(rows(r.stdout).every((e) => e.cited_by === null)).toBe(true);
    });
  });

  test("6: discover leaves the repo byte-identical", async () => {
    const status = () => spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    const before = status();
    expect(before.status).toBe(0);
    const r = await ltm(repo, "discover", "fixtures/hydration-sources", "--bank", "fixtures/demo-bank");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toBe("");
    const after = status();
    expect(after.status).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  test("7: a missing path is reported, the rest still list, exit 1", async () => {
    const r = await ltm(repo, "discover", "fixtures/hydration-sources", "nope/missing");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ltm discover: nope/missing: no such file or directory\n");
    expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(7);
  });

  test("8: human output ends the cited ADR line with the citation", async () => {
    const r = await ltm(repo, "discover", "fixtures/hydration-sources", "--bank", "fixtures/demo-bank");
    expect(r.exitCode).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.includes(" fixtures/hydration-sources/adr/0001-postgres.md "));
    expect(line).toBeDefined();
    expect(line!.endsWith("  (cited: kQ7vN2xLp4)")).toBe(true);
    expect(line!.startsWith("adr  ")).toBe(true);
  });

  test("9: --bank at a directory with no memory-bank.yaml exits 1", async () => {
    const r = await ltm(repo, "discover", "fixtures/hydration-sources", "--bank", "fixtures/hydration-sources");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("ltm discover: --bank fixtures/hydration-sources: no memory-bank.yaml there\n");
    expect(r.stdout).toBe("");
  });

  test("10: a symlinked memory-bank.yaml reads as no config", async () => {
    await withScratch(demo, async (bank) => {
      const cfg = join(bank, "memory-bank.yaml");
      renameSync(cfg, join(bank, "real.yaml"));
      symlinkSync(join(bank, "real.yaml"), cfg);
      expect(lstatSync(cfg).isSymbolicLink()).toBe(true);
      const r = await ltm(repo, "discover", "fixtures/hydration-sources", "--bank", bank);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe(`ltm discover: --bank ${bank}: no memory-bank.yaml there\n`);
    });
  });

  test("11: an invalid memory-bank.yaml is a prefixed ConfigError, exit 1", async () => {
    await withScratch(demo, async (bank) => {
      const cfg = join(bank, "memory-bank.yaml");
      writeFileSync(cfg, "schema: [unclosed\n");
      expect(readFileSync(cfg, "utf8")).toBe("schema: [unclosed\n");
      const r = await ltm(repo, "discover", "fixtures/hydration-sources", "--bank", bank);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.startsWith("ltm discover: ")).toBe(true);
      expect(r.stderr).toContain(cfg);
      expect(r.stdout).toBe("");
    });
  });

  test("12: without --bank, a symlinked memory-bank.yaml above cwd is a ConfigError, exit 1", async () => {
    await withScratch(demo, async (bank) => {
      const cfg = join(bank, "memory-bank.yaml");
      renameSync(cfg, join(bank, "real.yaml"));
      symlinkSync("real.yaml", cfg);
      expect(lstatSync(cfg).isSymbolicLink()).toBe(true);
      const r = await ltm(join(bank, "_memory"), "discover", ".");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe(`ltm discover: ${cfg}: memory-bank.yaml is a symlink, not followed\n`);
      expect(r.stdout).toBe("");
    });
  });

  test("the folder rule sees the enclosing adr directory from inside it", async () => {
    const r = await ltm(join(sources, "adr"), "discover", ".", "--json");
    expect(r.exitCode).toBe(0);
    expect(kindOf(r.stdout, "0001-postgres.md")).toBe("adr");
  });

  test("the folder rule uses the repo root when .git exists, else the cwd", async () => {
    const make = async (withGit: boolean) => {
      const dir = await mkdtemp(join(tmpdir(), "ltm-folder-"));
      if (withGit) mkdirSync(join(dir, ".git"));
      mkdirSync(join(dir, "adr"));
      writeFileSync(join(dir, "adr/x.md"), "just prose\n");
      return dir;
    };
    const a = await make(true);
    const b = await make(false);
    try {
      expect(kindOf((await ltm(join(a, "adr"), "discover", ".", "--json")).stdout, "x.md")).toBe("adr");
      expect(kindOf((await ltm(join(b, "adr"), "discover", ".", "--json")).stdout, "x.md")).toBe("document");
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });
});
