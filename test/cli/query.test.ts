import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
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
import { parse } from "yaml";
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
      const r = await ltm(dir, "query", "--all", "memory_type=Decision");
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

  test("5: --json prints an array with all eight keys", async () => {
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
          "is_proposal",
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
      const fromRoot = await ltm(dir, "query", "--all", "memory_type=Decision");
      const fromSub = await ltm(join(dir, "_memory/decisions"), "query", "--all", "memory_type=Decision");
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
      const r = await ltm(dir, "query", "--all", "memory_type=Decision");
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
      // Pins the line-less `<path>: <message>` form; the checks above let a changed separator through.
      expect(r.stderr).toBe(`${cfg}: folders.Decision '../outside' is outside the Bank root\n`);
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
        const r = await ltm(dir, "query", "--json", "--all");
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

const rec = (id: string, extra: string[] = [], title = `T ${id}`) =>
  [
    "---",
    "schema: 1",
    `id: ${id}`,
    "memory_type: Decision",
    `title: ${title}`,
    "status: accepted",
    "date: 2026-10-12",
    "summary: S.",
    ...extra,
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
const MYSQL = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";
const OTEL = "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md";
const PG = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";

describe("ltm query options", () => {
  test("1: retired Records are hidden unless named or --all", async () => {
    await withScratch(demo, async (dir) => {
      const dflt = await ltm(dir, "query", "--type", "Decision");
      const sup = await ltm(dir, "query", "--type", "Decision", "--status", "superseded");
      const all = await ltm(dir, "query", "--type", "Decision", "--all");
      const acc = await ltm(dir, "query", "--type", "Decision", "--status", "accepted");
      expect(paths(dflt.stdout)).not.toContain(MYSQL);
      expect(paths(sup.stdout)).toEqual([MYSQL]);
      expect(paths(all.stdout)).toContain(MYSQL);
      expect(paths(acc.stdout)).not.toContain(MYSQL);
    });
  });

  test("2: --facet unions org-wide Records, and flips when applies_to is rewritten", async () => {
    await withScratch(demo, async (dir) => {
      const none = "_memory/decisions/no-scope-aaaaaaaaa1.md";
      const com = "_memory/decisions/commerce-scope-aaaaaaa2.md";
      const pay = "_memory/decisions/payments-scope-aaaaaaa3.md";
      writeFileSync(join(dir, none), rec("aaaaaaaaa1"));
      writeFileSync(join(dir, com), rec("aaaaaaaaa2", ["applies_to: [domain:commerce]"]));
      writeFileSync(join(dir, pay), rec("aaaaaaaaa3", ["applies_to: [service:payments]"]));
      const args = ["query", "--facet", "service:order-service", "--facet", "domain:commerce"];
      const before = paths((await ltm(dir, ...args)).stdout);
      expect(before).toContain(none);
      expect(before).toContain(com);
      expect(before).not.toContain(pay);

      writeFileSync(join(dir, pay), rec("aaaaaaaaa3", ["applies_to: [service:order-service]"]));
      expect(readFileSync(join(dir, pay), "utf8")).toContain("applies_to: [service:order-service]");
      expect(paths((await ltm(dir, ...args)).stdout)).toContain(pay);
    });
  });

  test("3: applies_to=value keeps containment, no org-wide union", async () => {
    await withScratch(demo, async (dir) => {
      const none = "_memory/decisions/no-scope-aaaaaaaaa1.md";
      writeFileSync(join(dir, none), rec("aaaaaaaaa1"));
      const r = await ltm(dir, "query", "applies_to=domain:commerce");
      expect(r.exitCode).toBe(0);
      expect(paths(r.stdout)).not.toContain(none);
      expect(paths(r.stdout).length).toBeGreaterThan(0);
    });
  });

  test("4: proposals get a (proposal) suffix and is_proposal in JSON", async () => {
    await withScratch(demo, async (dir) => {
      const r = await ltm(dir, "query", "--type", "Decision");
      const marked = r.stdout.split("\n").filter((l) => l.endsWith("  (proposal)"));
      expect(marked).toHaveLength(1);
      expect(marked[0]!.startsWith(OTEL)).toBe(true);
      const j = await ltm(dir, "query", "--json", "--type", "Decision");
      const rows = JSON.parse(j.stdout) as { path: string; is_proposal: boolean }[];
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) expect(row.is_proposal).toBe(row.path === OTEL);
    });
  });

  test("5: --text matches title plus summary only, every token", async () => {
    await withScratch(demo, async (dir) => {
      const bodyOnly = "_memory/decisions/body-only-aaaaaaaa4.md";
      writeFileSync(join(dir, bodyOnly), rec("aaaaaaaaa4").replace("Body.", "postgres postgres"));
      const one = await ltm(dir, "query", "--text", "postgres");
      expect(paths(one.stdout)).toContain(PG);
      expect(paths(one.stdout)).not.toContain(bodyOnly);
      const both = await ltm(dir, "query", "--text", "postgres mysql");
      const listed = paths(both.stdout);
      expect(listed.length).toBeGreaterThan(0);
      for (const p of listed) {
        const fm = parse(readFileSync(join(dir, p), "utf8").split("---\n")[1]!) as Record<string, unknown>;
        const hay = `${fm.title ?? ""} ${fm.summary ?? ""}`.toLowerCase();
        expect(hay).toContain("postgres");
        expect(hay).toContain("mysql");
      }
    });
  });

  test("6: --text ranks the Record with more occurrences first", async () => {
    await withScratch(demo, async (dir) => {
      // Path order puts the one-occurrence Record first, so ranking has to reorder it.
      const once = "_memory/decisions/a-redis-once-aaaaaa5.md";
      const thrice = "_memory/decisions/b-redis-thrice-aaaa6.md";
      writeFileSync(join(dir, once), rec("aaaaaaaaa5", [], "redis"));
      writeFileSync(join(dir, thrice), rec("aaaaaaaaa6", [], "redis redis redis"));
      const r = await ltm(dir, "query", "--text", "redis");
      const listed = paths(r.stdout);
      expect(listed.indexOf(thrice)).toBeGreaterThanOrEqual(0);
      expect(listed.indexOf(thrice)).toBeLessThan(listed.indexOf(once));
    });
  });

  test("7: a recall: key in memory-bank.yaml changes nothing", async () => {
    await withScratch(demo, async (dir) => {
      const before = await ltm(dir, "query", "--text", "postgres");
      const cfg = join(dir, "memory-bank.yaml");
      writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\nrecall: { backend: qmd }\n`);
      expect(readFileSync(cfg, "utf8")).toContain("recall: { backend: qmd }");
      const after = await ltm(dir, "query", "--text", "postgres");
      expect(after).toEqual(before);
      expect(before.stdout).not.toBe("");
    });
  });

  test("9: an unknown --type or a colonless --facet exits 2", async () => {
    await withScratch(demo, async (dir) => {
      const t = await ltm(dir, "query", "--type", "Bogus");
      expect(t.exitCode).toBe(2);
      expect(t.stdout).toBe("");
      const f = await ltm(dir, "query", "--facet", "nocolon");
      expect(f.exitCode).toBe(2);
      expect(f.stdout).toBe("");
    });
  });

  test("11: unserializable frontmatter is skipped, not a crash (#37)", async () => {
    await withScratch(demo, async (dir) => {
      const mq = join(dir, MQ);
      writeFileSync(mq, readFileSync(mq, "utf8").replace(/\n---\n/, "\nextra: &x { self: *x }\n---\n"));
      expect(readFileSync(mq, "utf8")).toContain("extra: &x");
      const pg = join(dir, PG);
      writeFileSync(pg, readFileSync(pg, "utf8").replace(/\n---\n/, "\na: &y 1\nb: *y\n---\n"));
      expect(readFileSync(pg, "utf8")).toContain("b: *y");
      // --all: 16 Records minus the skipped one, with the two retired ones counted.
      const r = await ltm(dir, "query", "--json", "--all");
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain(`ltm query: skipped ${MQ}:`);
      const rows = JSON.parse(r.stdout) as { path: string }[];
      expect(rows).toHaveLength(15);
      expect(rows.map((x) => x.path)).toContain(PG);
    });
  });

  describe("12: a symlinked memory-bank.yaml is refused (#36)", () => {
    const refusal = (dir: string) =>
      `ltm query: ${join(dir, "memory-bank.yaml")}: memory-bank.yaml is a symlink, not followed\n`;
    const replaceWithLink = (dir: string, target: string) => {
      rmSync(join(dir, "memory-bank.yaml"));
      symlinkSync(target, join(dir, "memory-bank.yaml"));
    };

    test("outside file", async () => {
      const outside = mkdtempSync(join(tmpdir(), "ltm-cfg-"));
      try {
        await withScratch(demo, async (dir) => {
          const target = join(outside, "cfg.yaml");
          writeFileSync(target, readFileSync(join(dir, "memory-bank.yaml")));
          replaceWithLink(dir, target);
          const r = await ltm(dir, "query");
          expect(r.exitCode).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toBe(refusal(dir));
        });
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test("file inside the Bank", async () => {
      await withScratch(demo, async (dir) => {
        writeFileSync(join(dir, "real.yaml"), readFileSync(join(dir, "memory-bank.yaml")));
        replaceWithLink(dir, join(dir, "real.yaml"));
        const r = await ltm(dir, "query");
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toBe(refusal(dir));
      });
    });

    test("dangling", async () => {
      await withScratch(demo, async (dir) => {
        replaceWithLink(dir, join(dir, "nowhere.yaml"));
        const r = await ltm(dir, "query");
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toBe(refusal(dir));
      });
    });

    test("a regular file with the same bytes as the old target reads normally", async () => {
      await withScratch(demo, async (dir) => {
        const cfg = join(dir, "memory-bank.yaml");
        const bytes = readFileSync(cfg);
        writeFileSync(join(dir, "real.yaml"), bytes);
        replaceWithLink(dir, join(dir, "real.yaml"));
        expect((await ltm(dir, "query")).exitCode).toBe(1);

        rmSync(cfg);
        writeFileSync(cfg, readFileSync(join(dir, "real.yaml")));
        expect(lstatSync(cfg).isFile()).toBe(true);
        expect(lstatSync(cfg).isSymbolicLink()).toBe(false);
        expect(readFileSync(cfg).equals(bytes)).toBe(true);

        const r = await ltm(dir, "query", "--json", "--all");
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toHaveLength(16);
      });
    });
  });
});
