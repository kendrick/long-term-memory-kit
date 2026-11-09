import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, MEMORY_TYPES, type BankConfig } from "../../src/core/bank.ts";
import {
  CHECKS,
  daysBetween,
  loadThresholds,
  runDoctor,
  type CheckName,
  type DoctorFinding,
  type Thresholds,
} from "../../src/core/doctor.ts";
import { listRecords } from "../../src/core/query.ts";
import type { ParsedRecord } from "../../src/core/record.ts";
import { tokenize, type RecallBackend } from "../../src/core/recall.ts";
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));
const TODAY = "2026-10-09";
const DEFAULTS: Thresholds = { stale_confirmed_days: 90, proposal_age_days: 30, max_chain_length: 3, orphan_days: 30, near_duplicate_threshold: 0.85, byType: {} };

const F = {
  glossary: "_memory/context/commerce-domain-glossary-xO4bV1cPi0.md",
  k8s: "_memory/context/kubernetes-platform-landscape-uH7rF3kWj6.md",
  orderOverview: "_memory/context/order-service-overview-gN5yD9sMe2.md",
  otel: "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md",
  mysql: "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md",
  postgres: "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md",
  billing: "_memory/exceptions/legacy-billing-mysql-until-2026-12-tZ6qL0vKd1.md",
  sftp: "_memory/policy-rules/shared-sftp-for-partner-files-yF4kP7tNs2.md",
};

// Sets (or, with null, removes) top-level frontmatter keys by line, so the rest of the file stays as the fixture wrote it.
async function edit(dir: string, rel: string, fields: Record<string, string | null>): Promise<void> {
  const path = join(dir, rel);
  const lines = (await readFile(path, "utf8")).split("\n");
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close < 0) throw new Error(`${rel}: no frontmatter`);
  const head = lines.slice(1, close);
  for (const [key, value] of Object.entries(fields)) {
    const i = head.findIndex((l) => l.startsWith(`${key}:`));
    if (value === null) {
      if (i >= 0) head.splice(i, 1);
    } else if (i >= 0) head[i] = `${key}: ${value}`;
    else head.push(`${key}: ${value}`);
  }
  await writeFile(path, ["---", ...head, ...lines.slice(close)].join("\n"));
}

async function writeRecord(dir: string, rel: string, fields: Record<string, string>): Promise<void> {
  const head = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  await writeFile(join(dir, rel), ["---", ...head, "---", "", "Body.", ""].join("\n"));
}

function doctor(dir: string, thresholds: Thresholds = DEFAULTS): DoctorFinding[] {
  return runDoctor(listRecords(loadConfig(dir), () => {}), TODAY, thresholds);
}

const pick = (fs: DoctorFinding[], file: string, check: CheckName) =>
  fs.filter((f) => f.file === file && f.check === check);

const scratch = <T>(fn: (dir: string) => Promise<T>) => withScratch(demoBank, fn);

const config = (raw: Record<string, unknown>): BankConfig => ({
  root: "/nowhere",
  folders: {
    Decision: "_memory/decisions",
    PolicyRule: "_memory/policy-rules",
    Exception: "_memory/exceptions",
    Context: "_memory/context",
  },
  raw,
});

describe("daysBetween", () => {
  test("counts calendar days, leap days included", () => {
    expect(daysBetween("2026-07-10", "2026-10-09")).toBe(91);
    expect(daysBetween("2026-07-11", "2026-10-09")).toBe(90);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-10-09", "2026-10-09")).toBe(0);
    expect(daysBetween("2026-10-09", "2026-10-08")).toBe(-1);
  });

  test("reads years 0-99 as written, not as 1900-1999", () => {
    expect(daysBetween("0099-12-31", "0100-01-01")).toBe(1);
    // Year 0 is a leap year and 1900 isn't, so this one tells the two readings apart.
    expect(daysBetween("0000-02-28", "0000-03-01")).toBe(2);
  });

  test("refuses a string that isn't a calendar date", () => {
    expect(() => daysBetween("2026-02-30", "2026-10-09")).toThrow("'2026-02-30' is not a YYYY-MM-DD date");
  });
});

