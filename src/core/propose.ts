import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import type { BankConfig, MemoryType } from "./bank.ts";
import { canonicalFrontmatter, SCHEMA_KEY_ORDER } from "./canonical.ts";
import { newId } from "./fmt.ts";
import { chooseAdapter, fallbackUrl, type ForgeAdapter } from "./forge.ts";
import { listRecordFiles } from "./query.ts";
import { parseRecordFile, RecordError } from "./record.ts";
import type { Env } from "./resolve.ts";
import { firstLine } from "./text.ts";
import { checkRecordText, type Finding } from "./validate.ts";

export type ProposalInput = {
  type: MemoryType;
  title: string;
  summary?: string;
  applies_to?: string[];
  owners?: string[];
  tags?: string[];
  related?: string[];
  supersedes?: string[];
  source_refs?: string[];
  // Written verbatim after the closing fence. Omitted means the type's template.
  body?: string;
};

export type ProposeDeps = {
  config: BankConfig;
  today: string;
  env: Env;
  forge?: ForgeAdapter;
  dryRun?: boolean;
  onWarning?: (line: string) => void;
};

// `refusal` may hold several lines (one per error finding), none carrying the `ltm propose: ` prefix. `url` is set only when the branch was pushed but the adapter failed and the remote has a fallback review URL.
export type ProposeRefusal = { refusal: string; url?: string };
export type ProposeDryRun = { dryRun: true; id: string; path: string; text: string };
export type Proposed = {
  dryRun: false;
  id: string;
  path: string;
  text: string;
  branch: string;
  url: string | null;
  adapter: ForgeAdapter["name"];
  remoteUrl: string;
};
export type ProposeResult = ProposeRefusal | ProposeDryRun | Proposed;

export const NO_ORIGIN = "no origin remote; ltm propose pushes a branch there for review";

const TEMPLATES: Record<MemoryType, string[]> = {
  Decision: ["Context", "Decision", "Consequences"],
  PolicyRule: ["Context", "Policy Rule"],
  Exception: ["Context", "Exception"],
  // The heading named for the type is `Context` itself, so it would only repeat.
  Context: ["Context"],
};

// Starts with "\n" so a blank line separates the closing fence from the first heading, as every demo Record has it.
export function templateBody(type: MemoryType): string {
  return "\n" + TEMPLATES[type].map((h) => `## ${h}\n`).join("\n");
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug || "record";
}

export const proposalBranch = (id: string): string => `ltm/propose/${id}`;

