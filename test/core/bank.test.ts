import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, DEFAULT_FOLDERS, findBank, loadConfig } from "../../src/core/bank.ts";
import { withScratch } from "../helpers/scratch.ts";

const demoBank = fileURLToPath(new URL("../../fixtures/demo-bank", import.meta.url));

// Literal copy of the Settled Choices' defaults, so the assertion isn't the constant checking itself.
const expectedDefaults = {
  Decision: "_memory/decisions",
  PolicyRule: "_memory/policy-rules",
  Exception: "_memory/exceptions",
  Context: "_memory/context",
};

describe("findBank", () => {
  test("resolves the Bank root from the root and from a subfolder", async () => {
    await withScratch(demoBank, async (dir) => {
      expect(findBank(dir)).toBe(dir);
      expect(findBank(join(dir, "_memory/decisions"))).toBe(dir);
    });
  });

  test("returns null outside any Bank", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-nobank-"));
    try {
      expect(findBank(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadConfig", () => {
  test("demo bank gets the default folders", async () => {
    await withScratch(demoBank, async (dir) => {
      const config = loadConfig(dir);
      expect(config.root).toBe(dir);
      expect(config.folders).toEqual(expectedDefaults);
      expect(config.raw.name).toBe("acme");
    });
  });

  test("a folders key overrides per type and leaves the rest default", async () => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "memory-bank.yaml"), "schema: 1\nname: acme\nfolders:\n  Decision: docs/adr\n");
      expect(loadConfig(dir).folders).toEqual({ ...expectedDefaults, Decision: "docs/adr" });
    });
  });

  test.each(["../outside", "/etc"])("folders.Decision '%s' outside the Bank root throws", async (value) => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "memory-bank.yaml"), `schema: 1\nname: acme\nfolders:\n  Decision: ${value}\n`);
      let caught: unknown;
      try {
        loadConfig(dir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).path).toBe(join(dir, "memory-bank.yaml"));
      expect((caught as ConfigError).message).toContain("folders.Decision");
    });
  });

  test("a folders value containing a backslash throws", async () => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "memory-bank.yaml"), 'schema: 1\nname: acme\nfolders:\n  Decision: "q\\\\z"\n');
      let caught: unknown;
      try {
        loadConfig(dir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).path).toBe(join(dir, "memory-bank.yaml"));
      expect((caught as ConfigError).line).toBeNull();
      expect((caught as ConfigError).message).toBe("folders.Decision 'q\\z' contains a backslash");
    });
  });

  test("a folder equal to the Bank root is allowed", async () => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "memory-bank.yaml"), "schema: 1\nname: acme\nfolders:\n  Decision: .\n");
      expect(loadConfig(dir).folders.Decision).toBe(".");
    });
  });

  test("unparseable YAML throws ConfigError carrying the line", async () => {
    await withScratch(demoBank, async (dir) => {
      // Line 2 is the bad one. No trailing newline: with one, yaml reports the line
      // where it noticed the unclosed flow (3), not where it opened.
      await writeFile(join(dir, "memory-bank.yaml"), "schema: 1\nname: [unclosed");
      let caught: unknown;
      try {
        loadConfig(dir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).line).toBe(2);
      expect((caught as ConfigError).path).toBe(join(dir, "memory-bank.yaml"));
    });
  });
});

test("DEFAULT_FOLDERS matches the defaults the schema states", () => {
  expect(DEFAULT_FOLDERS).toEqual(expectedDefaults);
  const schema = JSON.parse(
    readFileSync(new URL("../../schema/memory-bank.schema.json", import.meta.url), "utf8"),
  ) as { properties: { folders: { description: string } } };
  const description = schema.properties.folders.description;
  for (const [type, folder] of Object.entries(DEFAULT_FOLDERS)) {
    expect(description).toContain(`${type} ${folder}`);
  }
});