describe("loadThresholds", () => {
  test("defaults come from the config schema", () => {
    expect(loadThresholds(config({}))).toEqual(DEFAULTS);
  });

  test("a doctor mapping overrides per key and keeps the rest", () => {
    expect(loadThresholds(config({ doctor: { orphan_days: 45 } }))).toEqual({ ...DEFAULTS, orphan_days: 45 });
  });

  test("each bad shape returns its error", () => {
    expect(loadThresholds(config({ doctor: { stale_confirmed_days: 0 } }))).toEqual({
      error: "doctor.stale_confirmed_days must be an integer of 1 or more",
    });
    expect(loadThresholds(config({ doctor: { proposal_age_days: 1.5 } }))).toEqual({
      error: "doctor.proposal_age_days must be an integer of 1 or more",
    });
    expect(loadThresholds(config({ doctor: { max_chain_length: "3" } }))).toEqual({
      error: "doctor.max_chain_length must be an integer of 1 or more",
    });
    expect(loadThresholds(config({ doctor: { nope: 1 } }))).toEqual({ error: "doctor.nope: unknown key" });
    expect(loadThresholds(config({ doctor: 5 }))).toEqual({ error: "doctor is not a mapping" });
    expect(loadThresholds(config({ doctor: null }))).toEqual({ error: "doctor is not a mapping" });
  });

  test("near_duplicate_threshold takes a number strictly between 0 and 1", () => {
    expect(loadThresholds(config({}))).toMatchObject({ near_duplicate_threshold: 0.85 });
    expect(loadThresholds(config({ doctor: { near_duplicate_threshold: 0.5 } }))).toEqual({
      ...DEFAULTS,
      near_duplicate_threshold: 0.5,
    });
    for (const bad of [0, 1, 1.5, "0.8"]) {
      expect(loadThresholds(config({ doctor: { near_duplicate_threshold: bad } }))).toEqual({
        error: "doctor.near_duplicate_threshold must be a number between 0 and 1, exclusive",
      });
    }
  });

  test("reads the doctor mapping out of memory-bank.yaml", async () => {
    await scratch(async (dir) => {
      const path = join(dir, "memory-bank.yaml");
      await writeFile(path, `${await readFile(path, "utf8")}doctor:\n  stale_confirmed_days: 0\n`);
      expect(loadThresholds(loadConfig(dir))).toEqual({
        error: "doctor.stale_confirmed_days must be an integer of 1 or more",
      });
    });
  });
});

describe("CHECKS", () => {
  test("lists the eight checks in report order", () => {
    expect(CHECKS.map((c) => c.name)).toEqual([
      "stale-confirmed",
      "review-due",
      "stale-proposal",
      "long-chain",
      "orphan",
      "broken-related",
      "supersession-no-shared-facet",
      "near-duplicate",
    ]);
  });
});

describe("stale-confirmed", () => {
  test("last_confirmed 91 days back fires and 90 doesn't", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.orderOverview, { last_confirmed: "2026-07-10" });
      expect(pick(doctor(dir), F.orderOverview, "stale-confirmed")).toEqual([
        {
          file: F.orderOverview,
          check: "stale-confirmed",
          message: "last_confirmed 2026-07-10 is 91 days old (threshold 90)",
          related_files: [],
        },
      ]);
      await edit(dir, F.orderOverview, { last_confirmed: "2026-07-11" });
      expect(pick(doctor(dir), F.orderOverview, "stale-confirmed")).toEqual([]);
    });
  });

  test("a recent last_confirmed wins over an old date", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.orderOverview, { date: "2020-01-01", last_confirmed: "2026-10-01" });
      expect(pick(doctor(dir), F.orderOverview, "stale-confirmed")).toEqual([]);
    });
  });

  test("without last_confirmed, date is the reference", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.k8s, { date: "2026-07-10" });
      expect(pick(doctor(dir), F.k8s, "stale-confirmed").map((f) => f.message)).toEqual([
        "date 2026-07-10 is 91 days old and there's no last_confirmed (threshold 90)",
      ]);
      await edit(dir, F.k8s, { date: "2026-07-11" });
      expect(pick(doctor(dir), F.k8s, "stale-confirmed")).toEqual([]);
    });
  });

  test("stale_confirmed_days: 100 stops the 91-day case", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.orderOverview, { last_confirmed: "2026-07-10" });
      expect(pick(doctor(dir), F.orderOverview, "stale-confirmed")).toHaveLength(1);
      expect(pick(doctor(dir, { ...DEFAULTS, stale_confirmed_days: 100 }), F.orderOverview, "stale-confirmed")).toEqual(
        [],
      );
    });
  });

  test("a Proposal is left to stale-proposal", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.otel, { date: "2020-01-01" });
      const fs = doctor(dir);
      expect(pick(fs, F.otel, "stale-confirmed")).toEqual([]);
      expect(pick(fs, F.otel, "stale-proposal")).toHaveLength(1);
    });
  });
});

describe("review-due", () => {
  test("review_by yesterday fires and today doesn't", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.orderOverview, { review_by: "2026-10-08" });
      expect(pick(doctor(dir), F.orderOverview, "review-due")).toEqual([
        { file: F.orderOverview, check: "review-due", message: "review_by 2026-10-08 has passed", related_files: [] },
      ]);
      await edit(dir, F.orderOverview, { review_by: "2026-10-09" });
      expect(pick(doctor(dir), F.orderOverview, "review-due")).toEqual([]);
    });
  });
});

