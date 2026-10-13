import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
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

  // Root ignores mode bits, so the test would pass without exercising anything.
  test.skipIf(process.getuid?.() === 0)("throws on a directory it can't stat into instead of returning a parent Bank (#45)", async () => {
    await withScratch(demoBank, async (s) => {
      const locked = join(s, "bank/locked");
      mkdirSync(locked, { recursive: true });
      await writeFile(join(s, "bank/memory-bank.yaml"), "schema: 1\nname: acme\n");
      chmodSync(locked, 0o000);
      try {
        let e: unknown;
        try {
          findBank(locked);
        } catch (err) {
          e = err;
        }
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).path).toBe(join(locked, "memory-bank.yaml"));
        expect((e as ConfigError).line).toBeNull();
        // The OS reason must reach the user, not a generic refusal.
        expect((e as ConfigError).message).toMatch(/EACCES: permission denied/);
      } finally {
        chmodSync(locked, 0o755);
      }
    });
  });

  test("climbs past a plain directory with no config", async () => {
    await withScratch(demoBank, async (s) => {
      const plain = join(s, "bank/plain");
      mkdirSync(plain, { recursive: true });
      await writeFile(join(s, "bank/memory-bank.yaml"), "schema: 1\nname: acme\n");
      expect(findBank(plain)).toBe(join(s, "bank"));
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

describe("symlinked memory-bank.yaml (#36)", () => {
  const refusal = (dir: string) => ({
    path: join(dir, "memory-bank.yaml"),
    line: null,
    message: "memory-bank.yaml is a symlink, not followed",
  });

  function caught(fn: () => unknown): unknown {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  test.each(["outside", "inside", "dangling"])("findBank throws on a %s symlink and never reaches a parent", async (kind) => {
    const elsewhere = await mkdtemp(join(tmpdir(), "ltm-linktarget-"));
    try {
      await withScratch(demoBank, async (parent) => {
        const child = join(parent, "nested");
        mkdirSync(child);
        const outsideTarget = join(elsewhere, "memory-bank.yaml");
        await writeFile(outsideTarget, readFileSync(join(demoBank, "memory-bank.yaml")));
        const target =
          kind === "outside" ? outsideTarget : kind === "inside" ? join(parent, "memory-bank.yaml") : join(child, "nope.yaml");
        symlinkSync(target, join(child, "memory-bank.yaml"));
        const e = caught(() => findBank(child));
        expect(e).toBeInstanceOf(ConfigError);
        expect({ path: (e as ConfigError).path, line: (e as ConfigError).line, message: (e as ConfigError).message }).toEqual(refusal(child));
      });
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test("loadConfig refuses a symlink the same way", async () => {
    await withScratch(demoBank, async (dir) => {
      const real = join(dir, "real.yaml");
      await writeFile(real, "schema: 1\nname: acme\n");
      await rm(join(dir, "memory-bank.yaml"));
      symlinkSync(real, join(dir, "memory-bank.yaml"));
      const e = caught(() => loadConfig(dir));
      expect(e).toBeInstanceOf(ConfigError);
      expect({ path: (e as ConfigError).path, line: (e as ConfigError).line, message: (e as ConfigError).message }).toEqual(refusal(dir));
    });
  });

  test("restoring a regular file with the former target's bytes resolves again", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "ltm-linktarget-"));
    try {
      await withScratch(demoBank, async (dir) => {
        const target = join(elsewhere, "memory-bank.yaml");
        const bytes = readFileSync(join(demoBank, "memory-bank.yaml"));
        await writeFile(target, bytes);
        const config = join(dir, "memory-bank.yaml");
        await rm(config);
        symlinkSync(target, config);
        expect(lstatSync(config).isSymbolicLink()).toBe(true);
        expect(caught(() => findBank(dir))).toBeInstanceOf(ConfigError);

        await rm(config);
        await writeFile(config, readFileSync(target));
        expect(lstatSync(config).isFile()).toBe(true);
        expect(readFileSync(config).equals(readFileSync(target))).toBe(true);
        expect(findBank(dir)).toBe(dir);
        expect(loadConfig(dir).raw.name).toBe("acme");
      });
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
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

describe("loadConfig alias handling (#43)", () => {
  // Nine levels of ten refs each: expands past yaml's alias limit.
  const bomb = (() => {
    const lines = ["a: &a [x,x,x,x,x,x,x,x,x,x]"];
    for (let i = 1; i < 9; i++) {
      const n = String.fromCharCode(97 + i);
      const p = String.fromCharCode(96 + i);
      lines.push(`${n}: &${n} [${Array(10).fill(`*${p}`).join(",")}]`);
    }
    return `${lines.join("\n")}\n`;
  })();

  function configText(dir: string): string {
    return readFileSync(join(dir, "memory-bank.yaml"), "utf8");
  }

  test("an alias bomb becomes a ConfigError with a null line", async () => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "memory-bank.yaml"), `${configText(dir)}${bomb}`);
      let caught: unknown;
      try {
        loadConfig(dir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const err = caught as ConfigError;
      expect(err.path).toBe(join(dir, "memory-bank.yaml"));
      expect(err.line).toBeNull();
      expect(err.message).toContain("alias");
      expect(err.message).not.toContain("\n");
    });
  });

  test("a config with an ordinary alias still loads", async () => {
    await withScratch(demoBank, async (dir) => {
      await writeFile(join(dir, "memory-bank.yaml"), `${configText(dir)}a: &x service\nb: *x\n`);
      const config = loadConfig(dir);
      expect(config.raw.a).toBe("service");
      expect(config.raw.b).toBe("service");
    });
  });
});
