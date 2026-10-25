import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { SCHEMA_VERSIONS, versionJson } from "../../src/core/schema-versions.ts";
import { checkRecordText, compileRecordSchema } from "../../src/core/validate.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const rel = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const valid = readFileSync(join(ROOT, "fixtures/demo-bank", rel), "utf8");
const v2 = valid.replace(/^schema: 1$/m, "schema: 2");

test("record schema's enum is exactly SCHEMA_VERSIONS", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "schema/record.schema.json"), "utf8"));
  expect(schema.properties.schema.enum).toEqual([...SCHEMA_VERSIONS]);
});

test("falsifier: schema: 2 passes only once 2 is declared", () => {
  expect(v2).not.toBe(valid);
  const { findings } = checkRecordText(rel, "Decision", v2, null);
  expect(findings.some((f) => f.rule === "schema" && f.key === "schema")).toBe(true);

  const data = parse(v2.split("\n---")[0]!.replace(/^---\n/, ""));
  expect(data.schema).toBe(2);
  const widened = compileRecordSchema([1, 2]);
  widened(data);
  expect((widened.errors ?? []).filter((e) => e.instancePath === "/schema")).toEqual([]);
  expect(versionJson([1, 2]).schemas).toEqual([1, 2]);
});

test(
  "compiled binary runs from outside the source tree",
  () => {
    const bin = mkdtempSync(join(tmpdir(), "ltm-bin-"));
    const bank = mkdtempSync(join(tmpdir(), "ltm-bank-"));
    try {
      const out = join(bin, "ltm");
      const build = spawnSync("bun", ["build", "--compile", join(ROOT, "src/cli/bin.ts"), "--outfile", out], {
        encoding: "utf8",
      });
      expect(build.stderr).not.toContain("error");
      expect(build.status).toBe(0);
      cpSync(join(ROOT, "fixtures/demo-bank"), bank, { recursive: true });
      for (const args of [["--version"], ["validate"]]) {
        const r = spawnSync(out, args, { cwd: bank, encoding: "utf8" });
        expect({ args, status: r.status, stderr: r.stderr }).toEqual({ args, status: 0, stderr: "" });
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(bank, { recursive: true, force: true });
    }
  },
  120_000,
);