describe("stale-proposal", () => {
  test("a Proposal 31 days old fires and 30 doesn't", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.otel, { date: "2026-09-08" });
      expect(pick(doctor(dir), F.otel, "stale-proposal")).toEqual([
        {
          file: F.otel,
          check: "stale-proposal",
          message: "proposed on 2026-09-08, 31 days ago (threshold 30)",
          related_files: [],
        },
      ]);
      await edit(dir, F.otel, { date: "2026-09-09" });
      expect(pick(doctor(dir), F.otel, "stale-proposal")).toEqual([]);
    });
  });
});

describe("long-chain", () => {
  const A = "_memory/decisions/chain-a-AAAAAAAAAA.md";
  const B = "_memory/decisions/chain-b-BBBBBBBBBB.md";
  const C = "_memory/decisions/chain-c-CCCCCCCCCC.md";
  const D = "_memory/decisions/chain-d-DDDDDDDDDD.md";
  const base = (id: string, status: string) => ({
    schema: "1",
    id,
    memory_type: "Decision",
    title: `Chain ${id}`,
    status,
    date: "2026-10-01",
    summary: "One link in a Supersession chain.",
    applies_to: "[domain:commerce]",
    owners: "[team:commerce-architecture]",
  });
  const writeABC = async (dir: string) => {
    await writeRecord(dir, A, { ...base("AAAAAAAAAA", "superseded"), superseded_by: "BBBBBBBBBB" });
    await writeRecord(dir, B, {
      ...base("BBBBBBBBBB", "superseded"),
      supersedes: "[AAAAAAAAAA]",
      superseded_by: "CCCCCCCCCC",
    });
    await writeRecord(dir, C, { ...base("CCCCCCCCCC", "accepted"), supersedes: "[BBBBBBBBBB]" });
  };
  const chains = (dir: string) => doctor(dir).filter((f) => f.check === "long-chain");

  test("three Records don't fire; a fourth fires once, on the head", async () => {
    await scratch(async (dir) => {
      await writeABC(dir);
      expect(chains(dir)).toEqual([]);

      await edit(dir, C, { status: "superseded", superseded_by: "DDDDDDDDDD" });
      await writeRecord(dir, D, { ...base("DDDDDDDDDD", "accepted"), supersedes: "[CCCCCCCCCC]" });
      const four = chains(dir);
      expect(four).toEqual([
        {
          file: D,
          check: "long-chain",
          message: "Supersession chain holds 4 Records (threshold 3)",
          related_files: [A, B, C],
        },
      ]);

      // `related` isn't a Supersession link, so it can't lengthen or split the chain.
      await edit(dir, A, { related: "[relates_to::xO4bV1cPi0]" });
      expect(chains(dir)).toEqual(four);
    });
  });

  test("a link written on only one side still counts", async () => {
    await scratch(async (dir) => {
      await writeABC(dir);
      await edit(dir, C, { status: "superseded", superseded_by: "DDDDDDDDDD" });
      await writeRecord(dir, D, base("DDDDDDDDDD", "accepted"));
      expect(chains(dir).map((f) => [f.file, f.related_files])).toEqual([[D, [A, B, C]]]);
    });
  });

  test("a Record superseding several independent Records is not a long chain", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, A, { ...base("AAAAAAAAAA", "superseded"), superseded_by: "DDDDDDDDDD" });
      await writeRecord(dir, B, { ...base("BBBBBBBBBB", "superseded"), superseded_by: "DDDDDDDDDD" });
      await writeRecord(dir, C, { ...base("CCCCCCCCCC", "superseded"), superseded_by: "DDDDDDDDDD" });
      await writeRecord(dir, D, {
        ...base("DDDDDDDDDD", "accepted"),
        supersedes: "[AAAAAAAAAA, BBBBBBBBBB, CCCCCCCCCC]",
      });
      expect(chains(dir)).toEqual([]);
    });
  });

  test("with two branches, the longest one sets the count and related_files", async () => {
    await scratch(async (dir) => {
      const E = "_memory/decisions/chain-e-EEEEEEEEEE.md";
      const G = "_memory/decisions/chain-g-GGGGGGGGGG.md";
      await writeRecord(dir, B, { ...base("BBBBBBBBBB", "superseded"), superseded_by: "CCCCCCCCCC" });
      await writeRecord(dir, C, {
        ...base("CCCCCCCCCC", "superseded"),
        supersedes: "[BBBBBBBBBB]",
        superseded_by: "DDDDDDDDDD",
      });
      await writeRecord(dir, E, { ...base("EEEEEEEEEE", "superseded"), superseded_by: "GGGGGGGGGG" });
      await writeRecord(dir, D, {
        ...base("DDDDDDDDDD", "superseded"),
        supersedes: "[CCCCCCCCCC]",
        superseded_by: "GGGGGGGGGG",
      });
      await writeRecord(dir, G, { ...base("GGGGGGGGGG", "accepted"), supersedes: "[DDDDDDDDDD, EEEEEEEEEE]" });
      expect(chains(dir)).toEqual([
        {
          file: G,
          check: "long-chain",
          message: "Supersession chain holds 4 Records (threshold 3)",
          related_files: [B, C, D],
        },
      ]);
    });
  });

  // Each layer's two Records both supersede both Records in the layer below, so a walk that enumerates every
  // path visits 2^30 of them. The memoized walk visits each Record once.
  test("Records that fork and merge for 30 layers report in linear time", async () => {
    await scratch(async (dir) => {
      const L = 30;
      const id = (layer: number, side: string) => `Layer${String(layer).padStart(2, "0")}${side}xxx`;
      const file = (layer: number, side: string) => `_memory/decisions/${id(layer, side).toLowerCase()}-${id(layer, side)}.md`;
      for (let i = 0; i < L; i++) {
        for (const side of ["a", "b"]) {
          const fields: Record<string, string> = { ...base(id(i, side), i === L - 1 ? "accepted" : "superseded") };
          if (i > 0) fields.supersedes = `[${id(i - 1, "a")}, ${id(i - 1, "b")}]`;
          await writeRecord(dir, file(i, side), fields);
        }
      }
      const started = performance.now();
      const found = chains(dir);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(found.map((f) => [f.file, f.message])).toEqual([
        [file(L - 1, "a"), `Supersession chain holds ${L} Records (threshold 3)`],
        [file(L - 1, "b"), `Supersession chain holds ${L} Records (threshold 3)`],
      ]);
    });
  });

  test("a cycle has no head and isn't reported", async () => {
    await scratch(async (dir) => {
      await writeABC(dir);
      await edit(dir, A, { supersedes: "[CCCCCCCCCC]" });
      await writeRecord(dir, D, { ...base("DDDDDDDDDD", "accepted"), supersedes: "[AAAAAAAAAA]" });
      // D -> A -> B -> C -> A: D is a head reaching all four, and the walk terminates.
      expect(chains(dir).map((f) => [f.file, f.related_files])).toEqual([[D, [A, B, C]]]);
      await writeRecord(dir, D, base("DDDDDDDDDD", "accepted"));
      expect(chains(dir)).toEqual([]);
    });
  });
});

