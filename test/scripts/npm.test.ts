import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const npm = Bun.which("npm");

const BINARIES = ["ltm-linux-x64", "ltm-linux-arm64", "ltm-darwin-x64", "ltm-darwin-arm64", "ltm-windows-x64.exe"];
const hostOs = process.platform === "win32" ? "windows" : process.platform;
const hostBinary = `ltm-${hostOs}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

// A stand-in npm that appends "<cwd-basename> <args>" per call, so a test can tell whether publish was reached and in which package dir.
function fakeNpm(dir: string): { bin: string; log: string } {
  const bin = join(dir, "bin");
  const log = join(dir, "npm-calls");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$(basename "$PWD") $*" >> '${log}'\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return { bin, log };
}

describe("publish-npm.sh guard", () => {
  test.each([
    ["without NPM_TOKEN", {}],
    ["with NPM_TOKEN set", { NPM_TOKEN: "npm_fake", NODE_AUTH_TOKEN: "npm_fake" }],
  ])("skips the real publish with a notice and exit 0 while the scope is the placeholder, %s", (_label, extra) => {
    // The skip is only meaningful against the committed config, so check it still holds the placeholder.
    expect(JSON.parse(readFileSync(join(ROOT, "npm/config.json"), "utf8"))).toEqual({ NPM_SCOPE_NAME: "CHANGE-ME-BEFORE-PUBLISH" });

    const dir = mkdtempSync(join(tmpdir(), "ltm-publish-guard-"));
    try {
      const { bin, log } = fakeNpm(dir);
      const r = spawnSync("bash", [join(ROOT, "scripts/publish-npm.sh")], {
        encoding: "utf8",
        env: { ...process.env, ...extra, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("::notice::");
      expect(r.stdout).toContain("NPM_SCOPE_NAME");
      expect(existsSync(log)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("with a real-looking scope", () => {
    let root: string;
    let npmBin: { bin: string; log: string };

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "ltm-publish-acme-"));
      mkdirSync(join(root, "scripts"));
      copyFileSync(join(ROOT, "scripts/publish-npm.sh"), join(root, "scripts/publish-npm.sh"));
      mkdirSync(join(root, "npm"));
      writeFileSync(join(root, "npm/config.json"), '{ "NPM_SCOPE_NAME": "acme" }\n');
      for (const pkg of ["ltm", "ltm-linux-x64"]) {
        mkdirSync(join(root, "dist/npm", pkg), { recursive: true });
        writeFileSync(join(root, "dist/npm", pkg, "package.json"), JSON.stringify({ name: `@acme/${pkg}`, version: "0.0.0" }));
      }
      npmBin = fakeNpm(root);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const runIt = (...args: string[]) => {
      rmSync(npmBin.log, { force: true });
      return spawnSync("bash", [join(root, "scripts/publish-npm.sh"), ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${npmBin.bin}:${process.env.PATH}` },
      });
    };

    test("the real publish reaches npm publish, platform packages before the main one", () => {
      const r = runIt();
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain("::notice::");
      expect(readFileSync(npmBin.log, "utf8").trim().split("\n")).toEqual([
        "ltm-linux-x64 publish --access public",
        "ltm publish --access public",
      ]);
    });

    test("--dry-run still runs npm's dry run", () => {
      const r = runIt("--dry-run");
      expect(r.status).toBe(0);
      expect(readFileSync(npmBin.log, "utf8")).toContain("ltm publish --access public --dry-run");
    });
  });
});

