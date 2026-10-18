import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfig } from "../../src/core/bank.ts";
import { splitFrontmatter } from "../../src/core/record.ts";
import { applyEdits, type BankIndex, type Edit, type EditFs, planAccept, planSupersede, readBankIndex } from "../../src/core/supersede.ts";
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

    test("5b: the new Record is not accepted", async () => {
      await withScratch(demoBank, async (dir) => {
        // Share a Facet with H so the scope refusal can't answer first.
        await patch(dir, P, "applies_to: [platform:kubernetes, system:observability]", "applies_to: [domain:commerce]");
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "pL2sG4nVq0")).toEqual({
          refusal: `${P} has status 'proposed', not 'accepted'`,
        });
        await patch(dir, P, "status: proposed\n", "");
        expect(planSupersede(indexOf(dir), "hT5cY8dUa6", "pL2sG4nVq0")).toEqual({
          refusal: `${P} has status 'undefined', not 'accepted'`,
        });
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

  test("a Proposal that already carries superseded_by is refused", async () => {
    await withScratch(demoBank, async (dir) => {
      await patch(dir, P, "date: 2026-09-30\n", "date: 2026-09-30\nsuperseded_by: kQ7vN2xLp4\n");
      expect(planAccept(indexOf(dir), "pL2sG4nVq0", "2026-10-09")).toEqual({ refusal: `${P} is already superseded by 'kQ7vN2xLp4'` });
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
  const temps = async (dir: string) => (await readdir(join(dir, "_memory/decisions"))).filter((f) => f.includes(".ltm-"));

  async function withPlannedPair(fn: (dir: string, edits: Edit[], before: string[]) => Promise<void>): Promise<void> {
    await withScratch(demoBank, async (dir) => {
      const edits = editsOf(planSupersede(indexOf(dir), "hT5cY8dUa6", "kQ7vN2xLp4"));
      expect(edits.map((e) => e.rel)).toEqual([H, K]);
      const before = [await readFile(join(dir, H), "utf8"), await readFile(join(dir, K), "utf8")];
      await fn(dir, edits, before);
    });
  }

  const after = async (dir: string) => [await readFile(join(dir, H), "utf8"), await readFile(join(dir, K), "utf8")];

  function failingRename(n: number): EditFs["renameSync"] {
    let calls = 0;
    return (from, to) => {
      if (++calls === n) throw new Error(`EIO: injected rename failure\nsecond line`);
      fs.renameSync(from, to);
    };
  }

  test("writes every edit and leaves no temp file behind", async () => {
    await withPlannedPair(async (dir, edits) => {
      expect(applyEdits(edits)).toEqual({ written: [H, K], failed: null });
      expect(await after(dir)).toEqual(edits.map((e) => e.text));
      expect(await temps(dir)).toEqual([]);
    });
  });

  const modes = async (dir: string) => [(await lstat(join(dir, H))).mode & 0o777, (await lstat(join(dir, K))).mode & 0o777];

  test("each target keeps its own file mode after the write", async () => {
    await withPlannedPair(async (dir, edits) => {
      await chmod(join(dir, H), 0o600);
      await chmod(join(dir, K), 0o640);
      expect(applyEdits(edits)).toEqual({ written: [H, K], failed: null });
      expect(await modes(dir)).toEqual([0o600, 0o640]);
    });
  });

  test("a rollback after a failed rename leaves the first target's mode as it was", async () => {
    await withPlannedPair(async (dir, edits, before) => {
      await chmod(join(dir, H), 0o600);
      const result = applyEdits(edits, { ...fs, renameSync: failingRename(2) });
      expect(result.written).toEqual([]);
      expect(await after(dir)).toEqual(before);
      expect(await modes(dir)).toEqual([0o600, 0o644]);
    });
  });

  test("a staging failure on the second edit changes neither target and leaves no temp file", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    await withPlannedPair(async (dir, edits, before) => {
      await chmod(join(dir, K), 0o444);
      try {
        const result = applyEdits(edits);
        expect(result.written).toEqual([]);
        expect(result.failed?.rel).toBe(K);
        expect(result.failed?.message).not.toContain("\n");
        expect(await after(dir)).toEqual(before);
        expect(await temps(dir)).toEqual([]);
      } finally {
        await chmod(join(dir, K), 0o644);
      }
    });
  });

  test("a failed second rename restores the first target and leaves no temp file", async () => {
    await withPlannedPair(async (dir, edits, before) => {
      const result = applyEdits(edits, { ...fs, renameSync: failingRename(2) });
      expect(result).toEqual({ written: [], failed: { rel: K, message: "EIO: injected rename failure" } });
      expect(await after(dir)).toEqual(before);
      expect(await temps(dir)).toEqual([]);
    });
  });

  test("a restore that also fails names the target it left changed", async () => {
    await withPlannedPair(async (dir, edits, before) => {
      const writeFileSync: EditFs["writeFileSync"] = (path, data, options) => {
        if (path === join(dir, H)) throw new Error("EIO: injected restore failure");
        fs.writeFileSync(path, data, options);
      };
      const result = applyEdits(edits, { ...fs, renameSync: failingRename(2), writeFileSync });
      expect(result).toEqual({ written: [H], failed: { rel: K, message: "EIO: injected rename failure" } });
      expect(await after(dir)).toEqual([edits[0]!.text, before[1]!]);
      expect(await temps(dir)).toEqual([]);
    });
  });

  // Temp names no longer carry the basename, so the first edit needs a different nonce for the planted path to collide with K's.
  const fixedNonce = () => {
    let calls = 0;
    return () => (calls++ === 0 ? "aaaaaaaaaaaa" : "0123456789ab");
  };
  const plantedName = ".ltm-0123456789ab.tmp";

  test("a symlink planted at the temp path is not followed or removed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ltm-outside-"));
    try {
      const victim = join(outside, "victim.txt");
      await writeFile(victim, "not a Record\n");
      await withPlannedPair(async (dir, edits, before) => {
        const planted = join(dir, "_memory/decisions", plantedName);
        await symlink(victim, planted);
        const result = applyEdits(edits, fs, fixedNonce());
        expect(result.written).toEqual([]);
        expect(result.failed?.rel).toBe(K);
        expect(result.failed?.message).toContain("EEXIST");
        expect(await readFile(victim, "utf8")).toBe("not a Record\n");
        expect((await lstat(planted)).isSymbolicLink()).toBe(true);
        expect(await readlink(planted)).toBe(victim);
        expect(await after(dir)).toEqual(before);
        expect(await temps(dir)).toEqual([plantedName]);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a regular file already at the temp path is neither overwritten nor deleted", async () => {
    await withPlannedPair(async (dir, edits, before) => {
      const planted = join(dir, "_memory/decisions", plantedName);
      await writeFile(planted, "someone else's bytes\n");
      const result = applyEdits(edits, fs, fixedNonce());
      expect(result.written).toEqual([]);
      expect(result.failed?.rel).toBe(K);
      expect(await readFile(planted, "utf8")).toBe("someone else's bytes\n");
      expect(await after(dir)).toEqual(before);
      expect(await temps(dir)).toEqual([plantedName]);
    });
  });

  test("each staged temp gets its own unpredictable name", async () => {
    await withPlannedPair(async (dir, edits) => {
      const created: string[] = [];
      const writeFileSync: EditFs["writeFileSync"] = (path, data, options) => {
        if (String(path).includes(".ltm-")) created.push(basename(String(path)));
        fs.writeFileSync(path, data, options);
      };
      expect(applyEdits(edits, { ...fs, writeFileSync })).toEqual({ written: [H, K], failed: null });
      expect(created).toHaveLength(2);
      for (const name of created) expect(name).toMatch(/^\.ltm-[0-9a-f]{12}\.tmp$/);
      expect(new Set(created).size).toBe(2);
      expect(await temps(dir)).toEqual([]);
    });
  });
  test("a Record changed on disk after planning is refused and neither target changes", async () => {
    await withPlannedPair(async (dir, edits, before) => {
      const changed = before[1]! + "\nAnother command's edit.\n";
      await writeFile(join(dir, K), changed);
      const result = applyEdits(edits);
      expect(result).toEqual({ written: [], failed: { rel: K, message: "changed on disk since it was read; run the command again" } });
      expect(await after(dir)).toEqual([before[0]!, changed]);
      expect(await temps(dir)).toEqual([]);
    });
  });

  test("a Record whose basename nears the filesystem's 255-byte limit can still be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-longname-"));
    try {
      const name = `${"a".repeat(240)}.md`;
      await writeFile(join(dir, name), "old\n");
      const edit: Edit = { abs: join(dir, name), rel: name, base: "old\n", text: "new\n" };
      expect(applyEdits([edit])).toEqual({ written: [name], failed: null });
      expect(await readFile(join(dir, name), "utf8")).toBe("new\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
