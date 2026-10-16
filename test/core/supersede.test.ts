import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfig } from "../../src/core/bank.ts";
import { splitFrontmatter } from "../../src/core/record.ts";
import { applyEdits, type BankIndex, type Edit, planAccept, planSupersede, readBankIndex } from "../../src/core/supersede.ts";
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

const H = "_memory/decisions/adopt-message-queue-for-orders-hT5cY8dUa6.md";
const K = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const M = "_memory/decisions/mysql-for-new-services-mB3tR9wZe1.md";
const P = "_memory/decisions/adopt-opentelemetry-tracing-pL2sG4nVq0.md";

function indexOf(dir: string): BankIndex {
  const skipped: string[] = [];
  const index = readBankIndex(loadConfig(dir), (rel, reason) => skipped.push(`${rel}: ${reason}`));
  expect(skipped).toEqual([]);
  return index;
}

// Fails loudly when `from` is absent, so a fixture drift can't turn a refusal test into a no-op edit.
async function patch(dir: string, rel: string, from: string, to: string): Promise<void> {
  const path = join(dir, rel);
  const text = await readFile(path, "utf8");
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

const fm = (text: string): Record<string, unknown> => parse(splitFrontmatter(text)!.frontmatterLines.join("\n"));
const body = (text: string): string => splitFrontmatter(text)!.body;

function editsOf(planned: ReturnType<typeof planSupersede>): Edit[] {
  if ("refusal" in planned) throw new Error(`unexpected refusal: ${planned.refusal}`);
  return planned.edits;
}

describe("planSupersede", () => {
  test("sets superseded_by, status, and supersedes on two accepted Decisions sharing domain:commerce", async () => {
    await withScratch(demoBank, async (dir) => {
      const edits = editsOf(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4"));
      expect(edits.map((e) => e.rel)).toEqual([H, K]);
      const [oldEdit, newEdit] = edits as [Edit, Edit];
      expect(fm(oldEdit.text).superseded_by).toBe("kQ7vN2xLp4");
      expect(fm(oldEdit.text).status).toBe("superseded");
      expect(fm(newEdit.text).supersedes).toEqual(["mB3tR9wZe1", "hT5cY8dUa6"]);
      expect(newEdit.text).toContain("\nsupersedes: [mB3tR9wZe1, hT5cY8dUa6]\n");
      expect(oldEdit.abs).toBe(join(dir, H));
    });
  });

  test("leaves every byte after the closing fence unchanged", async () => {
    await withScratch(demoBank, async (dir) => {
      const edits = editsOf(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4"));
      expect(edits).toHaveLength(2);
      for (const edit of edits) {
        const original = await readFile(join(dir, edit.rel), "utf8");
        expect(body(original).length).toBeGreaterThan(0);
        expect(body(edit.text)).toBe(body(original));
      }
    });
  });

  test("keeps CRLF line endings and the CRLF body", async () => {
    await withScratch(demoBank, async (dir) => {
      for (const rel of [H, K]) {
        const path = join(dir, rel);
        await writeFile(path, (await readFile(path, "utf8")).replaceAll("\n", "\r\n"));
      }
      const edits = editsOf(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4"));
      expect(edits).toHaveLength(2);
      for (const edit of edits) {
        const original = await readFile(join(dir, edit.rel), "utf8");
        expect(edit.text.startsWith("---\r\nschema: 1\r\n")).toBe(true);
        expect(edit.text.replaceAll("\r\n", "")).not.toContain("\n");
        expect(body(edit.text)).toBe(body(original));
      }
    });
  });

  test("planning again after applyEdits returns no edits", async () => {
    await withScratch(demoBank, async (dir) => {
      const edits = editsOf(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4"));
      expect(applyEdits(edits)).toEqual({ written: [H, K], failed: null });
      expect(await readFile(join(dir, H), "utf8")).toBe(edits[0]!.text);
      expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4")).toEqual({ edits: [] });
    });
  });

  describe("refusals", () => {
    test("1: old and new are the same Record", async () => {
      await withScratch(demoBank, async (dir) => {
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "hT5cY8dUa6")).toEqual({
          refusal: "old and new are the same Record ('hT5cY8dUa6')",
        });
      });
    });

    test("2: an id that matches no Record, the old one first", async () => {
      await withScratch(demoBank, async (dir) => {
        const index = indexOf(dir);
        expect(planSupersede(index, "NoSuchId00", "AlsoNone00")).toEqual({ refusal: "'NoSuchId00' matches no Record" });
        expect(planSupersede(index, "hT5cY8dUa6", "NoSuchId00")).toEqual({ refusal: "'NoSuchId00' matches no Record" });
      });
    });

    test("3: an id held by more than one Record", async () => {
      await withScratch(demoBank, async (dir) => {
        const copy = "_memory/decisions/adopt-message-queue-copy-hT5cY8dUa6.md";
        await writeFile(join(dir, copy), await readFile(join(dir, H), "utf8"));
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4")).toEqual({
          refusal: "'hT5cY8dUa6' is held by 2 Records",
        });
      });
    });

    test("4: the old Record is already superseded by another id", async () => {
      await withScratch(demoBank, async (dir) => {
        await patch(dir, H, "status: accepted\n", "status: superseded\nsuperseded_by: rX6jK1fWc9\n");
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4")).toEqual({
          refusal: `${H} is already superseded by 'rX6jK1fWc9'`,
        });
      });
    });

    test("5: the new Record is itself superseded", async () => {
      await withScratch(demoBank, async (dir) => {
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "mB3tR9wZe1")).toEqual({ refusal: `${M} is itself superseded` });
        // superseded_by alone counts, even with a status that disagrees.
        await patch(dir, K, "status: accepted\n", "status: accepted\nsuperseded_by: rX6jK1fWc9\n");
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4")).toEqual({ refusal: `${K} is itself superseded` });
      });
    });

    test("6: the old Record already reaches the new one through supersedes", async () => {
      await withScratch(demoBank, async (dir) => {
        await patch(dir, H, "status: accepted\n", "status: accepted\nsupersedes: [kQ7vN2xLp4]\n");
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4")).toEqual({
          refusal: `superseding ${H} with ${K} would make a cycle`,
        });
      });
    });

    test("7: the two Records share no applies_to entry", async () => {
      await withScratch(demoBank, async (dir) => {
        await patch(dir, K, "applies_to: [domain:commerce, system:data-platform]", "applies_to: [system:data-platform]");
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4")).toEqual({
          refusal: `${H} and ${K} share no applies_to entry`,
        });
      });
    });

    test("8: the new Record's supersedes is not a list of ids", async () => {
      await withScratch(demoBank, async (dir) => {
        await patch(dir, K, "supersedes: [mB3tR9wZe1]", "supersedes: mB3tR9wZe1");
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4")).toEqual({
          refusal: `${K}: supersedes is not a list of ids`,
        });
      });
    });
  });
});