describe("orphan", () => {
  test("a live Record 31 days old with no links fires, and 30 days doesn't", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.k8s, { date: "2026-09-08" });
      expect(pick(doctor(dir), F.k8s, "orphan")).toEqual([
        {
          file: F.k8s,
          check: "orphan",
          message:
            "no related, supersedes, or superseded_by, and no Record relates to it (date 2026-09-08, 31 days old, threshold 30)",
          related_files: [],
        },
      ]);
      await edit(dir, F.k8s, { date: "2026-09-09" });
      expect(pick(doctor(dir), F.k8s, "orphan")).toEqual([]);
    });
  });

  test("an inbound related entry clears it while the orphan's own fields stay empty", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.k8s, { date: "2026-09-08" });
      expect(pick(doctor(dir), F.k8s, "orphan")).toHaveLength(1);
      await edit(dir, F.glossary, { related: "[relates_to::uH7rF3kWj6]" });
      expect(pick(doctor(dir), F.k8s, "orphan")).toEqual([]);
      const own = await readFile(join(dir, F.k8s), "utf8");
      expect(own).not.toMatch(/^(related|supersedes|superseded_by):/m);
    });
  });

  test("a retired Record's related entry still counts as an inbound link", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.k8s, { date: "2026-09-08" });
      await edit(dir, F.sftp, { related: "[relates_to::uH7rF3kWj6]" });
      expect(pick(doctor(dir), F.k8s, "orphan")).toEqual([]);
    });
  });
});

