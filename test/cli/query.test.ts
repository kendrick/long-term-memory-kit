import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withScratch } from "../helpers/scratch.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname;
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });
const paths = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("  ")[0]!);

const MQ = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";

describe("ltm query", () => {
  test("1: memory_type=Decision lists the same paths as grep", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "query", "memory_type=Decision");
      const g = spawnSync("grep", ["-rl", "^memory_type: Decision$", "_memory/decisions"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(g.status).toBe(0);
      expect(r.exitCode).toBe(0);
      expect(paths(r.stdout).sort()).toEqual(paths(g.stdout).sort());
      expect(paths(r.stdout)).toHaveLength(5);
    });
  });

  test("2: block-style lists still match query but not the flow-style grep", async () => {
    await withScratch(demo, async (dir) => {
      const file = join(dir, MQ);
      const grepFlow = () =>
        spawnSync("grep", ["-l", "^applies_to: \\[.*service:order-service", file]).status;
      expect(grepFlow()).toBe(0);

      const before = readFileSync(file, "utf8");
      const after = before
        .replace(
          "applies_to: [service:order-service, domain:commerce]",
          "applies_to:\n  - service:order-service\n  - domain:commerce",
        )
        .replace("tags: [messaging, events]", "tags:\n  - messaging\n  - events");
      writeFileSync(file, after);
      const readBack = readFileSync(file, "utf8");
      expect(readBack).toContain("applies_to:\n  - service:order-service\n  - domain:commerce\n");
      expect(readBack).toContain("tags:\n  - messaging\n  - events\n");
      expect(readBack).not.toContain("applies_to: [");

      const a = await ltm(dir, "query", "applies_to=service:order-service");
      const t = await ltm(dir, "query", "tags=messaging");
      expect(paths(a.stdout)).toContain(MQ);
      expect(paths(t.stdout)).toContain(MQ);
      expect(grepFlow()).toBe(1);
    });
  });

  test("3: folder decides memory_type, and results flip when the file moves", async () => {
    await withScratch(demo, async (dir) => {
      const name = "folder-wins-zZ0fF0lD01.md";
      const record = [
        "---",
        "schema: 1",
        "id: zZ0fF0lD01",
        "memory_type: Context",
        "title: Folder wins",
        "status: accepted",
        "date: 2026-10-10",
        "summary: Frontmatter says Context, folder says Decision.",
        "---",
        "",
        "Body.",
        "",
      ].join("\n");
      const inDecisions = `_memory/decisions/${name}`;
      const inContext = `_memory/context/${name}`;
      writeFileSync(join(dir, inDecisions), record);

      const dec1 = await ltm(dir, "query", "memory_type=Decision");
      const ctx1 = await ltm(dir, "query", "memory_type=Context");
      expect(paths(dec1.stdout)).toContain(inDecisions);
      expect(paths(ctx1.stdout)).not.toContain(inDecisions);

      renameSync(join(dir, inDecisions), join(dir, inContext));
      const dec2 = await ltm(dir, "query", "memory_type=Decision");
      const ctx2 = await ltm(dir, "query", "memory_type=Context");
      expect(paths(dec2.stdout)).not.toContain(inContext);
      expect(paths(ctx2.stdout)).toContain(inContext);
      expect(readFileSync(join(dir, inContext), "utf8")).toBe(record);
    });
  });

  test("4: filters are ANDed and output is sorted", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "query", "memory_type=Decision", "status=accepted");
      expect(r.exitCode).toBe(0);
      expect(paths(r.stdout)).toEqual([
        "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md",
        "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md",
        "_memory/decisions/trunk-based-deployment-rX6jK1fWc9.md",
      ]);
      expect(r.stdout.split("\n")[0]).toBe(
        `${MQ}  Decision  accepted  Adopt a message queue for order events`,
      );
    });
  });

  test("5: --json prints an array with all seven keys", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "query", "--json", "memory_type=Exception");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.endsWith("\n")).toBe(true);
      const rows = JSON.parse(r.stdout) as Record<string, unknown>[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(Object.keys(row)).toEqual([
          "path",
          "id",
          "memory_type",
          "status",
          "title",
          "summary",
          "frontmatter",
        ]);
        expect(row.memory_type).toBe("Exception");
      }
    });
  });

  test("6: a filter without '=' exits 2", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "query", "status");
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("ltm query: invalid filter 'status' (expected key=value)\n");
    });
  });

  test("7: finds the Bank from a subfolder; outside any Bank exits 1 naming the dir", async () => {
    await withScratch(demo, async (dir) => {
      const fromRoot = await ltm(dir, "query", "memory_type=Decision");
      const fromSub = await ltm(join(dir, "_memory/decisions"), "query", "memory_type=Decision");
      expect(fromSub.exitCode).toBe(0);
      expect(paths(fromSub.stdout)).toEqual(paths(fromRoot.stdout));
      expect(paths(fromSub.stdout)).toHaveLength(5);
    });
    const outside = mkdtempSync(join(tmpdir(), "ltm-nobank-"));
    try {
      const r = await ltm(outside, "query", "memory_type=Decision");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a Record that won't parse is skipped on stderr and the exit stays 0", async () => {
    await withScratch(demo, async (dir) => {
      writeFileSync(join(dir, "_memory/decisions/broken-aaaaaaaaaa.md"), "no fences here\n");
      const r = await ltm(dir, "query", "memory_type=Decision");
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe(
        "ltm query: skipped _memory/decisions/broken-aaaaaaaaaa.md: no frontmatter\n",
      );
      expect(paths(r.stdout)).toHaveLength(5);
    });
  });

  test("no matches prints nothing and exits 0", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "query", "status=nonexistent-status");
      expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    });
  });

  test("a malformed memory-bank.yaml exits 1 with path:line: message", async () => {
    await withScratch(demo, async (dir) => {
      mkdirSync(join(dir, "sub"), { recursive: true });
      // Bad line is 2. No trailing newline: with one, yaml reports the line where it
      // noticed the unclosed flow (3), not where it opened.
      writeFileSync(join(dir, "memory-bank.yaml"), "schema: 1\nname: [unclosed");
      const r = await ltm(dir, "query");
      expect(r.exitCode).toBe(1);
      expect(r.stderr.startsWith(`${join(dir, "memory-bank.yaml")}:2: `)).toBe(true);
      expect(r.stderr.endsWith("\n")).toBe(true);
      expect(r.stderr.slice(0, -1)).not.toContain("\n");
    });
  });
});
