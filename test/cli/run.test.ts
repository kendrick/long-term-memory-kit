import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run } from "../../src/cli/run.ts";
import type { Command } from "../../src/cli/run.ts";
import { defaultCommands } from "../../src/cli/commands.ts";

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

  test("--help leaves out a hidden command, which still runs", async () => {
    const hidden: Command = { ...stub("ghost"), hidden: true };
    const r = await run({ ...base, argv: ["--help"] }, [stub("alpha"), hidden]);
    expect(r.stdout).toContain("alpha");
    expect(r.stdout).not.toContain("ghost");
    const ran = await run({ ...base, argv: ["ghost"] }, [hidden]);
    expect(ran.exitCode).toBe(0);
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

    test("checkArgs also receives the parsed option values", async () => {
      const cmd: Command = {
        name: "stub",
        summary: "stub",
        options: { type: { type: "string" } },
        checkArgs: (_p, values) => (values.type === "Bogus" ? "unknown type 'Bogus'" : undefined),
        async run() {
          return 0;
        },
      };
      const bad = await run({ ...base, argv: ["stub", "--type", "Bogus"] }, [cmd]);
      expect(bad).toEqual({ exitCode: 2, stdout: "", stderr: "ltm stub: unknown type 'Bogus'\n" });
      const ok = await run({ ...base, argv: ["stub", "--type", "Decision"] }, [cmd]);
      expect(ok.exitCode).toBe(0);
    });
  });
});

describe("run <command> --help", () => {
  const throwing: Command = {
    name: "boom",
    summary: "throws everywhere",
    positionals: [{ name: "x", required: true }],
    checkArgs() {
      throw new Error("checkArgs ran");
    },
    async run() {
      throw new Error("run ran");
    },
  };
  const alpha = (options: Command["options"]): Command => ({
    ...stub("alpha"),
    positionals: [
      { name: "id", required: true },
      { name: "rest", required: false, variadic: true },
    ],
    options,
  });
  const jsonAndTag = { json: { type: "boolean" }, tag: { type: "string", multiple: true } } as const;

  test("every default command prints every declared option and exits 0", async () => {
    for (const cmd of defaultCommands) {
      const r = await run({ ...base, argv: [cmd.name, "--help"] });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      for (const key of Object.keys(cmd.options ?? {})) expect(r.stdout).toContain(`--${key}`);
    }
  });

  test("-h prints the same as --help", async () => {
    const a = await run({ ...base, argv: ["query", "--help"] });
    const b = await run({ ...base, argv: ["query", "-h"] });
    expect(b).toEqual(a);
  });

  test("formats usage, summary, and padded options from the declaration", async () => {
    const r = await run({ ...base, argv: ["alpha", "--help"] }, [alpha(jsonAndTag)]);
    expect(r).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        "Usage: ltm alpha <id> [rest...] [options]",
        "alpha summary",
        "",
        "Options:",
        "  --json",
        "  --tag <value>  (repeatable)",
        "",
      ].join("\n"),
    });
  });

  test("removing an option removes its line", async () => {
    const r = await run({ ...base, argv: ["alpha", "--help"] }, [alpha({ json: jsonAndTag.json })]);
    expect(r.stdout).not.toContain("--tag");
    expect(r.stdout).toContain("  --json");
  });

  test("adding an option adds its line", async () => {
    const r = await run({ ...base, argv: ["alpha", "--help"] }, [
      alpha({ ...jsonAndTag, extra: { type: "boolean" } }),
    ]);
    expect(r.stdout).toContain("  --extra\n");
  });

  test("a command with no options omits [options] and the Options block", async () => {
    const r = await run({ ...base, argv: ["alpha", "--help"] }, [stub("alpha")]);
    expect(r.stdout).toBe("Usage: ltm alpha\nalpha summary\n");
  });

  test("help runs before checkArgs and run", async () => {
    const r = await run({ ...base, argv: ["boom", "--help"] }, [throwing]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: ltm boom <x>");
  });

  test("propose --help exits 0 without --type and --title", async () => {
    const r = await run({ ...base, argv: ["propose", "--help"] });
    expect(r.exitCode).toBe(0);
  });

  test("query -- --help stays a positional and is rejected", async () => {
    const r = await run({ ...base, argv: ["query", "--", "--help"] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid filter '--help'");
  });

  test("a hidden command answers --help", async () => {
    const hidden: Command = { ...stub("ghost"), hidden: true };
    const r = await run({ ...base, argv: ["ghost", "--help"] }, [hidden]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: ltm ghost");
  });
});

describe("run did-you-mean", () => {
  test("a one-edit command typo suggests the command", async () => {
    const r = await run({ ...base, argv: ["quer"] });
    expect(r).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "ltm: unknown command 'quer'\nDid you mean 'query'?\nRun 'ltm --help' for usage.\n",
    });
  });

  test("a command 3 edits from every candidate prints no suggestion", async () => {
    const r = await run({ ...base, argv: ["frob"] });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ltm: unknown command 'frob'\nRun 'ltm --help' for usage.\n");
  });

  test("a leading-option typo suggests --version", async () => {
    const r = await run({ ...base, argv: ["--verison"] });
    expect(r.stderr).toBe("ltm: unknown option '--verison'\nDid you mean '--version'?\nRun 'ltm --help' for usage.\n");
  });

  test("an option typo suggests the command's own option", async () => {
    const r = await run({ ...base, argv: ["query", "--facets", "x"] });
    expect(r).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "ltm query: Unknown option '--facets'.\nDid you mean '--facet'?\n",
    });
  });

  test("an option typo gets no suggestion when only another command has the option", async () => {
    const r = await run({ ...base, argv: ["doctor", "--facets"] });
    expect(r).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "ltm doctor: Unknown option '--facets'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--facets\"\n",
    });
  });

  test("an option typo with =value is compared without the value", async () => {
    const r = await run({ ...base, argv: ["query", "--facets=x"] });
    expect(r.stderr).toContain("Did you mean '--facet'?");
  });

  test("a hidden command is never suggested, and is once unhidden", async () => {
    const hidden: Command = { ...stub("secret"), hidden: true };
    const quiet = await run({ ...base, argv: ["secre"] }, [stub("alpha"), hidden]);
    expect(quiet.exitCode).toBe(2);
    expect(quiet.stderr).toBe("ltm: unknown command 'secre'\nRun 'ltm --help' for usage.\n");
    const loud = await run({ ...base, argv: ["secre"] }, [stub("alpha"), stub("secret")]);
    expect(loud.stderr).toContain("Did you mean 'secret'?");
  });

  test("ties are all named, in list order", async () => {
    const r = await run({ ...base, argv: ["abc"] }, [stub("abd"), stub("abf")]);
    expect(r.stderr).toBe("ltm: unknown command 'abc'\nDid you mean 'abd' or 'abf'?\nRun 'ltm --help' for usage.\n");
    const three = await run({ ...base, argv: ["abc"] }, [stub("abd"), stub("abf"), stub("abg")]);
    expect(three.stderr).toContain("Did you mean 'abd', 'abf', or 'abg'?");
  });

  test("a parse error that isn't an unknown option prints as before", async () => {
    const r = await run({ ...base, argv: ["query", "--type"] });
    expect(r).toEqual({ exitCode: 2, stdout: "", stderr: "ltm query: Option '--type <value>' argument missing\n" });
  });
});
