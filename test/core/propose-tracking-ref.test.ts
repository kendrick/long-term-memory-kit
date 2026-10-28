import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, snapshot, withGitBank } from "../helpers/git-bank.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PINNED_ID = "pinnedTRk1";

// Runs in a child process because mock.module is process-wide in bun and would leak into every later test file. The id has to be known up front so the test can pre-create refs/remotes/origin/<branch> before proposeRecord pushes.
const probeSource = `
import { mock } from "bun:test";
const fmt = ${JSON.stringify(join(ROOT, "src/core/fmt.ts"))};
const real = await import(fmt);
mock.module(fmt, () => ({ ...real, newId: () => process.env.LTM_PINNED_ID }));
const { loadConfig } = await import(${JSON.stringify(join(ROOT, "src/core/bank.ts"))});
const { proposeRecord } = await import(${JSON.stringify(join(ROOT, "src/core/propose.ts"))});
const forge = { name: "github", openChangeRequest: async () => ({ url: null }) };
const r = await proposeRecord(
  { type: "Decision", title: "Use Postgres for new services" },
  { config: loadConfig(process.env.LTM_CLONE), today: "2026-10-09", env: {}, forge },
);
console.log(JSON.stringify(r));
`;

test(
  "a refs/remotes/origin/<branch> the caller already had survives the push",
  async () => {
    await withGitBank(async ({ bare, clone }) => {
      const dir = mkdtempSync(join(tmpdir(), "ltm-probe-"));
      try {
        const head = git(clone, "rev-parse", "HEAD").trim();
        const trackingRef = `refs/remotes/origin/ltm/propose/${PINNED_ID}`;
        git(clone, "update-ref", trackingRef, head);
        const before = snapshot(bare, clone);
        expect(before.cloneRefs).toContain(trackingRef);

        const probe = join(dir, "probe.ts");
        await Bun.write(probe, probeSource);
        const r = spawnSync("bun", [probe], { encoding: "utf8", env: { ...process.env, LTM_PINNED_ID: PINNED_ID, LTM_CLONE: clone } });
        expect(r.status, r.stderr).toBe(0);
        const result = JSON.parse(r.stdout.trim().split("\n").pop()!);
        expect(result.refusal, "expected a real push").toBeUndefined();
        expect(result.id).toBe(PINNED_ID);

        const after = snapshot(bare, clone);
        expect(after.bareRefs).toContain(`refs/heads/ltm/propose/${PINNED_ID}`);
        // Only that it exists: git 2.56 itself moves a pre-existing ref to the pushed SHA, older git leaves it, and neither is ours to undo.
        expect(git(clone, "for-each-ref", "--format=%(refname)", trackingRef).trim()).toBe(trackingRef);
        expect(after.cloneRefs.split("\n").filter((l) => !l.includes(trackingRef))).toEqual(before.cloneRefs.split("\n").filter((l) => !l.includes(trackingRef)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
  60_000,
);