describe("by_type", () => {
  const rec = (path: string, memoryType: ParsedRecord["memoryType"], fm: Record<string, unknown>): ParsedRecord => ({
    path,
    memoryType,
    frontmatter: { status: "accepted", ...fm },
  });
  const ctx60 = rec("_memory/context/ctx60.md", "Context", { id: "ctx60", date: "2026-08-10" });
  const dec60 = rec("_memory/decisions/dec60.md", "Decision", { id: "dec60", date: "2026-08-10" });
  const files = (fs: DoctorFinding[], check: CheckName) => fs.filter((f) => f.check === check).map((f) => f.file);
  const orphans = (records: ParsedRecord[], t: Thresholds) => files(runDoctor(records, TODAY, t), "orphan");

  test("a 60-day-old unlinked Context isn't orphan with Context orphan_days 365; a Decision is", () => {
    expect(orphans([ctx60, dec60], { ...DEFAULTS, byType: { Context: { orphan_days: 365 } } })).toEqual([dec60.path]);
  });

  test("with no by_type both are orphan", () => {
    expect(orphans([ctx60, dec60], DEFAULTS)).toEqual([ctx60.path, dec60.path]);
  });

  test("by_type applies to stale-confirmed too", () => {
    const fm = { date: "2026-06-11", last_confirmed: "2026-06-11", related: "[relates_to::x]" };
    const c = rec("_memory/context/c.md", "Context", { id: "c", ...fm });
    const d = rec("_memory/decisions/d.md", "Decision", { id: "d", ...fm });
    const t = { ...DEFAULTS, byType: { Context: { stale_confirmed_days: 365 } } };
    expect(files(runDoctor([c, d], TODAY, t), "stale-confirmed")).toEqual([d.path]);
  });

  test("the report line names the threshold applied", () => {
    const old = rec("_memory/context/old.md", "Context", { id: "old", date: "2025-09-04" });
    const t = { ...DEFAULTS, byType: { Context: { orphan_days: 365 } } };
    expect(runDoctor([old], TODAY, t).filter((f) => f.check === "orphan").map((f) => f.message)).toEqual([
      "no related, supersedes, or superseded_by, and no Record relates to it (date 2025-09-04, 400 days old, threshold 365)",
    ]);
  });

  test("the folder's type alone picks the threshold", () => {
    const t = { ...DEFAULTS, byType: { Context: { orphan_days: 365 } } };
    // The folder sets memoryType, so a Decision-folder Record whose frontmatter says Context doesn't get the Context override.
    const moved = { ...ctx60, path: "_memory/decisions/ctx60.md", memoryType: "Decision" as const };
    expect(orphans([{ ...moved, frontmatter: { ...moved.frontmatter, memory_type: "Context" } }], t)).toEqual([moved.path]);
    // applies_to and age must not change which threshold applies; the next test covers status.
    const changed = rec(ctx60.path, "Context", { id: "ctx60", applies_to: ["service:x"], date: "2026-07-01" });
    expect(orphans([changed], t)).toEqual([]);
  });

  test("a different live status keeps the Context threshold", () => {
    const old = rec("_memory/context/prop.md", "Context", { id: "prop", status: "proposed", date: "2025-09-04" });
    const t = { ...DEFAULTS, byType: { Context: { orphan_days: 365 } } };
    const msgs = runDoctor([old], TODAY, t).filter((f) => f.check === "orphan").map((f) => f.message);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEndWith("threshold 365)");
  });

  test("the schema's by_type memory types match MEMORY_TYPES", async () => {
    const schema = (await import("../../schema/memory-bank.schema.json")).default;
    expect(schema.properties.doctor.properties.by_type.propertyNames.enum).toEqual([...MEMORY_TYPES]);
  });

  test("Bank-wide and by_type compose", () => {
    const c = rec("_memory/context/c20.md", "Context", { id: "c20", date: "2026-09-19" });
    const d = rec("_memory/decisions/d20.md", "Decision", { id: "d20", date: "2026-09-19" });
    expect(orphans([c, d], { ...DEFAULTS, orphan_days: 10, byType: { Context: { orphan_days: 365 } } })).toEqual([d.path]);
  });

  test("an empty by_type, or an empty entry, means no override", () => {
    expect(orphans([ctx60, dec60], { ...DEFAULTS, byType: { Context: {} } })).toEqual([ctx60.path, dec60.path]);
  });

  test("loadThresholds reads by_type", () => {
    expect(loadThresholds(config({ doctor: { by_type: { Context: { orphan_days: 365 } } } }))).toEqual({
      ...DEFAULTS,
      byType: { Context: { orphan_days: 365 } },
    });
    expect(loadThresholds(config({ doctor: { orphan_days: 10, by_type: { Context: { stale_confirmed_days: 5 } } } }))).toEqual({
      ...DEFAULTS,
      orphan_days: 10,
      byType: { Context: { stale_confirmed_days: 5 } },
    });
    expect(loadThresholds(config({}))).toMatchObject({ byType: {} });
    expect(loadThresholds(config({ doctor: { by_type: {} } }))).toEqual(DEFAULTS);
    expect(loadThresholds(config({ doctor: { by_type: { Context: {} } } }))).toEqual({ ...DEFAULTS, byType: { Context: {} } });
  });

  test("each bad by_type shape returns its error", () => {
    const bad = (by_type: unknown) => loadThresholds(config({ doctor: { by_type } }));
    expect(bad({ Project: { orphan_days: 1 } })).toEqual({ error: "doctor.by_type.Project: unknown memory type" });
    expect(bad({ Context: { max_chain_length: 9 } })).toEqual({ error: "doctor.by_type.Context.max_chain_length: unknown key" });
    expect(bad({ Context: { orphan_days: 0 } })).toEqual({
      error: "doctor.by_type.Context.orphan_days must be an integer of 1 or more",
    });
    expect(bad({ Context: { stale_confirmed_days: 1.5 } })).toEqual({
      error: "doctor.by_type.Context.stale_confirmed_days must be an integer of 1 or more",
    });
    expect(bad({ Context: 5 })).toEqual({ error: "doctor.by_type.Context is not a mapping" });
    expect(bad([])).toEqual({ error: "doctor.by_type is not a mapping" });
    expect(bad(null)).toEqual({ error: "doctor.by_type is not a mapping" });
  });
});

