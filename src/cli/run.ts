import type { ParseArgsConfig } from "node:util";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { defaultCommands } from "./commands.ts";

export type RunInput = {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};
export type RunResult = { exitCode: 0 | 1 | 2; stdout: string; stderr: string };
export type CommandContext = {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  cwd: string;
  env: RunInput["env"];
  out(text: string): void;
  err(text: string): void;
};
export type Command = {
  name: string;
  summary: string;
  options?: ParseArgsConfig["options"];
  // `variadic` is honored only on the last entry; earlier entries are ignored for it.
  positionals?: { name: string; required: boolean; variadic?: true }[];
  checkArgs?(positionals: string[], values: CommandContext["values"]): string | undefined;
  // A planned command holds its slot in commands.ts before it works; --help leaves it out.
  hidden?: true;
  run(ctx: CommandContext): Promise<0 | 1>;
};

const usageError = (stderr: string): RunResult => ({ exitCode: 2, stdout: "", stderr });

function helpText(commands: Command[]): string {
  const lines = commands.filter((c) => !c.hidden).map((c) => `  ${c.name}  ${c.summary}`);
  return ["Usage: ltm <command> [options]", ...lines].join("\n") + "\n";
}

export async function run(
  input: RunInput,
  commands: Command[] = defaultCommands,
): Promise<RunResult> {
  const [head, ...rest] = input.argv;

  if (head === "--version") return { exitCode: 0, stdout: `${pkg.version}\n`, stderr: "" };
  if (head === undefined || head === "--help") {
    return { exitCode: 0, stdout: helpText(commands), stderr: "" };
  }

  const cmd = commands.find((c) => c.name === head);
  if (!cmd) {
    const kind = head.startsWith("-") ? "option" : "command";
    return usageError(`ltm: unknown ${kind} '${head}'\nRun 'ltm --help' for usage.\n`);
  }

  // Exit 2 is decided here, before the command runs (parseArgs, the positional
  // count, and the command's checkArgs hook), so a command's own failure (1)
  // can never be confused with a usage error.
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: cmd.options ?? {},
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return usageError(`ltm ${cmd.name}: ${reason}\n`);
  }

  const declared = cmd.positionals ?? [];
  const requiredArgs = declared.filter((p) => p.required);
  const got = parsed.positionals.length;
  if (got < requiredArgs.length) {
    const missing = requiredArgs.slice(got).map((p) => `<${p.name}>`);
    return usageError(`ltm ${cmd.name}: missing argument ${missing.join(" ")}\n`);
  }
  if (got > declared.length && !declared.at(-1)?.variadic) {
    return usageError(`ltm ${cmd.name}: unexpected argument '${parsed.positionals[declared.length]}'\n`);
  }
  const values = parsed.values as CommandContext["values"];
  const bad = cmd.checkArgs?.(parsed.positionals, values);
  if (bad !== undefined) return usageError(`ltm ${cmd.name}: ${bad}\n`);

  let stdout = "";
  let stderr = "";
  const exitCode = await cmd.run({
    values,
    positionals: parsed.positionals,
    cwd: input.cwd,
    env: input.env,
    out: (t) => {
      stdout += t;
    },
    err: (t) => {
      stderr += t;
    },
  });
  return { exitCode, stdout, stderr };
}
