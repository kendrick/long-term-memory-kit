import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { run } from "../../src/cli/run.ts";
import { withConsumerRepo } from "../helpers/consumer-repo.ts";

const demo = new URL("../../fixtures/demo-bank", import.meta.url).pathname.replace(/\/$/, "");
const POSTGRES = "_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md";
const postgresBytes = readFileSync(join(demo, POSTGRES), "utf8");
const ltm = (cwd: string, ...argv: string[]) => run({ argv, cwd, env: {} });

const temps: string[] = [];
const tempDir = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ltm-show-")));
  temps.push(d);
  return d;
};
const bankCopy = (): string => {
  const d = tempDir();
  cpSync(demo, d, { recursive: true });
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ltm show", () => {
  test("an id prints the Record file's bytes unchanged, body included", async () => {
    const r = await ltm(demo, "show", "kQ7vN2xLp4");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(postgresBytes);
    expect(r.stdout).toContain("\n## Decision\n");
  });

  test("a Bank-relative path prints the same bytes", async () => {
    const r = await ltm(demo, "show", POSTGRES);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(postgresBytes);
  });

  test("a bare in-Bank filename that isn't a Record is refused as a path", async () => {
    const r = await ltm(demo, "show", "memory-bank.yaml");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ltm show: memory-bank.yaml is not a Record in the Bank\n");
  });

  test("a ./-prefixed in-Bank file that isn't a Record is refused", async () => {
    const r = await ltm(demo, "show", "./memory-bank.yaml");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ltm show: ./memory-bank.yaml is not a Record in the Bank\n");
  });

  test("a path climbing out of the Bank is refused", async () => {
    const r = await ltm(demo, "show", "../memory-bank.yaml");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ltm show: ../memory-bank.yaml is outside the Bank\n");
  });

  test("a symlink pointing out of the Bank is refused", async () => {
    const bank = bankCopy();
    const secret = join(tempDir(), "secret.md");
    writeFileSync(secret, "---\nid: zZ9zZ9zZ9z\n---\nsecret\n");
    symlinkSync(secret, join(bank, "_memory/decisions/escape.md"));
    const r = await ltm(bank, "show", "_memory/decisions/escape.md");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ltm show: _memory/decisions/escape.md is outside the Bank\n");
  });

  test("an unknown id exits 1", async () => {
    const r = await ltm(demo, "show", "nO0nE0xIs7");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ltm show: 'nO0nE0xIs7' matches no Record\n");
  });

  test("an id two Records hold is refused with the count", async () => {
    const bank = bankCopy();
    cpSync(join(bank, POSTGRES), join(bank, "_memory/decisions/postgres-copy-kQ7vN2xLp4.md"));
    const r = await ltm(bank, "show", "kQ7vN2xLp4");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ltm show: 'kQ7vN2xLp4' is held by 2 Records\n");
  });

  test("--bank works from an empty dir that isn't a git repo", async () => {
    const r = await ltm(tempDir(), "show", "kQ7vN2xLp4", "--bank", demo);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(postgresBytes);
  });

  test("--bank works by id from a Consumer repo", async () => {
    await withConsumerRepo(async (repo) => {
      const r = await ltm(repo, "show", "kQ7vN2xLp4", "--bank", demo);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(postgresBytes);
    });
  });

  test("an absolute path into the second of two resolved Banks prints that Record", async () => {
    const home = tempDir();
    const banks = ["acme", "personal"].map((name) => {
      const dir = join(home, "banks", name);
      cpSync(demo, dir, { recursive: true });
      return dir;
    });
    const repo = join(home, "repo");
    mkdirSync(repo);
    spawnSync("git", ["-C", repo, "init", "-q"]);
    const config = join(home, "config.yaml");
    writeFileSync(config, `banks:\n  acme: { path: ${banks[0]} }\n  personal: { path: ${banks[1]} }\n`);
    writeFileSync(join(repo, ".ltm.yaml"), "banks: [acme, personal]\n");
    const r = await run({ argv: ["show", join(banks[1] as string, POSTGRES)], cwd: repo, env: { LTM_CONFIG: config, HOME: home } });
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(postgresBytes);
  });

  test("no Bank anywhere prints where it looked", async () => {
    const r = await ltm(tempDir(), "show", "kQ7vN2xLp4");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith("ltm show: no Bank for this repo; checked ");
  });
});
