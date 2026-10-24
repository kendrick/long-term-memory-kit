import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { run } from "../../src/cli/run.ts";
import { loadConfig } from "../../src/core/bank.ts";
import type { ChangeRequest, ForgeAdapter } from "../../src/core/forge.ts";
import { proposeRecord, redactRemote, slugify, templateBody, type ProposalInput, type ProposeResult } from "../../src/core/propose.ts";
import { listRecords } from "../../src/core/query.ts";
import { splitFrontmatter } from "../../src/core/record.ts";
import { checkRecordText } from "../../src/core/validate.ts";
import { git, snapshot, withGitBank } from "../helpers/git-bank.ts";

// Each test spawns many git processes; bun's 5s default flakes under load.
const GIT_TEST_TIMEOUT = 30_000;
const TODAY = "2026-10-09";
const INPUT: ProposalInput = { type: "Decision", title: "Use Postgres for new services", summary: "New services store relational data in Postgres." };

function fakeAdapter(url: string | null = "https://example.invalid/pr/1"): ForgeAdapter & { calls: ChangeRequest[] } {
  const calls: ChangeRequest[] = [];
  return {
    name: "github",
    calls,
    async openChangeRequest(req) {
      calls.push(req);
      return { url };
    },
  };
}

function propose(clone: string, forge: ForgeAdapter, input: ProposalInput = INPUT, dryRun = false): Promise<ProposeResult> {
  return proposeRecord(input, { config: loadConfig(clone), today: TODAY, env: {}, forge, dryRun });
}

function proposed(r: ProposeResult) {
  if ("refusal" in r) throw new Error(`refused: ${r.refusal}`);
  if (r.dryRun) throw new Error("expected a real run, got a dry run");
  return r;
}

describe("withGitBank", () => {
  test("each scratch dir is its own repository, outside this checkout", async () => {
    await withGitBank(async ({ bare, clone }) => {
      expect(git(clone, "rev-parse", "--git-dir").trim()).toBe(".git");
      expect(git(bare, "rev-parse", "--git-dir").trim()).toBe(".");
      expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    });
  }, GIT_TEST_TIMEOUT);
});

