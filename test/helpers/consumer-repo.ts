import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, IDENTITY } from "./git-bank.ts";

const fixture = new URL("../../fixtures/consumer-repo", import.meta.url).pathname;

// The origin is only a name for repoIdentity to parse; nothing is ever pushed to it. The dir is a mkdtemp under the OS temp dir, so git never walks up into this checkout. Realpath'd because macOS tmpdir() is a symlink and callers compare against git's own paths.
export async function withConsumerRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ltm-consumer-")));
  try {
    cpSync(fixture, dir, { recursive: true });
    git(dir, "init", "--quiet", "--initial-branch=main");
    git(dir, "add", "-A");
    git(dir, ...IDENTITY, "commit", "--quiet", "-m", "seed");
    git(dir, "remote", "add", "origin", "https://github.com/acme/order-service.git");
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