describe("broken-related", () => {
  test("names the dangling id in the message", async () => {
    await scratch(async (dir) => {
      expect(pick(doctor(dir), F.billing, "broken-related")).toEqual([]);
      await edit(dir, F.billing, { related: "[constrained_by::ZZZZZZZZZZ]" });
      const fs = pick(doctor(dir), F.billing, "broken-related");
      expect(fs).toEqual([
        {
          file: F.billing,
          check: "broken-related",
          message: "related entry 'constrained_by::ZZZZZZZZZZ' names id 'ZZZZZZZZZZ', which no Record has",
          related_files: [],
        },
      ]);
      expect(fs[0]!.message).toContain("ZZZZZZZZZZ");
    });
  });

  test("runs on retired Records too", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.sftp, { related: "[ZZZZZZZZZZ]" });
      expect(pick(doctor(dir), F.sftp, "broken-related").map((f) => f.message)).toEqual([
        "related entry 'ZZZZZZZZZZ' names id 'ZZZZZZZZZZ', which no Record has",
      ]);
    });
  });
});

describe("supersession-no-shared-facet", () => {
  const facet = async (dir: string, old: string, neu: string) => {
    await edit(dir, F.mysql, { applies_to: old });
    await edit(dir, F.postgres, { applies_to: neu });
    return doctor(dir).filter((f) => f.check === "supersession-no-shared-facet");
  };

  test("an empty list against a non-empty one fires on the new Record", async () => {
    await scratch(async (dir) => {
      expect(await facet(dir, "[]", "[service:a]")).toEqual([
        {
          file: F.postgres,
          check: "supersession-no-shared-facet",
          message: `supersedes ${F.mysql}, but the two share no applies_to Facet`,
          related_files: [F.mysql],
        },
      ]);
    });
  });

  test("a shared Facet clears it", async () => {
    await scratch(async (dir) => {
      expect(await facet(dir, "[service:a]", "[service:a]")).toEqual([]);
    });
  });

  test("empty on both sides fires", async () => {
    await scratch(async (dir) => {
      expect((await facet(dir, "[]", "[]")).map((f) => [f.file, f.related_files])).toEqual([[F.postgres, [F.mysql]]]);
    });
  });

  test("disjoint non-empty lists stay validate's and don't fire", async () => {
    await scratch(async (dir) => {
      expect(await facet(dir, "[service:a]", "[service:b]")).toEqual([]);
    });
  });
});

describe("retired Records", () => {
  // No links at all: drop both halves of the mysql/postgres Supersession.
  const lonely = (status: string) => ({
    status,
    review_by: "2026-01-01",
    last_confirmed: "2025-01-01",
    superseded_by: null,
  });

  test("the same edits fire on a live Record", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.mysql, lonely("accepted"));
      await edit(dir, F.postgres, { supersedes: null });
      const fs = doctor(dir);
      expect(pick(fs, F.mysql, "review-due")).toHaveLength(1);
      expect(pick(fs, F.mysql, "stale-confirmed")).toHaveLength(1);
      expect(pick(fs, F.mysql, "orphan")).toHaveLength(1);
    });
  });

  test("a superseded Record produces no review-due, stale-confirmed, or orphan", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.mysql, lonely("superseded"));
      await edit(dir, F.postgres, { supersedes: null });
      const fs = doctor(dir);
      expect(pick(fs, F.mysql, "review-due")).toEqual([]);
      expect(pick(fs, F.mysql, "stale-confirmed")).toEqual([]);
      expect(pick(fs, F.mysql, "orphan")).toEqual([]);
    });
  });

  test("a superseded Record with a past review_by and its link intact produces no review-due", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.mysql, { review_by: "2026-01-01" });
      expect(pick(doctor(dir), F.mysql, "review-due")).toEqual([]);
    });
  });
});

