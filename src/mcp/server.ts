import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { parse } from "yaml";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import recordSchema from "../../schema/record.schema.json" with { type: "json" };
import { ConfigError, findBank, isInside, loadConfig } from "../core/bank.ts";
import { listRecords } from "../core/query.ts";
import { splitFrontmatter } from "../core/record.ts";
import { resolveBankFlag, resolveBanks, type Env } from "../core/resolve.ts";
import { configErrorLine, noBankLine } from "../cli/bank.ts";
import { run } from "../cli/run.ts";
import { BankLocator, bankCommits, namedRoot } from "./bank.ts";

type Named = { name: string; root: string };

// Descriptions come from the schema file, like canonical.ts, so an input named after a Record field describes itself the way the schema does.
const SCHEMA_PROPS: Record<string, { description?: string }> = recordSchema.properties;
const schemaDesc = (key: string): string => {
  const d = SCHEMA_PROPS[key]?.description;
  if (d === undefined) throw new Error(`record.schema.json has no description for ${key}`);
  return d;
};

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

const bankInput = z
  .string()
  .optional()
  .describe("Name or path of the Bank to read. Refused while LTM_BANK_PATH or LTM_BANK_URL picks the Bank.");

export function createServer(env: Env, cwd: string): McpServer {
  const server = new McpServer({ name: "ltm", version: pkg.version });
  const locator = new BankLocator();

  const pick = (bank: string | undefined) => locator.pickBank({ bank }, env, cwd);

  // Precedence is the env's pick, then `bank` read the way --bank reads it, then the Bank around the server's cwd.
  const pickRoot = async (tool: string, bank: string | undefined): Promise<{ root: string; notes: string[] } | CallToolResult> => {
    const picked = await pick(bank);
    if ("error" in picked) return fail(picked.error);
    try {
      const root = picked.root ?? (bank !== undefined && bank !== "" ? resolveBankFlag(bank, cwd, env).root : findBank(cwd));
      return root === null ? fail(noBankLine(tool, cwd).trimEnd()) : { root, notes: picked.notes };
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      return fail(configErrorLine(tool, e).trimEnd());
    }
  };

  // Records are read only through run(), so the MCP and CLI routes can't drift. Two exceptions: relOf's id lookup, because `ltm head` takes only a path, and read, which reads the file itself so the pinned retry can tie its bytes to one commit.
  const cli = (argv: string[], at: string) => run({ argv, cwd: at, env });

  // Another request's refresh can fast-forward the clone mid-read. A read counts only when HEAD held still across it, so bank_commits names the commit the data came from.
  // `accept` also vets the output: `git merge --ff-only` rewrites worktree files before it moves the ref, so HEAD can hold still while the bytes are already the next commit's.
  const pinned = async <R>(
    roots: () => Named[],
    read: () => Promise<R>,
    accept: (out: R) => boolean = () => true,
  ): Promise<{ out: R; commits: Record<string, string | null> } | CallToolResult> => {
    for (let tries = 0; tries < 3; tries++) {
      const before = bankCommits(roots());
      const out = await read();
      const commits = bankCommits(roots());
      if (isDeepStrictEqual(before, commits) && accept(out)) return { out, commits };
    }
    return fail("the Bank moved during each of 3 reads; try again");
  };

  const withCommits = (body: object, commits: Record<string, string | null>, notes: string[]): Record<string, unknown> => ({
    ...body,
    bank_commits: commits,
    ...(notes.length > 0 ? { bank_notes: notes } : {}),
  });

  // A non-zero exit with empty stdout is a tool error. Anything else is data, including validate's exit 1 with findings on stdout.
  const jsonTool = async (argv: string[], at: string, roots: () => Named[], notes: string[]): Promise<CallToolResult> => {
    const read = await pinned(roots, async () => ({
      json: await cli([argv[0] as string, "--json", ...argv.slice(1)], at),
      human: await cli(argv, at),
    }));
    if ("content" in read) return read;
    const r = read.out.json;
    if (r.exitCode !== 0 && r.stdout === "") return fail(r.stderr.trimEnd());
    const parsed = JSON.parse(r.stdout) as unknown;
    const body = Array.isArray(parsed) ? { results: parsed } : (parsed as object);
    return { structuredContent: withCommits(body, read.commits, notes), content: [{ type: "text", text: read.out.human.stdout }] };
  };

  server.registerTool(
    "query",
    {
      description: "List Records by key=value filters, type, Facet, status, or text. Same rows as `ltm query --json`.",
      inputSchema: z.object({
        filters: z
          .record(z.string(), z.string())
          .optional()
          .describe("Frontmatter key=value filters; every pair must match."),
        type: z.string().optional().describe(schemaDesc("memory_type")),
        facets: z.array(z.string()).optional().describe(schemaDesc("applies_to")),
        status: z.array(z.string()).optional().describe(schemaDesc("status")),
        text: z.string().optional().describe("Free text to rank Records by."),
        all: z.boolean().optional().describe("Include Retired Records, whose status is superseded, deprecated, or rejected."),
        bank: bankInput,
      }),
    },
    async (input) => {
      const picked = await pick(input.bank);
      if ("error" in picked) return fail(picked.error);
      const bank = picked.root ?? (input.bank !== undefined && input.bank !== "" ? input.bank : undefined);
      // `=`-joined options and `--` before the filters, so an input starting with `-` can't be read as another flag (say, a second --bank).
      const argv = [
        "query",
        ...(bank === undefined ? [] : [`--bank=${bank}`]),
        ...(input.type === undefined ? [] : [`--type=${input.type}`]),
        ...(input.facets ?? []).map((f) => `--facet=${f}`),
        ...(input.status ?? []).map((s) => `--status=${s}`),
        ...(input.text === undefined ? [] : [`--text=${input.text}`]),
        ...(input.all === true ? ["--all"] : []),
        "--",
        ...Object.entries(input.filters ?? {}).map(([k, v]) => `${k}=${v}`),
      ];
      const roots = (): Named[] => {
        try {
          if (picked.root !== null) return [namedRoot(picked.root)];
          if (bank !== undefined) {
            const { name, root } = resolveBankFlag(bank, cwd, env);
            return [{ name, root }];
          }
          const here = findBank(cwd);
          return here !== null ? [namedRoot(here)] : resolveBanks(cwd, env).banks.map(({ name, root }) => ({ name, root }));
        } catch (e) {
          // pinned() reads the roots before the CLI runs, so a bad --bank has to fall through to run(), which owns that error message.
          if (!(e instanceof ConfigError)) throw e;
          return [];
        }
      };
      return jsonTool(argv, cwd, roots, picked.notes);
    },
  );

  const locate = async (
    tool: string,
    input: { id?: string; path?: string; bank?: string },
  ): Promise<({ root: string; realRoot: string; notes: string[] } & ({ id: string } | { rel: string })) | CallToolResult> => {
    if ((input.id === undefined) === (input.path === undefined)) return fail("give exactly one of id or path");
    const at = await pickRoot(tool, input.bank);
    if ("content" in at) return at;
    const { root, notes } = at;
    const realRoot = realpathSync(root);
    if (input.id !== undefined) return { root, realRoot, notes, id: input.id };
    // Realpath before the check, so neither `..` nor a symlink lets an agent read a file outside the Bank.
    const abs = resolve(realRoot, input.path as string);
    const target = existsSync(abs) ? realpathSync(abs) : abs;
    if (!isInside(realRoot, target)) return fail(`${input.path} is outside the Bank`);
    return { root, realRoot, notes, rel: relative(realRoot, target) };
  };

  // Called inside each pinned attempt: resolved before it, a refresh that moves the id would leave the attempt reading whatever Record took the old path.
  const relOf = (tool: string, root: string, id: string): string | CallToolResult => {
    let held: string[];
    try {
      held = listRecords(loadConfig(root), () => {}).filter((r) => r.frontmatter.id === id).map((r) => r.path);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      return fail(configErrorLine(tool, e).trimEnd());
    }
    if (held.length === 0) return fail(`'${id}' matches no Record`);
    if (held.length > 1) return fail(`'${id}' is held by ${held.length} Records`);
    return held[0] as string;
  };

  const frontmatterId = (text: string): unknown => {
    const split = splitFrontmatter(text);
    if (split === null) return undefined;
    try {
      return (parse(split.frontmatterLines.join("\n"), { logLevel: "error" }) as { id?: unknown } | null)?.id;
    } catch {
      return undefined;
    }
  };

  server.registerTool(
    "head",
    {
      description: "Print one Record's frontmatter block, fences included, found by id or by Bank-relative path.",
      inputSchema: z.object({
        id: z.string().optional().describe(schemaDesc("id")),
        path: z.string().optional().describe("Bank-relative path of the Record file."),
        bank: bankInput,
      }),
    },
    async (input) => {
      const at = await locate("head", input);
      if ("content" in at) return at;
      const { root, realRoot, notes } = at;
      const read = await pinned(() => [namedRoot(root)], async () => {
        const rel = "id" in at ? relOf("head", root, at.id) : at.rel;
        return typeof rel === "string" ? { rel, r: await cli(["head", "--", rel], realRoot) } : rel;
      }, (out) => !("id" in at) || "content" in out || out.r.stdout === "" || frontmatterId(out.r.stdout) === at.id);
      if ("content" in read) return read;
      if ("content" in read.out) return read.out;
      const { rel, r } = read.out;
      if (r.exitCode !== 0 && r.stdout === "") return fail(r.stderr.trimEnd());
      return { structuredContent: withCommits({ path: rel, head: r.stdout }, read.commits, notes), content: [{ type: "text", text: r.stdout }] };
    },
  );

  server.registerTool(
    "read",
    {
      description: "Print one Record file whole, frontmatter and body, found by id or by Bank-relative path.",
      inputSchema: z.object({
        id: z.string().optional().describe(schemaDesc("id")),
        path: z.string().optional().describe("Bank-relative path of the Record file."),
        bank: bankInput,
      }),
    },
    async (input) => {
      const at = await locate("read", input);
      if ("content" in at) return at;
      const { root, realRoot, notes } = at;
      // head can pass any in-Bank path because `ltm head` prints only the frontmatter block. readFileSync prints any file whole, and a bank_url clone's .git/config can hold a remote URL with credentials, so read serves only the paths listRecords returns.
      // A refresh can swap the file or a parent dir for a symlink after locate's realpath check. So each pinned attempt rechecks listRecords and confirms the open fd is still the in-Bank file.
      const read = await pinned(() => [namedRoot(root)], async (): Promise<{ rel: string; text: string } | CallToolResult> => {
        let rel: string;
        const notRecord = (): CallToolResult => fail(`${input.path ?? rel} is not a Record in the Bank`);
        if ("id" in at) {
          // relOf's path came from this attempt's listRecords, so it is a Record by construction.
          const got = relOf("read", root, at.id);
          if (typeof got !== "string") return got;
          rel = got;
        } else {
          rel = at.rel;
          let records: string[];
          try {
            records = listRecords(loadConfig(root), () => {}).map((r) => r.path);
          } catch (e) {
            if (!(e instanceof ConfigError)) throw e;
            return fail(configErrorLine("read", e).trimEnd());
          }
          if (!records.includes(rel)) return notRecord();
        }
        const abs = join(realRoot, rel);
        let fd: number;
        try {
          fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (e) {
          if (["ELOOP", "ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return notRecord();
          throw e;
        }
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile()) return notRecord();
          // O_NOFOLLOW checks only the last path component. If a parent dir was a symlink at open time, the fd's inode won't match the inode at the canonical path.
          let here;
          try {
            if (realpathSync(abs) !== abs) return notRecord();
            here = lstatSync(abs);
          } catch {
            return notRecord();
          }
          if (here.dev !== opened.dev || here.ino !== opened.ino) return notRecord();
          return { rel, text: readFileSync(fd, "utf8") };
        } finally {
          closeSync(fd);
        }
      }, (out) => !("id" in at) || "content" in out || frontmatterId(out.text) === at.id);
      if ("content" in read) return read;
      if ("content" in read.out) return read.out;
      const { rel, text } = read.out;
      return { structuredContent: withCommits({ path: rel, text }, read.commits, notes), content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "facets",
    {
      description: "List every Facet in applies_to with its Record count. Same rows as `ltm facets --json`.",
      inputSchema: z.object({
        all: z.boolean().optional().describe("Count Retired Records too, whose status is superseded, deprecated, or rejected."),
        bank: bankInput,
      }),
    },
    async (input) => {
      const at = await pickRoot("facets", input.bank);
      if ("content" in at) return at;
      const { root, notes } = at;
      return jsonTool(["facets", ...(input.all === true ? ["--all"] : [])], root, () => [namedRoot(root)], notes);
    },
  );

  server.registerTool(
    "validate",
    {
      description: "Check memory-bank.yaml and each Record against the schemas and Bank rules. Same findings as `ltm validate --json`.",
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .optional()
          .describe("Bank-relative Record paths to check; every Record when left out."),
        bank: bankInput,
      }),
    },
    async (input) => {
      const at = await pickRoot("validate", input.bank);
      if ("content" in at) return at;
      const { root, notes } = at;
      return jsonTool(["validate", "--", ...(input.paths ?? [])], root, () => [namedRoot(root)], notes);
    },
  );

  server.registerTool(
    "propose",
    {
      description:
        "Open a Proposal on a new ltm/propose branch of the Bank's origin, or promote a repo ADR or decision-log entry with `from`. Same result as `ltm propose --json` or `ltm promote --json`.",
      inputSchema: z.object({
        type: z.string().describe(schemaDesc("memory_type")),
        title: z.string().optional().describe(`${schemaDesc("title")} Required unless from is set, which takes the source's heading.`),
        summary: z.string().optional().describe(schemaDesc("summary")),
        body: z.string().optional().describe("Markdown body under the frontmatter; the memory type's template when left out."),
        applies_to: z.array(z.string()).optional().describe(schemaDesc("applies_to")),
        owners: z.array(z.string()).optional().describe(schemaDesc("owners")),
        tags: z.array(z.string()).optional().describe(schemaDesc("tags")),
        related: z.array(z.string()).optional().describe(schemaDesc("related")),
        supersedes: z.array(z.string()).optional().describe(schemaDesc("supersedes")),
        source_refs: z.array(z.string()).optional().describe(schemaDesc("source_refs")),
        from: z
          .string()
          .optional()
          .describe("Repo path of an ADR or decision log to promote, relative to the server's cwd. Allows only type, title, summary, applies_to, and entry."),
        entry: z.string().optional().describe("Heading of the decision-log entry to promote; needs from."),
        bank: bankInput,
      }),
    },
    async (input) => {
      // Checked before pick, so a refused combination never clones, fetches, or pushes.
      if (input.from !== undefined) {
        const extra = (["body", "owners", "tags", "related", "supersedes", "source_refs"] as const).filter((k) => input[k] !== undefined);
        if (extra.length > 0) return fail(`from can't be combined with ${extra.join(", ")}`);
      } else if (input.entry !== undefined) {
        return fail("entry needs from");
      } else if (input.title === undefined) {
        return fail("title is required unless from is set");
      }
      const at = await pickRoot("propose", input.bank);
      if ("content" in at) return at;
      const { root, notes } = at;

      const common = [
        `--type=${input.type}`,
        ...(input.title === undefined ? [] : [`--title=${input.title}`]),
        ...(input.summary === undefined ? [] : [`--summary=${input.summary}`]),
        ...(input.applies_to ?? []).map((f) => `--applies-to=${f}`),
      ];
      let dir: string | undefined;
      try {
        let r;
        if (input.from !== undefined) {
          // promote reads the repo identity from its cwd, so it runs in the caller's repo, not the Bank.
          const entry = input.entry === undefined ? [] : [`--entry=${input.entry}`];
          r = await cli(["promote", "--json", `--bank=${root}`, ...common, ...entry, "--", input.from], cwd);
        } else {
          const lists = (["owners", "tags", "related", "supersedes"] as const).flatMap((k) => (input[k] ?? []).map((v) => `--${k}=${v}`));
          const refs = (input.source_refs ?? []).map((v) => `--source-ref=${v}`);
          let bodyFile: string[] = [];
          if (input.body !== undefined) {
            dir = mkdtempSync(join(tmpdir(), "ltm-mcp-body-"));
            writeFileSync(join(dir, "body.md"), input.body);
            bodyFile = [`--body-file=${join(dir, "body.md")}`];
          }
          r = await cli(["propose", "--json", ...common, ...lists, ...refs, ...bodyFile], root);
        }
        if (r.exitCode !== 0 && r.stdout === "") return fail(r.stderr.trimEnd());
        // Runs once: a second, human-output run would push a second branch.
        const structuredContent = withCommits(JSON.parse(r.stdout) as object, bankCommits([namedRoot(root)]), notes);
        return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] };
      } finally {
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  return server;
}
