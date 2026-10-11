import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  test("a folders override outside the Bank exits 1 with one config-path line", async () => {
    await withScratch(demo, async (dir) => {
      writeFileSync(join(dir, "memory-bank.yaml"), "schema: 1\nname: acme\nfolders:\n  Decision: ../outside\n");
      const r = await ltm(dir, "query", "--json");
      const cfg = join(dir, "memory-bank.yaml");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr.startsWith(cfg)).toBe(true);
      expect(r.stderr).toContain("folders.Decision");
      expect(r.stderr.endsWith("\n")).toBe(true);
      expect(r.stderr.slice(0, -1)).not.toContain("\n");
    });
  });
});

describe("ltm query never reads outside the Bank", () => {
  const SECRET = "OUTSIDE SECRET";
  const rec = (id: string, title: string) =>
    `---\nschema: 1\nid: ${id}\nmemory_type: Decision\nstatus: accepted\ntitle: ${title}\n---\nbody\n`;

  // An outside dir holding a valid Record, so a followed link would print its title.
  async function withOutside(fn: (outside: string) => Promise<void>): Promise<void> {
    const outside = mkdtempSync(join(tmpdir(), "ltm-outside-"));
    try {
      writeFileSync(join(outside, "secret-oO0sS0eC01.md"), rec("oO0sS0eC01", SECRET));
      mkdirSync(join(outside, "decisions"));
      writeFileSync(join(outside, "decisions/secret-oO0sS0eC02.md"), rec("oO0sS0eC02", SECRET));
      await fn(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }

  const skipLine = (rel: string) => `ltm query: skipped ${rel}: symlink, not followed\n`;

  // With a real q/z beside it, Bun's realpath of q\z returns q/z, so a realpath-based
  // containment check passes while readdir follows the link outside.
  test.each([false, true])("a: a folders value with a backslash exits 1 before any walk (real q/z: %p)", async (withQz) => {
    await withOutside(async (outside) => {
      await withScratch(demo, async (dir) => {
        if (withQz) mkdirSync(join(dir, "q/z"), { recursive: true });
        symlinkSync(outside, join(dir, "q\\z"));
        writeFileSync(join(dir, "memory-bank.yaml"), 'schema: 1\nname: acme\nfolders:\n  Decision: "q\\\\z"\n');
        const r = await ltm(dir, "query", "--json");
        expect(r.stdout).not.toContain(SECRET);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toBe(
          `${join(dir, "memory-bank.yaml")}: folders.Decision 'q\\z' contains a backslash\n`,
        );
      });
    });
  });

  test("b: a q\\z symlink beside a real q/z lists only the in-Bank Record", async () => {
    await withOutside(async (outside) => {
      await withScratch(demo, async (dir) => {
        mkdirSync(join(dir, "_memory/decisions/q/z"), { recursive: true });
        writeFileSync(join(dir, "_memory/decisions/q/z/inbank-iI0nB0aN01.md"), rec("iI0nB0aN01", "In bank"));
        symlinkSync(outside, join(dir, "_memory/decisions/q\\z"));
        const r = await ltm(dir, "query", "--json");
        expect(r.stdout).not.toContain(SECRET);
        expect(r.exitCode).toBe(0);
        const rows = JSON.parse(r.stdout) as { path: string }[];
        expect(rows.map((x) => x.path)).toContain("_memory/decisions/q/z/inbank-iI0nB0aN01.md");
        expect(r.stderr).toBe(skipLine("_memory/decisions/q\\z"));
      });
    });
  });

  test("c: a q\\z symlink inside a type folder is skipped and reported", async () => {
    await withOutside(async (outside) => {
      await withScratch(demo, async (dir) => {
        symlinkSync(outside, join(dir, "_memory/decisions/q\\z"));
        const r = await ltm(dir, "query", "--json");
        expect(r.stdout).not.toContain(SECRET);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toBe(skipLine("_memory/decisions/q\\z"));
      });
    });
  });

  test("d: nested dir and .md file symlinks are skipped and reported", async () => {
    await withOutside(async (outside) => {
      await withScratch(demo, async (dir) => {
        symlinkSync(outside, join(dir, "_memory/decisions/nested"));
        symlinkSync(join(outside, "secret-oO0sS0eC01.md"), join(dir, "_memory/decisions/leak.md"));
        const r = await ltm(dir, "query", "--json");
        expect(r.stdout).not.toContain(SECRET);
        expect(r.exitCode).toBe(0);
        // readdir order isn't sorted, so compare the skip lines as a set.
        expect(r.stderr.split(/(?<=\n)/).sort()).toEqual([
          skipLine("_memory/decisions/leak.md"),
          skipLine("_memory/decisions/nested"),
        ]);
      });
    });
  });

  test("e: a symlinked type folder is skipped and reported", async () => {
    await withOutside(async (outside) => {
      await withScratch(demo, async (dir) => {
        rmSync(join(dir, "_memory/decisions"), { recursive: true });
        symlinkSync(outside, join(dir, "_memory/decisions"));
        const r = await ltm(dir, "query", "--json");
        expect(r.stdout).not.toContain(SECRET);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toBe(skipLine("_memory/decisions"));
        expect((JSON.parse(r.stdout) as unknown[]).length).toBe(11);
      });
    });
  });

  test("e: a symlinked parent of the type folders is skipped and reported once", async () => {
    await withOutside(async (outside) => {
      await withScratch(demo, async (dir) => {
        rmSync(join(dir, "_memory"), { recursive: true });
        symlinkSync(outside, join(dir, "_memory"));
        const r = await ltm(dir, "query", "--json");
        expect(r.stdout).not.toContain(SECRET);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toBe(skipLine("_memory"));
        expect(JSON.parse(r.stdout)).toEqual([]);
      });
    });
  });
});
