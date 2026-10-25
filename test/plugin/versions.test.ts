import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = new URL("../..", import.meta.url).pathname;

type VersionedFile = { path: string; text: string };

function versionOf(file: VersionedFile): string | undefined {
  if (file.path.endsWith(".json")) return (JSON.parse(file.text) as { version?: string }).version;
  return /^<!-- VERSION: (\S+) -->$/m.exec(file.text)?.[1];
}

// A file with no version at all disagrees, so deleting a VERSION line can't pass as agreement.
export function versionsAgree(pkgVersion: string, files: VersionedFile[]): boolean {
  return files.every((f) => versionOf(f) === pkgVersion);
}

function realFiles(): VersionedFile[] {
  const skills = join(repo, "skills");
  const paths = [
    ".claude-plugin/plugin.json",
    ...readdirSync(skills)
      .filter((d) => existsSync(join(skills, d, "SKILL.md")))
      .map((d) => `skills/${d}/SKILL.md`),
  ];
  return paths.map((path) => ({ path, text: readFileSync(join(repo, path), "utf8") }));
}

const pkgVersion = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;

function bump(file: VersionedFile, to: string): VersionedFile {
  const text = file.path.endsWith(".json")
    ? JSON.stringify({ ...JSON.parse(file.text), version: to })
    : file.text.replace(/^<!-- VERSION: \S+ -->$/m, `<!-- VERSION: ${to} -->`);
  return { ...file, text };
}

describe("plugin versions", () => {
  test("plugin.json and every skill's VERSION line equal package.json's version", () => {
    const files = realFiles();
    // plugin.json plus the three skills; fewer would make agreement vacuous.
    expect(files).toHaveLength(4);
    expect(files.map((f) => [f.path, versionOf(f)])).toEqual(files.map((f) => [f.path, pkgVersion]));
    expect(versionsAgree(pkgVersion, files)).toBe(true);
  });
});

describe("the version rule's falsifier", () => {
  test("bumping package.json alone fails", () => {
    expect(versionsAgree("0.0.1", realFiles())).toBe(false);
  });

  test("bumping every version together passes", () => {
    expect(versionsAgree("0.0.1", realFiles().map((f) => bump(f, "0.0.1")))).toBe(true);
  });

  test("bumping one skill's VERSION line alone fails", () => {
    const files = realFiles();
    const i = files.findIndex((f) => f.path.endsWith("SKILL.md"));
    files[i] = bump(files[i]!, "0.0.1");
    expect(versionsAgree(pkgVersion, files)).toBe(false);
  });

  test("a skill whose body changed but whose VERSION line didn't still passes", () => {
    const files = realFiles().map((f) => (f.path.endsWith("SKILL.md") ? { ...f, text: `${f.text}\nA new paragraph.\n` } : f));
    expect(versionsAgree(pkgVersion, files)).toBe(true);
  });

  test("a skill with its VERSION line deleted fails", () => {
    const files = realFiles().map((f) => ({ ...f, text: f.text.replace(/^<!-- VERSION: \S+ -->$/m, "") }));
    expect(versionsAgree(pkgVersion, files)).toBe(false);
  });
});
