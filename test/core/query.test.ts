import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BankConfig } from "../../src/core/bank.ts";
import { listRecordFiles, listRecords, matches, parseFilter } from "../../src/core/query.ts";
import type { ParsedRecord } from "../../src/core/record.ts";
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

const defaultFolders = {
  Decision: "_memory/decisions",
  PolicyRule: "_memory/policy-rules",
  Exception: "_memory/exceptions",
  Context: "_memory/context",
};

const record: ParsedRecord = {
  path: "_memory/decisions/x.md",
  memoryType: "Decision",
  frontmatter: {
    schema: 1,
    memory_type: "Context",
    status: "accepted",
    draft: false,
    tags: ["messaging", "events"],
    supersedes: null,
    nested: { a: 1 },
    objs: [{ a: 1 }],
    k: "a=b",
  },
};

describe("parseFilter", () => {
  test("splits at the first '='", () => {
    expect(parseFilter("status=accepted")).toEqual({ key: "status", value: "accepted" });
    expect(parseFilter("k=a=b")).toEqual({ key: "k", value: "a=b" });
    expect(parseFilter("k=")).toEqual({ key: "k", value: "" });
  });

  test("null without '=' or with an empty key", () => {
    expect(parseFilter("status")).toBeNull();
    expect(parseFilter("=x")).toBeNull();
  });
});

describe("matches", () => {
  const f = (key: string, value: string) => [{ key, value }];

  test("scalar string", () => {
    expect(matches(record, f("status", "accepted"))).toBe(true);
    expect(matches(record, f("status", "proposed"))).toBe(false);
  });

  test("number", () => {
    expect(matches(record, f("schema", "1"))).toBe(true);
    expect(matches(record, f("schema", "2"))).toBe(false);
  });

  test("boolean", () => {
    expect(matches(record, f("draft", "false"))).toBe(true);
    expect(matches(record, f("draft", "true"))).toBe(false);
  });

  test("array membership", () => {
    expect(matches(record, f("tags", "events"))).toBe(true);
    expect(matches(record, f("tags", "database"))).toBe(false);
  });

  test("missing key, null, object, and array of objects never match", () => {
    expect(matches(record, f("title", ""))).toBe(false);
    expect(matches(record, f("supersedes", "null"))).toBe(false);
    expect(matches(record, f("supersedes", ""))).toBe(false);
    expect(matches(record, f("nested", "[object Object]"))).toBe(false);
    expect(matches(record, f("objs", "[object Object]"))).toBe(false);
  });

  test("a value containing '='", () => {
    expect(matches(record, [{ key: "k", value: "a=b" }])).toBe(true);
  });

  test("memory_type uses the folder type, not the frontmatter's", () => {
    expect(matches(record, f("memory_type", "Decision"))).toBe(true);
    expect(matches(record, f("memory_type", "Context"))).toBe(false);
  });

  test("filters are ANDed", () => {
    expect(matches(record, [{ key: "status", value: "accepted" }, { key: "tags", value: "events" }])).toBe(true);
    expect(matches(record, [{ key: "status", value: "accepted" }, { key: "tags", value: "nope" }])).toBe(false);
    expect(matches(record, [])).toBe(true);
  });
});

describe("listRecordFiles", () => {
  test("lists the same 16 paths as listRecords, typed by folder, without parsing", async () => {
    await withScratch(demoBank, async (dir) => {
      const config: BankConfig = { root: dir, folders: defaultFolders, raw: {} };
      // A file whose frontmatter won't parse is still a Record file; only parsing skips it.
      await writeFile(join(dir, "_memory/decisions/broken-aA0aA0aA00.md"), "no frontmatter\n");
      const skipped: string[] = [];
      const files = listRecordFiles(config, (p) => skipped.push(p));
      expect(skipped).toEqual([]);
      expect(files).toHaveLength(17);
      expect(files[3]).toEqual({
        abs: join(dir, "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md"),
        rel: "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md",
        type: "Decision",
      });
      expect(files[5]?.rel).toBe("_memory/decisions/broken-aA0aA0aA00.md");
    });
  });
});

