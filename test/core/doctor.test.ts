import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type BankConfig } from "../../src/core/bank.ts";
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
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));
const TODAY = "2026-10-09";
const DEFAULTS: Thresholds = { stale_confirmed_days: 90, proposal_age_days: 30, max_chain_length: 3, orphan_days: 30 };

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
  test("lists the seven checks in report order", () => {
    expect(CHECKS.map((c) => c.name)).toEqual([
      "stale-confirmed",
      "review-due",
      "stale-proposal",
      "long-chain",
      "orphan",
      "broken-related",
      "supersession-no-shared-facet",
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
