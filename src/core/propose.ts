import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { ConfigError, loadConfig, type BankConfig, type MemoryType } from "./bank.ts";
import { canonicalFrontmatter, SCHEMA_KEY_ORDER } from "./canonical.ts";
import { newId } from "./fmt.ts";
import { chooseAdapter, fallbackUrl, forgeRemote, type ForgeAdapter } from "./forge.ts";
import { listRecordFiles } from "./query.ts";
import { parseRecordFile, RecordError } from "./record.ts";
import type { Env } from "./resolve.ts";
import { firstLine } from "./text.ts";
import { checkRecordText, validateBank, type Finding } from "./validate.ts";

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
  // `<org>/<repo>:<path>`, plus `#<entry-slug>` for a decision-log entry. Set by ltm promote (#14).
  promoted_from?: string;
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
export const SPLIT_ORIGIN = "origin pushes somewhere other than it fetches from; ltm propose can't open a review across repositories";

// A token in an HTTPS remote ends up in terminal and CI logs if printed as is. The user in scp-form git@host:path is a login name, not a secret, so it stays.
export function redactRemote(text: string): string {
  // Userinfo runs to the last @ before the first /. Git stores the config string raw, so a ? or # in a token is still userinfo.
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1");
}

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

// Ids are checked against the caller's Bank and, once fetched, the default branch's. Other branches aren't checked. A file that won't parse can't claim an id, and `ltm validate` reports it on its own.
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
  if (input.promoted_from !== undefined) data.promoted_from = input.promoted_from;
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

// Git strips credentials from most of its own messages. A refusal echoes git's stderr, so redact it again here in case some git version doesn't.
function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.error) throw new GitError(redactRemote(`git ${args[0]}: ${firstLine(r.error.message)}`));
  if (r.status !== 0) throw new GitError(redactRemote(`git ${args[0]}: ${firstLine(r.stderr.trim()) || `exited ${r.status}`}`));
  return r.stdout;
}

// For the lookups whose failure has a meaning of its own (no origin, no origin/HEAD), not an error.
function gitMaybe(dir: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Ask the remote first: origin/HEAD goes stale when the remote switches default branches and keeps the old one, and git init plus git remote add leaves none at all. ls-remote writes no ref locally.
function remoteDefaultBranch(root: string): string {
  const remote = gitMaybe(root, ["ls-remote", "--symref", "origin", "HEAD"]);
  const m = remote?.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m);
  if (m?.[1]) return m[1];
  const local = gitMaybe(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])?.replace(/^refs\/remotes\/origin\//, "");
  return local || "main";
}

