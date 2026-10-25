import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Runs in a child process because mock.module is process-wide in bun and would leak into every later test file.
const probeSource = (root: string): string => `
import { mock } from "bun:test";
const sv = ${JSON.stringify(join(root, "src/core/schema-versions.ts"))};
const real = await import(sv);
mock.module(sv, () => ({ ...real, SCHEMA_VERSIONS: JSON.parse(process.env.LTM_VERSIONS) }));
if (process.env.LTM_PKG_VERSION) {
  const pj = ${JSON.stringify(join(root, "package.json"))};
  const pkg = (await import(pj, { with: { type: "json" } })).default;
  mock.module(pj, () => ({ default: { ...pkg, version: process.env.LTM_PKG_VERSION } }));
}
const { run } = await import(${JSON.stringify(join(root, "src/cli/run.ts"))});
const go = (argv) => run({ argv, cwd: process.env.LTM_BANK, env: {} });
console.log(JSON.stringify({
  version: await go(["--version"]),
  json: await go(["--version", "--json"]),
  validate: await go(["validate", ${JSON.stringify(rel)}]),
}));
`;

test(
  "falsifier through run(): the declared list decides schema:, package.json's version decides nothing",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-probe-"));
    const bank = mkdtempSync(join(tmpdir(), "ltm-bank-"));
    try {
      cpSync(join(ROOT, "fixtures/demo-bank"), bank, { recursive: true });
      writeFileSync(join(bank, rel), v2);
      const probe = join(dir, "probe.ts");
      writeFileSync(probe, probeSource(ROOT));
      const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
      const go = (versions: number[], pkgVersion = "") => {
        const r = spawnSync("bun", ["run", probe], {
          encoding: "utf8",
          env: { ...process.env, LTM_VERSIONS: JSON.stringify(versions), LTM_PKG_VERSION: pkgVersion, LTM_BANK: bank },
        });
        expect(r.stderr).toBe("");
        return JSON.parse(r.stdout) as Record<"version" | "json" | "validate", { exitCode: number; stdout: string; stderr: string }>;
      };

      const narrow = go([1]);
      expect(narrow.validate.exitCode).toBe(1);
      expect(narrow.validate.stdout).toBe(`${rel}:2: error schema: schema: must be equal to one of the allowed values\n`);
      expect(narrow.json.stdout).toBe(`{"version":"${version}","schemas":[1]}\n`);

      const wide = go([1, 2]);
      expect(wide.validate).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(wide.json).toEqual({ exitCode: 0, stdout: `{"version":"${version}","schemas":[1,2]}\n`, stderr: "" });

      const bumped = "0.0.0-falsifier";
      expect(bumped).not.toBe(version);
      for (const [versions, before] of [[[1], narrow], [[1, 2], wide]] as const) {
        const after = go([...versions], bumped);
        // The bump must reach the code under test, or "unchanged" below proves nothing.
        expect(after.version.stdout).toBe(`${bumped}\n`);
        expect(after.validate).toEqual(before.validate);
        expect(JSON.parse(after.json.stdout).schemas).toEqual(JSON.parse(before.json.stdout).schemas);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bank, { recursive: true, force: true });
    }
  },
  60_000,
);

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
