import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const dir = fileURLToPath(new URL("../../templates/github/workflows/", import.meta.url));
const NAMES = ["ltm-validate.yml", "ltm-accept.yml", "ltm-issue-form.yml"];
const TOKEN = "${{ secrets.LTM_TOKEN || github.token }}";

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { if?: string; env?: Record<string, unknown>; permissions?: unknown; steps: Step[] };
type Workflow = { name: string; env: Record<string, unknown>; on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };

const text = (name: string) => readFileSync(`${dir}${name}`, "utf8");
const load = (name: string) => parse(text(name)) as Workflow;
const steps = (wf: Workflow) => Object.values(wf.jobs).flatMap((j) => j.steps);
const isCheckout = (s: Step) => s.uses?.startsWith("actions/checkout@") === true;
const downloadsLtm = (s: Step) => s.run?.includes("releases/download") === true;

describe("GitHub workflow templates", () => {
  test.each(NAMES)("%s parses, and LTM_VERSION is the first key after name", (name) => {
    const wf = load(name);
    expect(Object.keys(wf).slice(0, 2)).toEqual(["name", "env"]);
    expect(Object.keys(wf.env)[0]).toBe("LTM_VERSION");
    expect(wf.env.LTM_VERSION).toBe("{{LTM_VERSION}}");
    expect(text(name)).toMatch(/^name: .*\nenv:\n  LTM_VERSION: "\{\{LTM_VERSION\}\}"\n/);
  });

  test.each(NAMES)("%s installs ltm and checks the download against SHA256SUMS", (name) => {
    const installs = steps(load(name)).filter(downloadsLtm);
    expect(installs.length).toBeGreaterThan(0);
    for (const s of installs) {
      expect(s.run).toContain("ltm-linux-x64");
      expect(s.run).toContain("SHA256SUMS");
      // The check must run before the binary lands on PATH, or a bad download still gets used.
      const lines = s.run!.split("\n");
      const check = lines.findIndex((l) => /\bsha256sum -c\b/.test(l));
      const path = lines.findIndex((l) => l.includes("GITHUB_PATH"));
      expect(check).toBeGreaterThanOrEqual(0);
      expect(path).toBeGreaterThan(check);
    }
  });

  test.each(NAMES)("%s keeps ${{ }} out of every run script", (name) => {
    // Event fields like a PR title, branch, or issue body would be spliced into the shell as code.
    for (const s of steps(load(name))) if (s.run !== undefined) expect(s.run).not.toContain("${{");
  });

  test.each(NAMES)("%s sets minimal permissions and runs no local action", (name) => {
    const wf = load(name);
    for (const job of Object.values(wf.jobs)) expect(job.permissions ?? wf.permissions).toBeDefined();
    for (const s of steps(wf)) expect(s.uses?.startsWith(".") ?? false).toBe(false);
  });

  test("every GH_TOKEN, and every checkout in a workflow that pushes, uses LTM_TOKEN first", () => {
    for (const name of NAMES) {
      const wf = load(name);
      const envs = [wf.env, ...Object.values(wf.jobs).flatMap((j) => [j.env, ...j.steps.map((s) => s.env)])];
      for (const env of envs) if (env?.GH_TOKEN !== undefined) expect(env.GH_TOKEN).toBe(TOKEN);
    }
    for (const name of ["ltm-accept.yml", "ltm-issue-form.yml"]) {
      const checkouts = steps(load(name)).filter(isCheckout);
      expect(checkouts.length).toBe(1);
      for (const s of checkouts) expect(s.with?.token).toBe(TOKEN);
    }
    // validate pushes nothing, so it keeps no credentials in the checkout.
    for (const s of steps(load("ltm-validate.yml")).filter(isCheckout)) expect(s.with?.["persist-credentials"]).toBe(false);
  });

  test("ltm-validate runs on pull_request, validates for GitHub, and checks the generated files", () => {
    const wf = load("ltm-validate.yml");
    expect(Object.keys(wf.on)).toEqual(["pull_request"]);
    const runs = steps(wf).flatMap((s) => (s.run === undefined ? [] : [s.run.trim()]));
    expect(runs).toContain("ltm validate --format github");
    expect(runs).toContain("ltm init --check");
  });

  describe("ltm-accept", () => {
    const wf = load("ltm-accept.yml");
    const [job, ...others] = Object.values(wf.jobs);
    const all = job!.steps;
    const permIdx = all.findIndex((s) => /collaborators\/\S+\/permission/.test(s.run ?? ""));

    test("triggers only on pull_request_target labeled, gated on the accept label", () => {
      expect(others).toEqual([]);
      expect(wf.on).toEqual({ pull_request_target: { types: ["labeled"] } });
      expect(job!.if).toBe("github.event.label.name == 'accept'");
    });

    test("the permission check is the first step, ahead of any checkout or install", () => {
      expect(permIdx).toBe(0);
      expect(all[0]!.run).toMatch(/--jq \.permission/);
      expect(all[0]!.run).toMatch(/admin/);
      expect(all[0]!.run).toMatch(/write/);
      const firstCheckout = all.findIndex(isCheckout);
      expect(firstCheckout).toBeGreaterThan(permIdx);
      expect(all.findIndex(downloadsLtm)).toBeGreaterThan(permIdx);
    });

    test("every later step needs the permission check to have allowed the run", () => {
      const gate = `steps.${all[0]!.id}.outputs.allowed == 'true'`;
      expect(all[0]!.id).toBeDefined();
      for (const s of all.slice(1)) expect(s.if).toContain(gate);
    });

    test("a fork PR gets a comment and nothing from the fork is checked out", () => {
      const sameRepo = "github.event.pull_request.head.repo.full_name == github.repository";
      const forkOnly = all.filter((s) => s.if?.includes("github.event.pull_request.head.repo.full_name != github.repository"));
      expect(forkOnly.length).toBe(1);
      expect(forkOnly[0]!.run).toContain("ltm accept --changed-since origin/");
      expect(forkOnly[0]!.uses).toBeUndefined();
      // Everything past the permission step that isn't the fork comment runs only for a same-repo PR,
      // so the checkout below can never fetch fork code.
      for (const s of all.slice(1)) if (s !== forkOnly[0]) expect(s.if).toContain(sameRepo);
      const checkout = all.find(isCheckout)!;
      expect(checkout.with?.ref).toBe("${{ github.event.pull_request.head.ref }}");
      expect(checkout.with?.["fetch-depth"]).toBe(0);
    });

    test("no step after the checkout runs anything from the checked-out tree", () => {
      const after = all.slice(all.findIndex(isCheckout) + 1);
      for (const s of after) {
        expect(s.uses).toBeUndefined();
        // Only the downloaded ltm, git, gh, and coreutils touch the tree; nothing is sourced or executed from it.
        expect(s.run).not.toMatch(/(^|[\s;&|(])(\.\/|bash |sh |source |\. |npm |npx |bun |node |make )/m);
      }
    });

    test("runs accept against the base branch and commits Accept <ids> only on success", () => {
      const acceptStep = all.find((s) => s.run?.includes('ltm accept --changed-since "origin/$BASE_REF"'));
      expect(acceptStep).toBeDefined();
      expect(acceptStep!.run).toContain("ltm accept: accepted ");
      expect(acceptStep!.run).toContain('commit -m "Accept $ids"');
      expect(acceptStep!.run).toContain("github-actions[bot]");
      const lines = acceptStep!.run!.split("\n");
      const exit1 = lines.findIndex((l) => l.trim() === "exit 1");
      const commit = lines.findIndex((l) => l.includes("commit -m"));
      expect(exit1).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(exit1);
    });
  });

  test("ltm-issue-form runs on a labeled new issue and reads the body from env", () => {
    const wf = load("ltm-issue-form.yml");
    expect(wf.on).toEqual({ issues: { types: ["opened"] } });
    const job = Object.values(wf.jobs)[0]!;
    expect(job.if).toBe("contains(github.event.issue.labels.*.name, 'ltm-proposal')");
    expect(job.env?.ISSUE_BODY).toBe("${{ github.event.issue.body }}");
    const propose = job.steps.find((s) => s.run?.includes("ltm propose --from-issue-form"));
    expect(propose?.run).toContain('--source-ref "$ISSUE_URL"');
    expect(propose?.run).toContain("--json");
  });

  test("ltm-issue-form handles a null PR url from a host without PRs", () => {
    const run = steps(load("ltm-issue-form.yml")).find((s) => s.id === "propose")!.run!;
    expect(run).toContain("jq -r '.url // empty'");
    expect(run).toContain("Pushed branch");
    expect(run).toContain("couldn't open a pull request on this host");
  });

  test("the Install ltm step is the same script in every workflow", () => {
    // Templates can't share a step without a composite action, so this is what keeps the copies from drifting.
    const scripts = NAMES.map((name) => steps(load(name)).filter((s) => s.name === "Install ltm").map((s) => s.run));
    for (const list of scripts) expect(list.length).toBe(1);
    expect(new Set(scripts.flat()).size).toBe(1);
  });

  test("ltm-issue-form comments on any failure, but only once", () => {
    const all = steps(load("ltm-issue-form.yml"));
    const propose = all.find((s) => s.run?.includes("ltm propose --from-issue-form"))!;
    expect(propose.id).toBe("propose");
    // The propose step posts its own error comment and flags it, so the catch-all stays quiet then.
    const lines = propose.run!.split("\n").map((l) => l.trim());
    const flag = lines.indexOf('echo "commented=true" >> "$GITHUB_OUTPUT"');
    expect(flag).toBeGreaterThan(lines.findIndex((l) => l.startsWith("gh issue comment")));
    expect(lines[flag + 1]).toBe("exit 1");
    const last = all.at(-1)!;
    expect(all.indexOf(last)).toBeGreaterThan(all.indexOf(propose));
    expect(last.if).toBe("failure() && steps.propose.outputs.commented != 'true'");
    expect(last.run).toContain('gh issue comment "$ISSUE"');
    expect(last.run).toContain("$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID");
  });

  test.each(["ltm-accept.yml", "ltm-issue-form.yml"])("%s names the LTM_TOKEN fix when the secret is unset", (name) => {
    const t = text(name);
    expect(t).toContain("LTM_TOKEN");
    expect(t).toContain("empty commit");
  });
});