describe("runDoctor ordering", () => {
  test("sorts by file, then CHECKS order, then message, whatever order the Records came in", async () => {
    await scratch(async (dir) => {
      await edit(dir, F.orderOverview, { last_confirmed: "2026-07-10", review_by: "2026-10-08" });
      await edit(dir, F.billing, { related: "[constrained_by::ZZZZZZZZZZ, constrained_by::YYYYYYYYYY]" });
      const records = listRecords(loadConfig(dir), () => {}).reverse();
      const fs = runDoctor(records, TODAY, DEFAULTS);
      const rank = (c: CheckName) => CHECKS.findIndex((x) => x.name === c);
      const expected = [...fs].sort(
        (a, b) =>
          (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
          rank(a.check) - rank(b.check) ||
          (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
      );
      expect(fs).toEqual(expected);
      // The fixture's overview Record is already an orphan, so three checks land on one file.
      expect(fs.filter((f) => f.file === F.orderOverview).map((f) => f.check)).toEqual([
        "stale-confirmed",
        "review-due",
        "orphan",
      ]);
      expect(pick(fs, F.billing, "broken-related").map((f) => f.message)).toEqual([
        "related entry 'constrained_by::YYYYYYYYYY' names id 'YYYYYYYYYY', which no Record has",
        "related entry 'constrained_by::ZZZZZZZZZZ' names id 'ZZZZZZZZZZ', which no Record has",
      ]);
    });
  });
});

const MQ = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";
const PUB = "_memory/decisions/publish-order-events-to-the-queue-aB3cD4eF5g.md";
const PUB_FIELDS: Record<string, string> = {
  schema: "1",
  id: "aB3cD4eF5g",
  memory_type: "Decision",
  title: "Adopt a message queue for order lifecycle events",
  status: "accepted",
  date: "2026-04-22",
  summary: "Order-service publishes order lifecycle events to the shared message queue instead of calling downstream services.",
  applies_to: "[service:order-service, domain:commerce]",
};

// Scores each candidate by the Jaccard index of its title's token set (summary when the title is empty) against the query's.
// MQ's title shares all 7 of its tokens with PUB's 8, so the pair scores 7/8 = 0.875.
const jaccard: RecallBackend = {
  search(records, text) {
    const q = new Set(tokenize(text));
    return records.map((record) => {
      const { summary, title } = record.frontmatter;
      const c = new Set(tokenize(typeof title === "string" && title !== "" ? title : String(summary)));
      const shared = [...q].filter((t) => c.has(t)).length;
      return { record, score: shared / (q.size + c.size - shared) };
    });
  },
};

const nearDup = (fs: DoctorFinding[]) => fs.filter((f) => f.check === "near-duplicate");
const withBackend = (dir: string, t: number = 0.85) =>
  nearDup(
    runDoctor(listRecords(loadConfig(dir), () => {}), TODAY, { ...DEFAULTS, near_duplicate_threshold: t }, jaccard),
  );

// Ids of every Record the near-duplicate pass queries for: accepted and typed.
const acceptedIds = (dir: string) =>
  listRecords(loadConfig(dir), () => {})
    .filter((r) => r.frontmatter.status === "accepted" && typeof r.frontmatter.memory_type === "string")
    .map((r) => String(r.frontmatter.id))
    .sort();

describe("near-duplicate", () => {
  test("reports the one pair, on the path that sorts first", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      expect(withBackend(dir)).toEqual([
        {
          file: MQ,
          check: "near-duplicate",
          message: `scores 0.88 against ${PUB} (threshold 0.85)`,
          related_files: [PUB],
        },
      ]);
    });
  });

  test("a dissimilar title and summary report nothing", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, { ...PUB_FIELDS, summary: "Order-service writes audit rows.", title: "Audit rows" });
      expect(withBackend(dir)).toEqual([]);
    });
  });

  test("a different memory_type never pairs, however alike", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, "_memory/policy-rules/copy-of-mq-zZ9yY8xX7w.md", {
        ...PUB_FIELDS,
        id: "zZ9yY8xX7w",
        memory_type: "PolicyRule",
        title: "Adopt a message queue for order events",
        summary:
          "Order-service publishes order lifecycle events to the shared message queue instead of calling downstream services directly.",
      });
      expect(withBackend(dir)).toEqual([]);
    });
  });

  test("needs a literal shared applies_to Facet", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, { ...PUB_FIELDS, applies_to: "[service:billing-service]" });
      expect(withBackend(dir)).toEqual([]);
      const { applies_to: _, ...bare } = PUB_FIELDS;
      await writeRecord(dir, PUB, bare);
      expect(withBackend(dir)).toEqual([]);
    });
  });

  test("a proposed Record is not compared", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, { ...PUB_FIELDS, status: "proposed" });
      expect(withBackend(dir)).toEqual([]);
    });
  });

  test("the threshold is strict and echoed in the message", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      expect(withBackend(dir, 0.9)).toEqual([]);
      expect(withBackend(dir, 0.86).map((f) => f.message)).toEqual([`scores 0.88 against ${PUB} (threshold 0.86)`]);
      // The score is exactly 7/8, so equal is not above.
      expect(withBackend(dir, 0.875)).toEqual([]);
    });
  });

  test("two runs agree, and no backend means no finding", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      expect(withBackend(dir)).toEqual(withBackend(dir));
      expect(nearDup(doctor(dir))).toEqual([]);
    });
  });

  test("a missing memory_type never pairs", async () => {
    await scratch(async (dir) => {
      const { memory_type: _m, ...untyped } = PUB_FIELDS;
      await writeRecord(dir, PUB, untyped);
      await writeRecord(dir, "_memory/decisions/untyped-copy-qQ1wW2eE3r.md", { ...untyped, id: "qQ1wW2eE3r" });
      expect(withBackend(dir)).toEqual([]);
    });
  });

  test("a header that drifted from its folder still pairs within the folder", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, { ...PUB_FIELDS, memory_type: "Context" });
      expect(withBackend(dir).map((f) => f.related_files)).toEqual([[PUB]]);
    });
  });

  test("an invalid memory_type never pairs, even inside a typed folder", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, { ...PUB_FIELDS, memory_type: "Nonsense" });
      expect(withBackend(dir)).toEqual([]);
    });
  });

  const MQ_TITLE = "Adopt a message queue for order events";
  // The demo Bank holds other Decisions; only the MQ/PUB pair should score.
  const pairOnly = (record: { path: string }, text: string, score: number) =>
    (record.path === MQ || record.path === PUB) && (text === MQ_TITLE || text === PUB_FIELDS.title) ? score : 0;
  const run = (dir: string, backend: RecallBackend) =>
    nearDup(
      runDoctor(listRecords(loadConfig(dir), () => {}), TODAY, DEFAULTS, backend),
    );

  test("a backend that scores a pair differently each way reports the higher score", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      const asymmetric: RecallBackend = {
        search: (records, text) => records.map((record) => ({ record, score: pairOnly(record, text, text === MQ_TITLE ? 0.9 : 0.95) })),
      };
      expect(run(dir, asymmetric).map((f) => f.message)).toEqual([`scores 0.95 against ${PUB} (threshold 0.85)`]);
    });
  });

  test("a hit outside the candidate set never pairs", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      await writeRecord(dir, "_memory/policy-rules/stray-zZ9yY8xX7w.md", {
        ...PUB_FIELDS,
        id: "zZ9yY8xX7w",
        memory_type: "PolicyRule",
        title: "Stray rule",
        summary: "Unrelated.",
        applies_to: "[service:order-service, domain:commerce]",
      });
      const all = listRecords(loadConfig(dir), () => {});
      const stray = all.find((r) => r.path.includes("stray-zZ9yY8xX7w"))!;
      const leaky: RecallBackend = {
        search: (records) => [...records.map((record) => ({ record, score: 0 })), { record: stray, score: 0.99 }],
      };
      const found = run(dir, leaky);
      expect(found).toEqual([]);
      expect(JSON.stringify(found)).not.toContain("stray-zZ9yY8xX7w");
    });
  });

  // Hits only when the query is PUB's summary, so a finding proves the summary was what got sent.
  const summaryOnly: RecallBackend = {
    search: (records, text) =>
      text === PUB_FIELDS.summary ? records.filter((r) => r.path === MQ).map((record) => ({ record, score: 0.95 })) : [],
  };
  test.each([
    ["an empty title", { title: '""' }],
    ["a missing title", { title: null }],
    ["a whitespace-only title", { title: '"   "' }],
    ["a punctuation-only title", { title: '"???"' }],
  ])("%s queries on the summary", async (_, change) => {
    await scratch(async (dir) => {
      const { title: _t, ...noTitle } = PUB_FIELDS;
      await writeRecord(dir, PUB, change.title === null ? noTitle : { ...noTitle, ...change });
      expect(run(dir, summaryOnly).map((f) => f.message)).toEqual([`scores 0.95 against ${PUB} (threshold 0.85)`]);
    });
  });

  test("a Record with neither a usable title nor a summary pairs with nothing and doesn't throw", async () => {
    await scratch(async (dir) => {
      const { summary: _s, ...bare } = PUB_FIELDS;
      await writeRecord(dir, PUB, { ...bare, title: '"???"' });
      const queries: string[] = [];
      const spy: RecallBackend = { search: (_r, text) => (queries.push(text), []) };
      expect(run(dir, spy)).toEqual([]);
      expect(queries).not.toContain("???");
      expect(queries).not.toContain(undefined as unknown as string);
    });
  });

  test("a backend's queryText replaces the title as the query", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      const texts: string[] = [];
      const picky: RecallBackend = {
        search: (_r, text) => (texts.push(text), []),
        queryText: (r) => `Q:${r.frontmatter.id}`,
      };
      run(dir, picky);
      expect(texts.sort()).toEqual(acceptedIds(dir).map((id) => `Q:${id}`));
    });
  });

  test("a null queryText skips that Record's query", async () => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      const texts: string[] = [];
      const picky: RecallBackend = {
        search: (_r, text) => (texts.push(text), []),
        queryText: (r) => (r.frontmatter.id === "aB3cD4eF5g" ? null : `Q:${r.frontmatter.id}`),
      };
      run(dir, picky);
      expect(texts.sort()).toEqual(acceptedIds(dir).filter((id) => id !== "aB3cD4eF5g").map((id) => `Q:${id}`));
    });
  });

  test.each([
    [0.854, "0.854"],
    [0.9999, "0.9999"],
  ])("a score of %p prints as %s, above the threshold it sits beside", async (score, shown) => {
    await scratch(async (dir) => {
      await writeRecord(dir, PUB, PUB_FIELDS);
      const fixed: RecallBackend = { search: (records, text) => records.map((record) => ({ record, score: pairOnly(record, text, score) })) };
      expect(run(dir, fixed).map((f) => f.message)).toEqual([`scores ${shown} against ${PUB} (threshold 0.85)`]);
    });
  });
});
