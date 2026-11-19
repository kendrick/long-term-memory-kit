import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withGitBank } from "./git-bank.ts";

// Sets process.env because git() takes no env arg. A developer's exported GIT_CONFIG_GLOBAL reaches git() the same way.
async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const before = process.env[key];
  process.env[key] = value;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
  expect(process.env[key] === before).toBe(true);
}

function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "ltm-gitcfg-"));
  return fn(tmp).finally(() => rmSync(tmp, { recursive: true, force: true }));
}

function writeTemplate(tmp: string): string {
  mkdirSync(join(tmp, "tpl", "info"), { recursive: true });
  writeFileSync(join(tmp, "tpl", "info", "ltm-marker"), "marker\n");
  const config = join(tmp, "gitconfig");
  writeFileSync(config, `[init]\n\ttemplateDir = ${join(tmp, "tpl")}\n`);
  return config;
}

describe("withGitBank ignores the developer's git config", () => {
  test("a global core.hooksPath with a failing pre-commit doesn't stop the seed commit", () =>
    withTmp(async (tmp) => {
      mkdirSync(join(tmp, "hooks"));
      writeFileSync(join(tmp, "hooks", "pre-commit"), '#!/bin/sh\necho "global hook ran" >&2; exit 1\n', { mode: 0o755 });
      const config = join(tmp, "gitconfig");
      writeFileSync(config, `[core]\n\thooksPath = ${join(tmp, "hooks")}\n`);
      await withEnv("GIT_CONFIG_GLOBAL", config, async () => {
        const hadGit = await withGitBank(async (b) => existsSync(join(b.clone, ".git")));
        expect(hadGit).toBe(true);
      });
    }));

  test("a global init.templateDir doesn't reach the clone", () =>
    withTmp(async (tmp) => {
      await withEnv("GIT_CONFIG_GLOBAL", writeTemplate(tmp), async () => {
        const marker = await withGitBank(async (b) => existsSync(join(b.clone, ".git", "info", "ltm-marker")));
        expect(marker).toBe(false);
      });
    }));

  test("a system init.templateDir doesn't reach the clone", () =>
    withTmp(async (tmp) => {
      await withEnv("GIT_CONFIG_SYSTEM", writeTemplate(tmp), async () => {
        const marker = await withGitBank(async (b) => existsSync(join(b.clone, ".git", "info", "ltm-marker")));
        expect(marker).toBe(false);
      });
    }));
});
