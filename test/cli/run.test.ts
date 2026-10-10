import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run } from "../../src/cli/run.ts";
import type { Command } from "../../src/cli/run.ts";

// Read independently of run's own import so the test can't agree with itself.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const base = { cwd: "/", env: {} };

const stub = (name: string): Command => ({
  name,
  summary: `${name} summary`,
  async run() {
    return 0;
  },
});

const check: Command = {
  name: "check",
  summary: "stub that fails after parsing",
  options: { strict: { type: "boolean" } },
  positionals: [{ name: "path", required: true }],
  async run(ctx) {
    ctx.err("1 problem\n");
    return 1;
  },
};

describe("run", () => {
  test("--version prints the package version", async () => {
    const r = await run({ ...base, argv: ["--version"] });
    expect(r).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
  });

  test("--help with the default table exits 0", async () => {
    const r = await run({ ...base, argv: ["--help"] });
    expect(r.exitCode).toBe(0);
  });

  test("--help lists every registered command", async () => {
    const r = await run({ ...base, argv: ["--help"] }, [stub("alpha"), stub("beta")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alpha");
    expect(r.stdout).toContain("beta");
  });

  test("empty argv prints help and exits 0", async () => {
    const r = await run({ ...base, argv: [] }, [stub("alpha")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alpha");
  });

  test("unknown command exits 2 with empty stdout", async () => {
    const r = await run({ ...base, argv: ["no-such-command"] });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no-such-command");
  });

  test("unknown leading flag exits 2 and is called an option", async () => {
    const r = await run({ ...base, argv: ["--nope"] });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown option");
    expect(r.stderr).toContain("--nope");
  });

  test("a command's own failure returns 1, not 2", async () => {
    const r = await run({ ...base, argv: ["check", "x"] }, [check]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("1 problem");
  });

  test("missing required positional exits 2", async () => {
    const r = await run({ ...base, argv: ["check"] }, [check]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("check");
  });

  test("unknown flag exits 2", async () => {
    const r = await run({ ...base, argv: ["check", "x", "--bogus"] }, [check]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("check");
  });

  test("extra positional exits 2", async () => {
    const r = await run({ ...base, argv: ["check", "x", "y"] }, [check]);
    expect(r.exitCode).toBe(2);
  });

  describe("variadic positionals and checkArgs", () => {
    const spy = (
      positionals: Command["positionals"],
      checkArgs?: Command["checkArgs"],
    ) => {
      const seen = { called: false, positionals: [] as string[] };
      const cmd: Command = {
        name: "stub",
        summary: "stub",
        positionals,
        checkArgs,
        async run(ctx) {
          seen.called = true;
          seen.positionals = ctx.positionals;
          return 0;
        },
      };
      return { cmd, seen };
    };

    test("required variadic needs at least one and then takes any number", async () => {
      const { cmd, seen } = spy([{ name: "path", required: true, variadic: true }]);
      const none = await run({ ...base, argv: ["stub"] }, [cmd]);
      expect(none.exitCode).toBe(2);
      expect(none.stderr).toContain("missing argument <path>");
      expect(seen.called).toBe(false);

      const many = await run({ ...base, argv: ["stub", "a", "b", "c"] }, [cmd]);
      expect(many.exitCode).toBe(0);
      expect(seen.positionals).toEqual(["a", "b", "c"]);
    });

    test("optional variadic accepts zero positionals", async () => {
      const { cmd, seen } = spy([{ name: "f", required: false, variadic: true }]);
      const r = await run({ ...base, argv: ["stub"] }, [cmd]);
      expect(r.exitCode).toBe(0);
      expect(seen.called).toBe(true);
      expect(seen.positionals).toEqual([]);
    });

    test("non-variadic stub still rejects an extra positional", async () => {
      const { cmd, seen } = spy([{ name: "p", required: true }]);
      const r = await run({ ...base, argv: ["stub", "a", "b"] }, [cmd]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("unexpected argument 'b'");
      expect(seen.called).toBe(false);
    });

    test("checkArgs string is a usage error and run is never called", async () => {
      const { cmd, seen } = spy(
        [{ name: "f", required: false, variadic: true }],
        (p) => (p.includes("x") ? "bad filter 'x'" : undefined),
      );
      const bad = await run({ ...base, argv: ["stub", "x"] }, [cmd]);
      expect(bad).toEqual({ exitCode: 2, stdout: "", stderr: "ltm stub: bad filter 'x'\n" });
      expect(seen.called).toBe(false);

      const ok = await run({ ...base, argv: ["stub", "y"] }, [cmd]);
      expect(ok.exitCode).toBe(0);
      expect(seen.called).toBe(true);
    });
  });
});