// The worktree holds whatever origin's default branch committed, and writeFileSync follows a symlink there to anywhere on disk before git add gets a chance to refuse the path. A missing component ends the walk, because mkdir only makes plain dirs.
function destinationRefusal(tmp: string, inTree: string, base: string): string | null {
  const segs = inTree.split("/");
  for (let i = 0; i < segs.length; i++) {
    const rel = segs.slice(0, i + 1).join("/");
    let st;
    try {
      st = lstatSync(join(tmp, rel));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    if (st.isSymbolicLink()) return `${rel} on ${base} is a symlink; ltm propose won't write through it`;
    if (i === segs.length - 1) return `${rel} already exists on ${base}`;
    if (!st.isDirectory()) return `${rel} on ${base} is not a directory`;
  }
  return null;
}

const facetPrefixesOf = (config: BankConfig): string[] | null => {
  const facets = config.raw.facet_prefixes;
  return Array.isArray(facets) && facets.every((x) => typeof x === "string") ? (facets as string[]) : null;
};

const CONFIG_FILE = "memory-bank.yaml";

// A dry run never writes into the caller's Bank, so the Bank-level rules run on a copy of its config and type folders with the Proposal added.
function checkInLocalCopy(config: BankConfig, path: string, text: string): Finding[] {
  const copy = mkdtempSync(join(tmpdir(), "ltm-propose-check-"));
  try {
    cpSync(join(config.root, CONFIG_FILE), join(copy, CONFIG_FILE));
    for (const folder of new Set(Object.values(config.folders))) {
      const from = join(config.root, folder);
      if (existsSync(from)) cpSync(from, join(copy, folder), { recursive: true, verbatimSymlinks: true });
    }
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    writeFileSync(join(copy, path), text);
    return validateBank(copy, [path], copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

export async function proposeRecord(input: ProposalInput, deps: ProposeDeps): Promise<ProposeResult> {
  const { config } = deps;
  const built = buildRecord(input, config, deps.today);
  if ("refusal" in built) return built;
  const { id, text } = built;
  let path = built.path;

  // validateBank repeats checkRecordText's per-file findings, so each warning goes out once however many checks report it.
  const warned = new Set<string>();
  const refusalOf = (findings: Finding[]): ProposeRefusal | null => {
    const errors = findings.filter((f) => f.severity === "error");
    if (errors.length > 0) return { refusal: errors.map(formatFinding).join("\n") };
    for (const line of findings.map(formatFinding)) {
      if (warned.has(line)) continue;
      warned.add(line);
      deps.onWarning?.(line);
    }
    return null;
  };

  const own = refusalOf(checkRecordText(path, input.type, text, facetPrefixesOf(config), config.folders[input.type]).findings);
  if (own) return own;

  if (deps.dryRun) return refusalOf(checkInLocalCopy(config, path, text)) ?? { dryRun: true, id, path, text };

  const root = config.root;
  const remoteUrl = gitMaybe(root, ["config", "--get", "remote.origin.url"]);
  if (!remoteUrl) return { refusal: NO_ORIGIN };

  const branch = proposalBranch(id);
  let base: string;
  let tmp: string | null = null;
  let forgeUrl = remoteUrl;
  try {
    // The adapter and the fallback link name the fetch URL's repository, so a branch pushed anywhere else would be a review of a branch that isn't there. Both lookups apply insteadOf, so a rewrite alone doesn't count as a split.
    const fetchUrl = git(root, ["remote", "get-url", "origin"]).trim();
    const pushUrls = git(root, ["remote", "get-url", "--push", "--all", "origin"]).trim().split("\n");
    if (pushUrls.length !== 1 || pushUrls[0] !== fetchUrl) return { refusal: SPLIT_ORIGIN };
    forgeUrl = forgeRemote(remoteUrl, fetchUrl);
    base = remoteDefaultBranch(root);
    // An empty --refmap writes only FETCH_HEAD, so no ref under refs/ moves in the caller's repo.
    git(root, ["fetch", "--quiet", "--refmap=", "origin", `refs/heads/${base}`]);
    // Realpath both sides: on macOS tmpdir() is /var/... while git reports /private/var/..., and relative() across the two climbs out of the repo.
    const top = realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim());
    const bankInRepo = relative(top, realpathSync(root));
    tmp = mkdtempSync(join(tmpdir(), "ltm-propose-"));
    // Detached, so the caller's repo gains no branch and its checkout is never touched.
    git(root, ["worktree", "add", "--quiet", "--detach", tmp, "FETCH_HEAD"]);
    // The caller's checkout can be behind origin, and a folder remapped there would put the file where that branch's validate and queries never look. The commit carries the fetched config, so path and checks follow it.
    const bankDir = bankInRepo === "" ? tmp : join(tmp, bankInRepo);
    const fetched = loadConfig(bankDir);
    path = posix.join(fetched.folders[input.type], posix.basename(path));
    const recheck = checkRecordText(path, input.type, text, facetPrefixesOf(fetched), fetched.folders[input.type]);
    const recheckErrors = recheck.findings.filter((f) => f.severity === "error");
    if (recheckErrors.length > 0) return { refusal: recheckErrors.map(formatFinding).join("\n") };
    if (takenIds(fetched).has(id)) return { refusal: `id ${id} is already used by a Record on ${base}; run ltm propose again` };
    const inTree = bankInRepo === "" ? path : join(bankInRepo, path).split(sep).join("/");
    const refused = destinationRefusal(tmp, inTree, base);
    if (refused) return { refusal: refused };
    const abs = join(tmp, inTree);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    // checkRecordText sees one file, so rules that span Records, like supersession-facets, only show up once the file sits in the fetched Bank. Naming the file keeps errors already on the default branch from blocking every Proposal.
    const inBank = refusalOf(validateBank(bankDir, [path], bankDir));
    if (inBank) return inBank;
    git(tmp, ["add", "--", inTree]);
    git(tmp, ["commit", "--quiet", "-m", `Propose ${input.type}: ${input.title}`]);
    const sha = git(tmp, ["rev-parse", "HEAD"]).trim();
    // A URL rather than the remote name, so a relative URL like ../bank.git resolves as written. Push from root, never tmp, because git resolves that URL against the -C dir. The worktree shares root's object store, so root already has the commit.
    const pushUrl = git(root, ["remote", "get-url", "--push", "origin"]).trim();
    // git 2.56 records a push by URL as refs/remotes/origin/<branch>; older git doesn't. Delete only a ref the push made, never one the caller already had.
    const trackingRef = `refs/remotes/origin/${branch}`;
    const hadTrackingRef = gitMaybe(root, ["rev-parse", "--verify", "--quiet", trackingRef]) !== null;
    git(root, ["push", "--quiet", pushUrl, `${sha}:refs/heads/${branch}`]);
    // Best effort, like cleanup(): a failed delete must not hide a successful push.
    if (!hadTrackingRef) gitMaybe(root, ["update-ref", "-d", trackingRef]);
  } catch (e) {
    if (e instanceof ConfigError) return { refusal: `the fetched default branch has no usable Bank config: ${firstLine(e.message)}` };
    if (!(e instanceof GitError)) throw e;
    return { refusal: e.message };
  } finally {
    if (tmp) cleanup(root, tmp);
  }

  const forge = deps.forge ?? chooseAdapter(forgeUrl, deps.env);
  const summary = input.summary === undefined ? [] : [`Summary: ${input.summary}`];
  const body = [`Title: ${input.title}`, `Type: ${input.type}`, ...summary, `Path: ${path}`].join("\n") + "\n";
  try {
    const { url } = await forge.openChangeRequest({ remoteUrl: forgeUrl, base, head: branch, title: `Propose ${input.type}: ${input.title}`, body });
    // Callers print this field. The adapter has already had the raw URL, so only the copy handed back loses its userinfo.
    return { dryRun: false, id, path, text, branch, url, adapter: forge.name, remoteUrl: redactRemote(remoteUrl) };
  } catch (e) {
    // The branch is already on origin, so the fallback link still gets a person to the review.
    const message = redactRemote(firstLine(e instanceof Error ? e.message : String(e)));
    const url = fallbackUrl(forgeUrl, base, branch);
    return { refusal: `pushed ${branch}, but opening the review failed: ${message}`, ...(url ? { url } : {}) };
  }
}

// Best effort: a cleanup failure must not hide the push result, and prune drops the worktree's admin entry if remove couldn't.
function cleanup(root: string, tmp: string): void {
  gitMaybe(root, ["worktree", "remove", "--force", tmp]);
  rmSync(tmp, { recursive: true, force: true });
  gitMaybe(root, ["worktree", "prune"]);
}