describe("npm packages", () => {
  // A scratch dist/ so the suite never races a real build-binaries.sh run. Only the host binary is real; cross-compiling the rest would cost minutes and nothing here runs them.
  let dist: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "ltm-npm-dist-"));
    const build = spawnSync("bun", ["build", "--compile", join(ROOT, "src/cli/bin.ts"), "--outfile", join(dist, hostBinary)], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`bun build failed: ${build.stderr}`);
    for (const b of BINARIES) if (b !== hostBinary) writeFileSync(join(dist, b), `stub ${b}\n`);

    const r = spawnSync("bun", [join(ROOT, "scripts/build-npm.ts"), "--scope", "ltm-local", "--dist", dist], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`build-npm failed: ${r.stderr}`);
  }, 120_000);
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  const readPkg = (dir: string) => JSON.parse(readFileSync(join(dist, "npm", dir, "package.json"), "utf8"));

  test("build-npm writes the main package and one package per platform", () => {
    expect(readdirSync(join(dist, "npm")).sort()).toEqual(
      ["ltm", "ltm-darwin-arm64", "ltm-darwin-x64", "ltm-linux-arm64", "ltm-linux-x64", "ltm-win32-x64"].sort(),
    );

    const platforms = [
      ["ltm-linux-x64", "linux", "x64", "ltm-linux-x64", "ltm"],
      ["ltm-linux-arm64", "linux", "arm64", "ltm-linux-arm64", "ltm"],
      ["ltm-darwin-x64", "darwin", "x64", "ltm-darwin-x64", "ltm"],
      ["ltm-darwin-arm64", "darwin", "arm64", "ltm-darwin-arm64", "ltm"],
      ["ltm-win32-x64", "win32", "x64", "ltm-windows-x64.exe", "ltm.exe"],
    ];
    for (const [dir, os, cpu, source, exe] of platforms) {
      const pkg = readPkg(dir!);
      expect(pkg.name).toBe(`@ltm-local/${dir}`);
      expect(pkg.version).toBe(pkgVersion);
      expect(pkg.os).toEqual([os]);
      expect(pkg.cpu).toEqual([cpu]);
      expect(readFileSync(join(dist, "npm", dir!, "bin", exe!))).toEqual(readFileSync(join(dist, source!)));
    }

    const main = readPkg("ltm");
    expect(main.name).toBe("@ltm-local/ltm");
    expect(main.version).toBe(pkgVersion);
    expect(main.bin).toEqual({ ltm: "bin/ltm.js" });
    expect(main.os).toBeUndefined();
    expect(main.optionalDependencies).toEqual(
      Object.fromEntries(platforms.map(([dir]) => [`@ltm-local/${dir}`, pkgVersion])),
    );
  });

  if (!npm) console.warn("skipping the npm install test: npm isn't on PATH");
  test.skipIf(!npm)(
    "npx ltm --version from the installed tarballs matches the binary",
    () => {
      const work = mkdtempSync(join(tmpdir(), "ltm-npm-install-"));
      try {
        // A private cache and --offline keep the install off the registry: the four foreign optional packages must be skipped, not fetched.
        const env = { ...process.env, npm_config_cache: join(work, "cache"), npm_config_update_notifier: "false" };
        const npmDir = process.platform === "win32" ? "win32" : process.platform;
        const app = join(work, "app");
        mkdirSync(app);
        const tarballs = [];
        for (const dir of ["ltm", `ltm-${npmDir}-${process.arch}`]) {
          const pack = spawnSync(npm!, ["pack", "--json", "--pack-destination", app], { cwd: join(dist, "npm", dir), encoding: "utf8", env });
          expect(pack.status).toBe(0);
          tarballs.push(`./${JSON.parse(pack.stdout)[0].filename}`);
        }

        const install = spawnSync(npm!, ["i", "--offline", "--no-audit", "--no-fund", ...tarballs], { cwd: app, encoding: "utf8", env });
        expect(install.stderr).not.toContain("npm error");
        expect(install.status).toBe(0);

        // `--no` stops npx from falling back to some registry package named ltm, and `--` keeps --version away from npx itself.
        const npx = spawnSync(join(npm!, "..", "npx"), ["--no", "--", "ltm", "--version"], { cwd: app, encoding: "utf8", env });
        const direct = spawnSync(join(dist, hostBinary), ["--version"], { encoding: "utf8" });
        expect(direct.status).toBe(0);
        expect(direct.stdout).toBe(`${pkgVersion}\n`);
        expect(npx.stderr).toBe("");
        expect(npx.status).toBe(0);
        expect(npx.stdout).toBe(direct.stdout);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