describe("proposeRecord", () => {
  test("changes exactly one ref anywhere: the new branch on origin", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const before = snapshot(bare, clone);
      const r = proposed(await propose(clone, fakeAdapter()));
      const after = snapshot(bare, clone);

      // The clone's refs, HEAD, status, and worktree list must be byte-identical: a commit in the caller's checkout moves HEAD and fails here.
      expect({ ...after, bareRefs: "" }).toEqual({ ...before, bareRefs: "" });
      const lines = (s: string) => s.split("\n").filter((l) => l !== "");
      const added = lines(after.bareRefs).filter((l) => !lines(before.bareRefs).includes(l));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(new RegExp(`^[0-9a-f]{40} commit\trefs/heads/ltm/propose/${r.id}$`));
      expect(lines(after.bareRefs).filter((l) => l !== added[0])).toEqual(lines(before.bareRefs));
    });
  }, GIT_TEST_TIMEOUT);

  test("a relative origin URL still pushes, and still changes only the new branch on origin", async () => {
    await withGitBank(async ({ bare, clone }) => {
      // Git resolves a relative URL against the -C dir. The scratch worktree is a mkdtemp sibling of the clone, so a ../ URL resolves the same from both and misses the bug. A URL through the clone's own .git dir resolves only from the clone, like ../bank.git in a real checkout.
      symlinkSync(bare, join(clone, ".git", "origin.git"));
      const rel = ".git/origin.git";
      git(clone, "config", "remote.origin.url", rel);
      expect(git(clone, "config", "--get", "remote.origin.url").trim()).toBe(rel);
      expect(realpathSync(join(clone, rel))).toBe(realpathSync(bare));

      const before = snapshot(bare, clone);
      const r = proposed(await propose(clone, fakeAdapter()));
      const after = snapshot(bare, clone);

      expect({ ...after, bareRefs: "" }).toEqual({ ...before, bareRefs: "" });
      const lines = (s: string) => s.split("\n").filter((l) => l !== "");
      const added = lines(after.bareRefs).filter((l) => !lines(before.bareRefs).includes(l));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(new RegExp(`^[0-9a-f]{40} commit\trefs/heads/ltm/propose/${r.id}$`));
      expect(lines(after.bareRefs).filter((l) => l !== added[0])).toEqual(lines(before.bareRefs));
      expect(git(bare, "diff-tree", "--no-commit-id", "--name-status", "-r", r.branch)).toBe(`A\t${r.path}\n`);
    });
  }, GIT_TEST_TIMEOUT);

  test("the pushed branch's one commit adds one valid proposed Record with a fresh id", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const r = proposed(await propose(clone, fakeAdapter()));
      expect(r.branch).toBe(`ltm/propose/${r.id}`);
      expect(r.path).toBe(`_memory/decisions/use-postgres-for-new-services-${r.id}.md`);

      expect(git(bare, "rev-list", "--count", `main..${r.branch}`).trim()).toBe("1");
      expect(git(bare, "rev-parse", `${r.branch}^`).trim()).toBe(git(bare, "rev-parse", "main").trim());
      expect(git(bare, "diff-tree", "--no-commit-id", "--name-status", "-r", r.branch)).toBe(`A\t${r.path}\n`);

      const fresh = mkdtempSync(join(tmpdir(), "ltm-fresh-"));
      try {
        git(fresh, "clone", "--quiet", "--branch", r.branch, bare, ".");
        const validated = await run({ argv: ["validate"], cwd: fresh, env: {} });
        expect(validated.stdout + validated.stderr).toBe("");
        expect(validated.exitCode).toBe(0);

        const text = readFileSync(join(fresh, r.path), "utf8");
        expect(text).toBe(r.text);
        const fm = parse(splitFrontmatter(text)!.frontmatterLines.join("\n")) as Record<string, unknown>;
        expect(fm.status).toBe("proposed");
        expect(fm.date).toBe(TODAY);
        expect(fm.id).toBe(r.id);
        const others = listRecords(loadConfig(fresh), () => {}).filter((rec) => rec.path !== r.path);
        expect(others.length).toBeGreaterThan(0);
        expect(others.map((rec) => rec.frontmatter.id)).not.toContain(r.id);
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  }, GIT_TEST_TIMEOUT);

  test("the adapter gets one call from the new branch to the default branch", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const forge = fakeAdapter("https://example.invalid/pr/7");
      const r = proposed(await propose(clone, forge));
      expect(forge.calls).toHaveLength(1);
      expect(forge.calls[0]).toEqual({
        remoteUrl: bare,
        base: "main",
        head: `ltm/propose/${r.id}`,
        title: "Propose Decision: Use Postgres for new services",
        body: `Title: Use Postgres for new services\nType: Decision\nSummary: New services store relational data in Postgres.\nPath: ${r.path}\n`,
      });
      expect(r.url).toBe("https://example.invalid/pr/7");
      expect(r.adapter).toBe("github");
    });
  }, GIT_TEST_TIMEOUT);

  test("an empty title is refused before any git work", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const forge = fakeAdapter();
      const before = snapshot(bare, clone);
      const r = await propose(clone, forge, { ...INPUT, title: "" });
      expect("refusal" in r && r.refusal).toMatch(/^_memory\/decisions\/record-[A-Za-z0-9_-]{10}\.md:\d+: error schema: title: /);
      expect(forge.calls).toHaveLength(0);
      expect(snapshot(bare, clone)).toEqual(before);
    });
  }, GIT_TEST_TIMEOUT);

  test("promoted_from reaches the Proposal's frontmatter", async () => {
    await withGitBank(async ({ clone }) => {
      const from = "acme/order-service:_working-memory/decisionLog.md#cap-retries-at-three-per-request";
      const r = await propose(clone, fakeAdapter(), { ...INPUT, promoted_from: from }, true);
      if ("refusal" in r || !r.dryRun) throw new Error("expected a dry run");
      expect(parse(splitFrontmatter(r.text)!.frontmatterLines.join("\n")).promoted_from).toBe(from);
    });
  }, GIT_TEST_TIMEOUT);

  test("a dry run returns a valid Record and touches no repo", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const forge = fakeAdapter();
      const before = snapshot(bare, clone);
      const r = await propose(clone, forge, INPUT, true);
      if ("refusal" in r || !r.dryRun) throw new Error("expected a dry run");
      expect(r.text.endsWith(`---\n${templateBody("Decision")}`)).toBe(true);
      const config = loadConfig(clone);
      const { findings } = checkRecordText(r.path, "Decision", r.text, config.raw.facet_prefixes as string[], config.folders.Decision);
      expect(findings).toEqual([]);
      expect(forge.calls).toHaveLength(0);
      expect(snapshot(bare, clone)).toEqual(before);
    });
  }, GIT_TEST_TIMEOUT);

  test.each([
    ["a target that shares no Facet", ["hT5cY8dUa6"], /error supersession-facets: applies_to: /],
    ["a target no Record has", ["NoSuchId00"], /error supersession-missing-target: supersedes: /],
  ])("a dry run that supersedes %s is refused and touches no repo", async (_label, supersedes, refusal) => {
    await withGitBank(async ({ bare, clone }) => {
      const forge = fakeAdapter();
      const before = snapshot(bare, clone);
      const r = await propose(clone, forge, { ...INPUT, supersedes, applies_to: ["domain:payments"] }, true);
      expect("refusal" in r && r.refusal).toMatch(refusal);
      expect(forge.calls).toHaveLength(0);
      expect(snapshot(bare, clone)).toEqual(before);
    });
  }, GIT_TEST_TIMEOUT);

  test("a Bank-level warning reaches onWarning once and the proposal still goes out", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const warnings: string[] = [];
      const forge = fakeAdapter();
      const input: ProposalInput = { ...INPUT, applies_to: ["service:order-service"] };
      const r = await proposeRecord(input, { config: loadConfig(clone), today: TODAY, env: {}, forge, onWarning: (w) => warnings.push(w) });
      const p = proposed(r);
      expect(warnings.filter((w) => w.includes("warning bright-line"))).toHaveLength(1);
      expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/")).toBe(`refs/heads/${p.branch}\n`);
    });
  }, GIT_TEST_TIMEOUT);

  test("no origin is refused and nothing is written", async () => {
    await withGitBank(async ({ bare, clone }) => {
      git(clone, "remote", "remove", "origin");
      const forge = fakeAdapter();
      const before = snapshot(bare, clone);
      const r = await propose(clone, forge);
      expect(r).toEqual({ refusal: "no origin remote; ltm propose pushes a branch there for review" });
      expect(forge.calls).toHaveLength(0);
      expect(snapshot(bare, clone)).toEqual(before);
    });
  }, GIT_TEST_TIMEOUT);

  test("an adapter that throws leaves the branch pushed and says so", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const before = snapshot(bare, clone);
      const forge: ForgeAdapter = {
        name: "github",
        async openChangeRequest() {
          throw new Error("HTTP 502");
        },
      };
      const r = await propose(clone, forge);
      if (!("refusal" in r)) throw new Error("expected a refusal");
      const id = /ltm\/propose\/([A-Za-z0-9_-]{10})/.exec(r.refusal)?.[1];
      expect(r).toEqual({ refusal: `pushed ltm/propose/${id}, but opening the review failed: HTTP 502` });
      expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/")).toBe(`refs/heads/ltm/propose/${id}\n`);
      expect(snapshot(bare, clone).worktrees).toBe(before.worktrees);
    });
  }, GIT_TEST_TIMEOUT);

  test("an adapter failure on a forge remote also carries the fallback review URL", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const gitlab = "https://gitlab.example.com/acme/bank.git";
      git(clone, "config", "remote.origin.url", gitlab);
      // Fetch and push still reach the bare repo, while the configured URL names a GitLab host.
      git(clone, "config", `url.${bare}.insteadOf`, gitlab);
      const forge: ForgeAdapter = {
        name: "fallback",
        async openChangeRequest() {
          throw new Error("boom");
        },
      };
      const r = await propose(clone, forge);
      if (!("refusal" in r)) throw new Error("expected a refusal");
      const id = /ltm\/propose\/([A-Za-z0-9_-]{10})/.exec(r.refusal)?.[1];
      expect(r).toEqual({
        refusal: `pushed ltm/propose/${id}, but opening the review failed: boom`,
        url: `https://gitlab.example.com/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/${id}`,
      });
      expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/")).toBe(`refs/heads/ltm/propose/${id}\n`);
    });
  }, GIT_TEST_TIMEOUT);

  test("a proposal whose supersedes target shares no Facet is refused before anything is pushed", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const before = snapshot(bare, clone);
      const forge = fakeAdapter();
      const input: ProposalInput = { ...INPUT, supersedes: ["hT5cY8dUa6"], applies_to: ["domain:payments"] };
      const r = await propose(clone, forge, input);
      expect("refusal" in r && r.refusal).toMatch(/error supersession-facets: applies_to: /);
      expect(forge.calls).toHaveLength(0);
      expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/")).toBe("");
      expect(snapshot(bare, clone)).toEqual(before);
    });
  }, GIT_TEST_TIMEOUT);

  test("a proposal that supersedes an accepted Record lands on the branch and a clone of it validates", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const input: ProposalInput = { ...INPUT, supersedes: ["hT5cY8dUa6"], applies_to: ["domain:commerce"] };
      const r = proposed(await propose(clone, fakeAdapter(), input));
      expect(r.text).toContain("supersedes: [hT5cY8dUa6]");
      const fresh = mkdtempSync(join(tmpdir(), "ltm-fresh-"));
      try {
        git(fresh, "clone", "--quiet", "--branch", r.branch, bare, ".");
        const validated = await run({ argv: ["validate"], cwd: fresh, env: {} });
        expect(validated.stdout + validated.stderr).toBe("");
        expect(validated.exitCode).toBe(0);
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  }, GIT_TEST_TIMEOUT);

  test("a remote default branch other than main is found without origin/HEAD, and the clone gains no ref", async () => {
    await withGitBank(async ({ bare, clone }) => {
      git(bare, "branch", "-m", "main", "master");
      expect(git(bare, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/master");
      git(clone, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      // Git 2.54 recreates origin/HEAD on a plain fetch unless told not to.
      git(clone, "config", "remote.origin.followRemoteHEAD", "never");
      expect(spawnSync("git", ["-C", clone, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).status).not.toBe(0);

      const before = snapshot(bare, clone);
      const forge = fakeAdapter();
      const r = proposed(await propose(clone, forge));
      const after = snapshot(bare, clone);

      expect(forge.calls).toHaveLength(1);
      expect(forge.calls[0]!.base).toBe("master");
      const newRef = `\trefs/heads/ltm/propose/${r.id}`;
      const afterBareRefs = after.bareRefs.split("\n").filter((l) => !l.endsWith(newRef)).join("\n");
      expect({ ...after, bareRefs: afterBareRefs }).toEqual(before);
      expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/ltm/")).toBe(`refs/heads/ltm/propose/${r.id}\n`);
    });
  }, GIT_TEST_TIMEOUT);

  test("origin's default branch changing a folder mapping puts the file in the fetched folder, not the stale local one", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const other = mkdtempSync(join(tmpdir(), "ltm-other-"));
      const fresh = mkdtempSync(join(tmpdir(), "ltm-fresh-"));
      try {
        git(other, "clone", "--quiet", bare, ".");
        git(other, "config", "user.name", "ltm test");
        git(other, "config", "user.email", "ltm@example.invalid");
        git(other, "config", "commit.gpgsign", "false");
        const yaml = join(other, "memory-bank.yaml");
        writeFileSync(yaml, readFileSync(yaml, "utf8") + "folders:\n  Decision: _memory/adrs\n");
        git(other, "mv", "_memory/decisions", "_memory/adrs");
        git(other, "commit", "--quiet", "-am", "move decisions to adrs");
        git(other, "push", "--quiet", "origin", "main");
        // The clone never fetched that commit, so its own config still maps Decision to _memory/decisions.
        expect(loadConfig(clone).folders.Decision).toBe("_memory/decisions");

        const r = proposed(await propose(clone, fakeAdapter()));
        expect(r.path).toBe(`_memory/adrs/use-postgres-for-new-services-${r.id}.md`);
        expect(git(bare, "diff-tree", "--no-commit-id", "--name-status", "-r", r.branch)).toBe(`A\t${r.path}\n`);

        git(fresh, "clone", "--quiet", "--branch", r.branch, bare, ".");
        const validated = await run({ argv: ["validate"], cwd: fresh, env: {} });
        expect(validated.stdout + validated.stderr).toBe("");
        expect(validated.exitCode).toBe(0);
        expect(listRecords(loadConfig(fresh), () => {}).map((rec) => rec.path)).toContain(r.path);
      } finally {
        rmSync(other, { recursive: true, force: true });
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  }, GIT_TEST_TIMEOUT);

  test("a fetched default branch whose config won't load refuses, pushes nothing, and leaves no worktree", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const other = mkdtempSync(join(tmpdir(), "ltm-other-"));
      try {
        git(other, "clone", "--quiet", bare, ".");
        git(other, "config", "user.name", "ltm test");
        git(other, "config", "user.email", "ltm@example.invalid");
        git(other, "config", "commit.gpgsign", "false");
        writeFileSync(join(other, "memory-bank.yaml"), "schema: 1\nname: [unclosed\n");
        git(other, "commit", "--quiet", "-am", "break the config");
        git(other, "push", "--quiet", "origin", "main");
      } finally {
        rmSync(other, { recursive: true, force: true });
      }

      const before = snapshot(bare, clone);
      const forge = fakeAdapter();
      const r = await propose(clone, forge);
      expect("refusal" in r && r.refusal).toMatch(/^the fetched default branch has no usable Bank config: /);
      expect(forge.calls).toHaveLength(0);
      expect(snapshot(bare, clone)).toEqual(before);
    });
  }, GIT_TEST_TIMEOUT);

  test("a remote HEAD that moved to a new branch beats a stale origin/HEAD, and the clone gains no ref", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const other = mkdtempSync(join(tmpdir(), "ltm-other-"));
      try {
        git(other, "clone", "--quiet", bare, ".");
        git(other, "config", "user.name", "ltm test");
        git(other, "config", "user.email", "ltm@example.invalid");
        git(other, "config", "commit.gpgsign", "false");
        git(other, "switch", "--quiet", "-c", "trunk");
        git(other, "commit", "--quiet", "--allow-empty", "-m", "trunk diverges from main");
        git(other, "push", "--quiet", "origin", "trunk");
        git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");
        // Without this, propose's own fetch would refresh origin/HEAD and hide the staleness.
        git(clone, "config", "remote.origin.followRemoteHEAD", "never");
        expect(git(clone, "symbolic-ref", "refs/remotes/origin/HEAD").trim()).toBe("refs/remotes/origin/main");

        const before = snapshot(bare, clone);
        const forge = fakeAdapter();
        const r = proposed(await propose(clone, forge));
        const after = snapshot(bare, clone);

        expect(forge.calls).toHaveLength(1);
        expect(forge.calls[0]!.base).toBe("trunk");
        expect(git(bare, "rev-parse", `${r.branch}^`).trim()).toBe(git(bare, "rev-parse", "trunk").trim());
        const newRef = `\trefs/heads/ltm/propose/${r.id}`;
        const afterBareRefs = after.bareRefs.split("\n").filter((l) => !l.endsWith(newRef)).join("\n");
        expect({ ...after, bareRefs: afterBareRefs }).toEqual(before);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  }, GIT_TEST_TIMEOUT);

  // `link` is a path in the Bank that origin's default branch replaces with a symlink to a dir outside every repo.
  for (const link of ["_memory/decisions", "_memory"]) {
    test(`origin's default branch turning ${link} into a symlink refuses before writing through it`, async () => {
      await withGitBank(async ({ bare, clone }) => {
        const other = mkdtempSync(join(tmpdir(), "ltm-other-"));
        const outside = mkdtempSync(join(tmpdir(), "ltm-outside-"));
        try {
          git(other, "clone", "--quiet", bare, ".");
          git(other, "config", "user.name", "ltm test");
          git(other, "config", "user.email", "ltm@example.invalid");
          git(other, "config", "commit.gpgsign", "false");
          git(other, "rm", "-r", "--quiet", link);
          symlinkSync(outside, join(other, link));
          git(other, "add", "--", link);
          git(other, "commit", "--quiet", "-m", `make ${link} a symlink`);
          git(other, "push", "--quiet", "origin", "main");
          expect(git(bare, "ls-tree", "main", link)).toMatch(/^120000 blob /);

          const before = snapshot(bare, clone);
          const forge = fakeAdapter();
          const r = await propose(clone, forge);
          expect(readdirSync(outside, { recursive: true })).toEqual([]);
          expect("refusal" in r && r.refusal).toBe(`${link} on main is a symlink; ltm propose won't write through it`);
          expect(forge.calls).toHaveLength(0);
          expect(snapshot(bare, clone)).toEqual(before);
        } finally {
          rmSync(other, { recursive: true, force: true });
          rmSync(outside, { recursive: true, force: true });
        }
      });
    }, GIT_TEST_TIMEOUT);
  }

  test("an origin that pushes somewhere other than it fetches from is refused before any ref moves", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const fork = mkdtempSync(join(tmpdir(), "ltm-fork-"));
      try {
        git(fork, "init", "--quiet", "--bare", "--initial-branch=main");
        git(clone, "config", "remote.origin.pushurl", fork);
        expect(git(clone, "remote", "get-url", "--push", "origin").trim()).toBe(fork);

        const before = snapshot(bare, clone);
        const forkBefore = git(fork, "for-each-ref");
        const forge = fakeAdapter();
        const r = await propose(clone, forge);
        expect(r).toEqual({ refusal: "origin pushes somewhere other than it fetches from; ltm propose can't open a review across repositories" });
        expect(forge.calls).toHaveLength(0);
        expect(snapshot(bare, clone)).toEqual(before);
        expect(git(fork, "for-each-ref")).toBe(forkBefore);
      } finally {
        rmSync(fork, { recursive: true, force: true });
      }
    });
  }, GIT_TEST_TIMEOUT);

  test("a credentialed origin reaches the adapter as configured but comes back redacted in the result", async () => {
    await withGitBank(async ({ bare, clone }) => {
      const raw = "https://oauth2:s3cret@gitlab.example.com/acme/bank.git";
      git(clone, "config", "remote.origin.url", raw);
      git(clone, "config", `url.${bare}.insteadOf`, raw);
      const forge = fakeAdapter();
      const r = proposed(await propose(clone, forge));
      expect(forge.calls[0]!.remoteUrl).toBe(raw);
      expect(r.remoteUrl).toBe("https://gitlab.example.com/acme/bank.git");
    });
  }, GIT_TEST_TIMEOUT);

  test("a fetch that fails against a credentialed origin keeps the secret out of the refusal", async () => {
    await withGitBank(async ({ bare, clone }) => {
      git(clone, "config", "remote.origin.url", "https://user:s3cret@git.example.com/acme/bank.git");
      // A closed local port makes the fetch fail at once without leaving the machine.
      git(clone, "config", "http.proxy", "http://127.0.0.1:9");
      const before = snapshot(bare, clone);
      const forge = fakeAdapter();
      const r = await propose(clone, forge);
      expect("refusal" in r && r.refusal).toMatch(/^git fetch: /);
      expect(JSON.stringify(r)).not.toContain("s3cret");
      expect(forge.calls).toHaveLength(0);
      expect(snapshot(bare, clone)).toEqual(before);
    });
  }, GIT_TEST_TIMEOUT);

  test("a given body is written verbatim after the fence", async () => {
    await withGitBank(async ({ clone }) => {
      const body = "## Context\n\nx\n";
      const r = await propose(clone, fakeAdapter(), { type: "Context", title: "Billing", body }, true);
      if ("refusal" in r) throw new Error(r.refusal);
      expect(splitFrontmatter(r.text)!.body).toBe(body);
    });
  }, GIT_TEST_TIMEOUT);
});

