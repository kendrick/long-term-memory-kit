import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BankConfig } from "../../src/core/bank.ts";
import {
  countFacets,
  listRecordFiles,
  listRecords,
  matches,
  parseFilter,
  RETIRED_STATUSES,
  selectRecords,
  type QueryOptions,
} from "../../src/core/query.ts";
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

const opts = (o: Partial<QueryOptions>): QueryOptions => ({
  filters: [],
  statuses: [],
  facets: [],
  all: false,
  ...o,
});

const MYSQL = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";

describe("RETIRED_STATUSES", () => {
  test("superseded, deprecated, rejected", () => {
    expect([...RETIRED_STATUSES].sort()).toEqual(["deprecated", "rejected", "superseded"]);
  });
});

describe("selectRecords on the demo bank", () => {
  const load = (dir: string) => listRecords({ root: dir, folders: defaultFolders, raw: {} }, () => {});

  test("retired Records hide unless asked for", async () => {
    await withScratch(demoBank, async (dir) => {
      const records = load(dir);
      const paths = (o: Partial<QueryOptions>) => selectRecords(records, opts(o)).map((r) => r.path);
      expect(paths({ type: "Decision" })).not.toContain(MYSQL);
      expect(paths({ type: "Decision", statuses: ["superseded"] })).toEqual([MYSQL]);
      expect(paths({ type: "Decision", all: true })).toContain(MYSQL);
      expect(paths({ type: "Decision", statuses: ["accepted"] })).not.toContain(MYSQL);
      expect(paths({ type: "Decision", filters: [{ key: "status", value: "superseded" }] })).toEqual([MYSQL]);
    });
  });

  test("--type alone gives the four non-retired Decisions, in path order", async () => {
    await withScratch(demoBank, async (dir) => {
      expect(selectRecords(load(dir), opts({ type: "Decision" })).map((r) => r.path)).toEqual([
        "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md",
        "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md",
        "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md",
        "_memory/decisions/trunk-based-deployment-rX6jK1fWc9.md",
      ]);
    });
  });
});

describe("selectRecords with literal Records", () => {
  const r = (path: string, frontmatter: Record<string, unknown>, memoryType: ParsedRecord["memoryType"] = "Decision"): ParsedRecord => ({
    path,
    memoryType,
    frontmatter,
  });
  const none = r("none.md", { status: "accepted" });
  const empty = r("empty.md", { status: "accepted", applies_to: [] });
  const commerce = r("commerce.md", { status: "accepted", applies_to: ["domain:commerce"] });
  const payments = r("payments.md", { status: "accepted", applies_to: ["service:payments"] });
  const str = r("string.md", { status: "accepted", applies_to: "service:order-service" });
  const scoped = [none, empty, commerce, payments, str];

  test("facets keep org-wide Records and any Record listing a given Facet", () => {
    const got = selectRecords(scoped, opts({ facets: ["service:order-service", "domain:commerce"] }));
    expect(got.map((x) => x.path)).toEqual(["none.md", "empty.md", "commerce.md", "string.md"]);
  });

  test("null applies_to is org-wide; any other non-list shape matches no Facet", () => {
    const nul = r("null.md", { applies_to: null });
    const obj = r("obj.md", { applies_to: { a: 1 } });
    const num = r("num.md", { applies_to: 3 });
    const got = selectRecords([nul, obj, num], opts({ facets: ["domain:commerce"] }));
    expect(got.map((x) => x.path)).toEqual(["null.md"]);
  });

  test("applies_to=<facet> stays list containment, without the org-wide union", () => {
    const f = [{ key: "applies_to", value: "domain:commerce" }];
    expect(matches(none, f)).toBe(false);
    expect(selectRecords(scoped, opts({ filters: f })).map((x) => x.path)).toEqual(["commerce.md"]);
  });

  test("statuses match any given value, only on a string status", () => {
    const a = r("a.md", { status: "accepted" });
    const p = r("p.md", { status: "proposed" });
    const n = r("n.md", { status: 1 });
    const m = r("m.md", {});
    expect(selectRecords([a, p, n, m], opts({ statuses: ["accepted", "proposed"] })).map((x) => x.path)).toEqual([
      "a.md",
      "p.md",
    ]);
  });

  test("a missing or non-string status is not retired", () => {
    const m = r("m.md", {});
    const n = r("n.md", { status: ["superseded"] });
    const s = r("s.md", { status: "rejected" });
    expect(selectRecords([m, n, s], opts({})).map((x) => x.path)).toEqual(["m.md", "n.md"]);
  });

  test("type uses the folder type", () => {
    const d = r("d.md", { memory_type: "Context" }, "Decision");
    const c = r("c.md", { memory_type: "Decision" }, "Context");
    expect(selectRecords([d, c], opts({ type: "Decision" })).map((x) => x.path)).toEqual(["d.md"]);
  });

  test("text filters on title plus summary and orders by score", () => {
    const one = r("a.md", { title: "redis", status: "accepted" });
    const three = r("b.md", { title: "redis redis", summary: "redis", status: "accepted" });
    const no = r("c.md", { title: "kafka", status: "accepted" });
    const retired = r("d.md", { title: "redis redis redis redis", status: "superseded" });
    expect(selectRecords([one, three, no, retired], opts({ text: "redis" })).map((x) => x.path)).toEqual([
      "b.md",
      "a.md",
    ]);
  });

  test("text with no tokens adds no filter and keeps input order", () => {
    const z = r("z.md", { title: "z" });
    const a = r("a.md", {});
    expect(selectRecords([z, a], opts({ text: "--" })).map((x) => x.path)).toEqual(["z.md", "a.md"]);
  });
});