describe("planAccept", () => {
  test("stamps status, date, and last_confirmed on the fixture's proposed Decision", async () => {
    await withScratch(demoBank, async (dir) => {
      const edits = editsOf(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09"));
      expect(edits.map((e) => e.rel)).toEqual([P]);
      const data = fm(edits[0]!.text);
      expect(data.status).toBe("accepted");
      expect(data.date).toBe("2026-10-09");
      expect(data.last_confirmed).toBe("2026-10-09");
      expect(body(edits[0]!.text)).toBe(body(await readFile(join(dir, P), "utf8")));
    });
  });

  test("last_confirmed moves forward to today from an earlier date", async () => {
    await withScratch(demoBank, async (dir) => {
      await patch(dir, P, "date: 2026-09-30\n", "date: 2026-09-30\nlast_confirmed: 2026-01-01\n");
      const data = fm(editsOf(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09"))[0]!.text);
      expect(data.last_confirmed).toBe("2026-10-09");
      expect(data.date).toBe("2026-10-09");
    });
  });

  test("last_confirmed stays put when it is already later than today", async () => {
    await withScratch(demoBank, async (dir) => {
      await patch(dir, P, "date: 2026-09-30\n", "date: 2026-09-30\nlast_confirmed: 2026-12-31\n");
      const data = fm(editsOf(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09"))[0]!.text);
      expect(data.last_confirmed).toBe("2026-12-31");
      expect(data.date).toBe("2026-10-09");
    });
  });

  test("supersedes the Records the Proposal lists in supersedes", async () => {
    await withScratch(demoBank, async (dir) => {
      await patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce, system:observability]\nsupersedes: [hT5cY8dUa6]");
      const edits = editsOf(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09"));
      expect(edits.map((e) => e.rel)).toEqual([H, P]);
      const old = fm(edits[0]!.text);
      expect(old.superseded_by).toBe("pL2sG4nVq0");
      expect(old.status).toBe("superseded");
      const proposal = fm(edits[1]!.text);
      expect(proposal.status).toBe("accepted");
      expect(proposal.supersedes).toEqual(["hT5cY8dUa6"]);
    });
  });

  test("an empty supersedes touches no other Record, even with a shared title word and Facet", async () => {
    await withScratch(demoBank, async (dir) => {
      // "Adopt" is in both titles, and domain:commerce is in both applies_to lists.
      await patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce, system:observability]\nsupersedes: []");
      const edits = editsOf(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09"));
      expect(edits.map((e) => e.rel)).toEqual([P]);
    });
  });

  test("all or nothing: one missing target refuses the whole accept", async () => {
    await withScratch(demoBank, async (dir) => {
      await patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce, system:observability]\nsupersedes: [hT5cY8dUa6, NoSuchId00]");
      expect(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09")).toEqual({ refusal: "'NoSuchId00' matches no Record" });
    });
  });

  test("refuses a Record that is not proposed", async () => {
    await withScratch(demoBank, async (dir) => {
      expect(planAccept(indexOf(dir), "kQ7vN2xLp4", "2026-10-09")).toEqual({
        refusal: `${K} has status 'accepted', not 'proposed'`,
      });
    });
  });

  test("refuses a last_confirmed that is not a YYYY-MM-DD date", async () => {
    await withScratch(demoBank, async (dir) => {
      await patch(dir, P, "date: 2026-09-30\n", "date: 2026-09-30\nlast_confirmed: soon\n");
      expect(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09")).toEqual({
        refusal: `${P}: last_confirmed 'soon' is not a YYYY-MM-DD date`,
      });
    });
  });

  test("refuses a last_confirmed that matches the pattern but is not a calendar day", async () => {
    await withScratch(demoBank, async (dir) => {
      await patch(dir, P, "date: 2026-09-30\n", "date: 2026-09-30\nlast_confirmed: 2026-02-30\n");
      expect(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09")).toEqual({
        refusal: `${P}: last_confirmed '2026-02-30' is not a YYYY-MM-DD date`,
      });
    });
  });
});

describe("applyEdits", () => {
  test("stops at the first failure and reports what it already wrote", async () => {
    await withScratch(demoBank, async (dir) => {
      await mkdir(join(dir, "blocked.md"));
      const result = applyEdits([
        { abs: join(dir, "a.md"), rel: "a.md", text: "a" },
        { abs: join(dir, "blocked.md"), rel: "blocked.md", text: "b" },
        { abs: join(dir, "c.md"), rel: "c.md", text: "c" },
      ]);
      expect(result.written).toEqual(["a.md"]);
      expect(result.failed?.rel).toBe("blocked.md");
      expect(result.failed?.message).not.toContain("\n");
      expect(await readFile(join(dir, "a.md"), "utf8")).toBe("a");
      await expect(readFile(join(dir, "c.md"), "utf8")).rejects.toThrow();
    });
  });
});