describe("redactRemote", () => {
  test("drops URL-form userinfo and leaves scp-form logins and local paths alone", () => {
    expect(redactRemote("https://user:s3cret@git.example.com/acme/bank.git")).toBe("https://git.example.com/acme/bank.git");
    expect(redactRemote("https://ghp_token@github.com/acme/bank.git")).toBe("https://github.com/acme/bank.git");
    expect(redactRemote("ssh://git@ssh.dev.azure.com/v3/acme/proj/bank")).toBe("ssh://ssh.dev.azure.com/v3/acme/proj/bank");
    expect(redactRemote("git push: unable to access 'https://u:p@ss@host/x.git/'")).toBe("git push: unable to access 'https://host/x.git/'");
    expect(redactRemote("https://user:s3c?ret@git.example.com/acme/bank.git")).toBe("https://git.example.com/acme/bank.git");
    expect(redactRemote("https://user:s3c#ret@git.example.com/acme/bank.git")).toBe("https://git.example.com/acme/bank.git");
    expect(redactRemote("git@github.com:acme/bank.git")).toBe("git@github.com:acme/bank.git");
    expect(redactRemote("/tmp/ltm-bare-x")).toBe("/tmp/ltm-bare-x");
    expect(redactRemote("../bank.git")).toBe("../bank.git");
  });
});

describe("templates and slugs", () => {
  test("each type gets its headings, a blank line after each", () => {
    expect(templateBody("Decision")).toBe("\n## Context\n\n## Decision\n\n## Consequences\n");
    expect(templateBody("PolicyRule")).toBe("\n## Context\n\n## Policy Rule\n");
    expect(templateBody("Exception")).toBe("\n## Context\n\n## Exception\n");
    expect(templateBody("Context")).toBe("\n## Context\n");
  });

  test("slugs collapse runs, trim dashes, cap at 50, and never come back empty", () => {
    expect(slugify("Use Postgres -- for NEW services!")).toBe("use-postgres-for-new-services");
    expect(slugify("a".repeat(49) + " b")).toBe("a".repeat(49));
    expect(slugify("x".repeat(60))).toBe("x".repeat(50));
    expect(slugify("!!!")).toBe("record");
    expect(slugify("")).toBe("record");
  });
});