describe("countFacets", () => {
  test("demo bank: counts non-retired Records, or all of them with all=true", async () => {
    await withScratch(demoBank, async (dir) => {
      const records = listRecords({ root: dir, folders: defaultFolders, raw: {} }, () => {});
      const live = new Map(countFacets(records, false).map((f) => [f.facet, f.count]));
      expect(live.get("service:order-service")).toBe(3);
      expect(live.get("domain:commerce")).toBe(8);
      const all = new Map(countFacets(records, true).map((f) => [f.facet, f.count]));
      expect(all.get("service:order-service")).toBe(3);
      expect(all.get("domain:commerce")).toBe(10);
    });
  });

  test("a Record counts once per distinct Facet; strings count, other entries don't; sorted", () => {
    const records: ParsedRecord[] = [
      { path: "a.md", memoryType: "Decision", frontmatter: { applies_to: ["domain:commerce", "domain:commerce", 7, null] } },
      { path: "b.md", memoryType: "Decision", frontmatter: { applies_to: "service:a" } },
      { path: "c.md", memoryType: "Decision", frontmatter: { applies_to: { x: 1 } } },
      { path: "d.md", memoryType: "Decision", frontmatter: {} },
    ];
    expect(countFacets(records, false)).toEqual([
      { facet: "domain:commerce", count: 1 },
      { facet: "service:a", count: 1 },
    ]);
  });
});

describe("listRecordFiles symlinks beside Records", () => {
  const folders = defaultFolders;
  const DECISIONS = "_memory/decisions";
  const link = async (
    make: (dir: string) => Promise<void>,
    check: (r: { skipped: [string, string][]; files: string[]; baseline: string[] }) => void,
  ) => {
    await withScratch(demoBank, async (dir) => {
      const baseline = listRecordFiles({ root: dir, folders, raw: {} }, () => {}).map((f) => f.rel);
      await make(dir);
      const skipped: [string, string][] = [];
      const files = listRecordFiles({ root: dir, folders, raw: {} }, (p, r) => skipped.push([p, r])).map(
        (f) => f.rel,
      );
      check({ skipped, files, baseline });
    });
  };

  test("a non-.md link to a file is ignored silently", async () => {
    await link(
      (dir) => symlink("/etc/hosts", join(dir, DECISIONS, "diagram.png")),
      ({ skipped, files, baseline }) => {
        expect(skipped).toEqual([]);
        expect(files).toEqual(baseline);
      },
    );
  });

  test("a .md link is reported", async () => {
    await link(
      (dir) => symlink("/etc/hosts", join(dir, DECISIONS, "x.md")),
      ({ skipped }) => expect(skipped).toEqual([[`${DECISIONS}/x.md`, "symlink, not followed"]]),
    );
  });

  test("a link to a directory is reported", async () => {
    await link(
      (dir) => symlink(dir, join(dir, DECISIONS, "assets")),
      ({ skipped }) => expect(skipped).toEqual([[`${DECISIONS}/assets`, "symlink, not followed"]]),
    );
  });

  test("a non-.md name linking to a directory is reported", async () => {
    await link(
      (dir) => symlink(dir, join(dir, DECISIONS, "diagram.png")),
      ({ skipped }) => expect(skipped).toEqual([[`${DECISIONS}/diagram.png`, "symlink, not followed"]]),
    );
  });

  test("a dangling non-.md link is ignored silently", async () => {
    await link(
      (dir) => symlink(join(dir, "nowhere"), join(dir, DECISIONS, "gone.png")),
      ({ skipped, files, baseline }) => {
        expect(skipped).toEqual([]);
        expect(files).toEqual(baseline);
      },
    );
  });

  test("a backslash-named non-.md link to a file is reported without a stat", async () => {
    await link(
      (dir) => symlink("/etc/hosts", join(dir, DECISIONS, "a\\b.png")),
      ({ skipped }) => expect(skipped).toEqual([[`${DECISIONS}/a\\b.png`, "symlink, not followed"]]),
    );
  });

  // The link's target sits in a directory stat can't traverse, so EACCES says nothing about
  // whether it is a directory and the link must be reported.
  test.skipIf(process.getuid?.() === 0)("a non-.md link whose stat fails with EACCES is reported", async () => {
    await withScratch(demoBank, async (dir) => {
      const locked = join(dir, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "t"), "x");
      await symlink(join(locked, "t"), join(dir, DECISIONS, "diagram.png"));
      await chmod(locked, 0o000);
      try {
        const skipped: [string, string][] = [];
        listRecordFiles({ root: dir, folders, raw: {} }, (p, r) => skipped.push([p, r]));
        expect(skipped).toEqual([[`${DECISIONS}/diagram.png`, "symlink, not followed"]]);
      } finally {
        await chmod(locked, 0o755);
      }
    });
  });
});