export function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}: ${f.severity} ${f.rule}: ${f.key ?? "-"}: ${f.message}`;
}

// The caller's Bank is the only id space checked. A file that won't parse can't claim an id, and `ltm validate` reports it on its own.
function takenIds(config: BankConfig): Set<string> {
  const taken = new Set<string>();
  for (const { abs, rel, type } of listRecordFiles(config, () => {})) {
    try {
      const id = parseRecordFile(abs, rel, type).frontmatter.id;
      if (typeof id === "string") taken.add(id);
    } catch (e) {
      if (!(e instanceof RecordError)) throw e;
    }
  }
  return taken;
}

const LIST_FIELDS = ["applies_to", "owners", "tags", "related", "supersedes", "source_refs"] as const;
export type ListField = (typeof LIST_FIELDS)[number];

function buildRecord(input: ProposalInput, config: BankConfig, today: string): { id: string; path: string; text: string } | ProposeRefusal {
  const id = newId(takenIds(config));
  const data: Record<string, unknown> = { schema: 1, id, memory_type: input.type, title: input.title, status: "proposed", date: today };
  if (input.summary !== undefined) data.summary = input.summary;
  for (const key of LIST_FIELDS) {
    const v = input[key];
    if (v && v.length > 0) data[key] = v;
  }
  const fm = canonicalFrontmatter(data, SCHEMA_KEY_ORDER, "\n");
  if (typeof fm !== "string") return { refusal: fm.reason };
  const text = `---\n${fm}---\n${input.body ?? templateBody(input.type)}`;
  const path = posix.join(config.folders[input.type], `${slugify(input.title)}-${id}.md`);
  return { id, path, text };
}

class GitError extends Error {}

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.error) throw new GitError(`git ${args[0]}: ${firstLine(r.error.message)}`);
  if (r.status !== 0) throw new GitError(`git ${args[0]}: ${firstLine(r.stderr.trim()) || `exited ${r.status}`}`);
  return r.stdout;
}

// For the lookups whose failure has a meaning of its own (no origin, no origin/HEAD), not an error.
function gitMaybe(dir: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function proposeRecord(input: ProposalInput, deps: ProposeDeps): Promise<ProposeResult> {
  const { config } = deps;
  const built = buildRecord(input, config, deps.today);
  if ("refusal" in built) return built;
  const { id, path, text } = built;

  const facets = config.raw.facet_prefixes;
  const prefixes = Array.isArray(facets) && facets.every((x) => typeof x === "string") ? (facets as string[]) : null;
  const { findings } = checkRecordText(path, input.type, text, prefixes, config.folders[input.type]);
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length > 0) return { refusal: errors.map(formatFinding).join("\n") };
  for (const f of findings) deps.onWarning?.(formatFinding(f));

  if (deps.dryRun) return { dryRun: true, id, path, text };

  const root = config.root;
  const remoteUrl = gitMaybe(root, ["config", "--get", "remote.origin.url"]);
  if (!remoteUrl) return { refusal: NO_ORIGIN };

  const branch = proposalBranch(id);
  let base: string;
  let tmp: string | null = null;
  try {
    base = gitMaybe(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])?.replace(/^refs\/remotes\/origin\//, "") || "main";
    // An empty --refmap writes only FETCH_HEAD, so no ref under refs/ moves in the caller's repo.
    git(root, ["fetch", "--quiet", "--refmap=", "origin", `refs/heads/${base}`]);
    // Realpath both sides: on macOS tmpdir() is /var/... while git reports /private/var/..., and relative() across the two climbs out of the repo.
    const top = realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim());
    const bankInRepo = relative(top, realpathSync(root));
    tmp = mkdtempSync(join(tmpdir(), "ltm-propose-"));
    // Detached, so the caller's repo gains no branch and its checkout is never touched.
    git(root, ["worktree", "add", "--quiet", "--detach", tmp, "FETCH_HEAD"]);
    const inTree = bankInRepo === "" ? path : join(bankInRepo, path).split(sep).join("/");
    const abs = join(tmp, inTree);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    git(tmp, ["add", "--", inTree]);
    git(tmp, ["commit", "--quiet", "-m", `Propose ${input.type}: ${input.title}`]);
    const sha = git(tmp, ["rev-parse", "HEAD"]).trim();
    // A URL rather than the remote name, so git adds no remote-tracking ref in the caller's repo. Push from root, never tmp, because git resolves a relative URL like ../bank.git against the -C dir. The worktree shares root's object store, so root already has the commit.
    const pushUrl = git(root, ["remote", "get-url", "--push", "origin"]).trim();
    git(root, ["push", "--quiet", pushUrl, `${sha}:refs/heads/${branch}`]);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    return { refusal: e.message };
  } finally {
    if (tmp) cleanup(root, tmp);
  }

  const forge = deps.forge ?? chooseAdapter(remoteUrl, deps.env);
  const summary = input.summary === undefined ? [] : [`Summary: ${input.summary}`];
  const body = [`Title: ${input.title}`, `Type: ${input.type}`, ...summary, `Path: ${path}`].join("\n") + "\n";
  try {
    const { url } = await forge.openChangeRequest({ remoteUrl, base, head: branch, title: `Propose ${input.type}: ${input.title}`, body });
    return { dryRun: false, id, path, text, branch, url, adapter: forge.name, remoteUrl };
  } catch (e) {
    // The branch is already on origin, so the fallback link still gets a person to the review.
    const message = firstLine(e instanceof Error ? e.message : String(e));
    const url = fallbackUrl(remoteUrl, base, branch);
    return { refusal: `pushed ${branch}, but opening the review failed: ${message}`, ...(url ? { url } : {}) };
  }
}

// Best effort: a cleanup failure must not hide the push result, and prune drops the worktree's admin entry if remove couldn't.
function cleanup(root: string, tmp: string): void {
  gitMaybe(root, ["worktree", "remove", "--force", tmp]);
  rmSync(tmp, { recursive: true, force: true });
  gitMaybe(root, ["worktree", "prune"]);
}