describe("listRecords", () => {
  test("demo bank: 16 Records sorted by path, typed by folder", async () => {
    await withScratch(demoBank, async (dir) => {
      const config: BankConfig = { root: dir, folders: defaultFolders, raw: {} };
      const skipped: string[] = [];
      const records = listRecords(config, (p) => skipped.push(p));
      expect(skipped).toEqual([]);
      // Read off the fixture tree by hand.
      expect(records.map((r) => [r.path, r.memoryType])).toEqual([
        ["_memory/context/commerce-domain-glossary-xO4bV1cPi0.md", "Context"],
        ["_memory/context/kubernetes-platform-landscape-uH7rF3kWj6.md", "Context"],
        ["_memory/context/order-service-overview-gN5yD9sMe2.md", "Context"],
        ["_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md", "Decision"],
        ["_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md", "Decision"],
        ["_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md", "Decision"],
        ["_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md", "Decision"],
        ["_memory/decisions/trunk-based-deployment-rX6jK1fWc9.md", "Decision"],
        ["_memory/exceptions/legacy-billing-mysql-until-2026-12-tZ6qL0vKd1.md", "Exception"],
        ["_memory/exceptions/order-service-redis-until-2027-03-wJ3nC7hTy4.md", "Exception"],
        ["_memory/exceptions/search-service-plaintext-logs-bU2pR8aXf7.md", "Exception"],
        ["_memory/policy-rules/no-cross-service-db-reads-cA9wE6uJr3.md", "PolicyRule"],
        ["_memory/policy-rules/relational-stores-use-postgres-nR5hB2yTq8.md", "PolicyRule"],
        ["_memory/policy-rules/services-expose-health-endpoint-eM1xS5gBo8.md", "PolicyRule"],
        ["_memory/policy-rules/shared-sftp-for-partner-files-yF4kP7tNs2.md", "PolicyRule"],
        ["_memory/policy-rules/structured-json-logging-vD8mH3zQb5.md", "PolicyRule"],
      ]);
      const adopt = records[3];
      expect(adopt?.frontmatter.title).toBe("Adopt a message queue for order events");
    });
  });

  test("a Record under nested configured folders takes the deeper folder's type", async () => {
    await withScratch(demoBank, async (dir) => {
      await mkdir(join(dir, "_memory/decisions/ctx"));
      await writeFile(
        join(dir, "_memory/decisions/ctx/nested-zZ0fF0lD02.md"),
        "---\nschema: 1\nid: zZ0fF0lD02\nmemory_type: Decision\ntitle: Nested\n---\n",
      );
      const config: BankConfig = {
        root: dir,
        folders: { ...defaultFolders, Context: "_memory/decisions/ctx" },
        raw: {},
      };
      const records = listRecords(config, () => {});
      const nested = records.filter((r) => r.path === "_memory/decisions/ctx/nested-zZ0fF0lD02.md");
      expect(nested.map((r) => r.memoryType)).toEqual(["Context"]);
      expect(records.length).toBe(14);
    });
  });

  test("an unparseable Record is skipped and reported", async () => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "_memory/decisions/broken.md"), "no frontmatter here\n");
      const skipped: [string, string][] = [];
      const records = listRecords(
        { root: dir, folders: defaultFolders, raw: {} },
        (p, reason) => skipped.push([p, reason]),
      );
      expect(skipped).toEqual([["_memory/decisions/broken.md", "no frontmatter"]]);
      expect(records.length).toBe(16);
    });
  });
});

describe("listRecords folder safety", () => {
  const rec = "---\nschema: 1\nid: x\nmemory_type: Decision\nstatus: accepted\ntitle: T\n---\nbody\n";

  test("a type folder symlinked outside the Bank is skipped and reported, not followed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ltm-outside-"));
    try {
      await writeFile(join(outside, "leak-aaaaaaaaaa.md"), rec);
      await withScratch(demoBank, async (dir) => {
        await rm(join(dir, "_memory/decisions"), { recursive: true });
        await symlink(outside, join(dir, "_memory/decisions"));
        const skipped: [string, string][] = [];
        const records = listRecords({ root: dir, folders: defaultFolders, raw: {} }, (p, r) =>
          skipped.push([p, r]),
        );
        expect(skipped).toEqual([["_memory/decisions", "symlink, not followed"]]);
        expect(records.some((r) => r.memoryType === "Decision")).toBe(false);
        expect(records.length).toBe(11);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a folder named with a backslash that symlinks outside the Bank is skipped, not followed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ltm-outside-"));
    try {
      await writeFile(join(outside, "leak-aaaaaaaaaa.md"), rec);
      await withScratch(demoBank, async (dir) => {
        // loadConfig rejects this value; listRecords must still hold without it.
        await symlink(outside, join(dir, "q\\z"));
        const skipped: [string, string][] = [];
        const records = listRecords(
          { root: dir, folders: { ...defaultFolders, Decision: "q\\z" }, raw: {} },
          (p, r) => skipped.push([p, r]),
        );
        expect(skipped).toEqual([["q\\z", "symlink, not followed"]]);
        expect(records.some((r) => r.memoryType === "Decision")).toBe(false);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a backslash-named entry that isn't a symlink is skipped and reported", async () => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "_memory/decisions/a\\b.md"), rec);
      const skipped: [string, string][] = [];
      const records = listRecords({ root: dir, folders: defaultFolders, raw: {} }, (p, r) =>
        skipped.push([p, r]),
      );
      expect(skipped).toEqual([["_memory/decisions/a\\b.md", "name contains a backslash"]]);
      expect(records.length).toBe(16);
    });
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable type folder is reported and the rest still load", async () => {
    await withScratch(demoBank, async (dir) => {
      const locked = join(dir, "_memory/exceptions");
      await chmod(locked, 0o000);
      try {
        const skipped: [string, string][] = [];
        const records = listRecords({ root: dir, folders: defaultFolders, raw: {} }, (p, r) =>
          skipped.push([p, r]),
        );
        expect(skipped).toHaveLength(1);
        expect(skipped[0]![0]).toBe("_memory/exceptions");
        expect(skipped[0]![1]).not.toBe("");
        expect(records.some((r) => r.memoryType === "Decision")).toBe(true);
        expect(records.some((r) => r.memoryType === "Exception")).toBe(false);
      } finally {
        await chmod(locked, 0o755);
      }
    });
  });
});
