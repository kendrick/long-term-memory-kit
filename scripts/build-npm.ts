// Turns the binaries in dist/ into npm packages under dist/npm/: one main package with the Node shim, and one per platform holding its binary.
// Usage: bun scripts/build-npm.ts [--scope <name>] [--dist <dir>]. --dist exists so tests can build from a scratch dir instead of the shared dist/.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ options: { scope: { type: "string" }, dist: { type: "string" } } });

const scope = values.scope ?? JSON.parse(readFileSync(join(root, "npm/config.json"), "utf8")).NPM_SCOPE_NAME;
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dist = resolve(values.dist ?? join(root, "dist"));
const out = join(dist, "npm");

// npm's os/cpu names, which the shim matches against process.platform/process.arch.
const targets = [
  { file: "ltm-linux-x64", os: "linux", cpu: "x64" },
  { file: "ltm-linux-arm64", os: "linux", cpu: "arm64" },
  { file: "ltm-darwin-x64", os: "darwin", cpu: "x64" },
  { file: "ltm-darwin-arm64", os: "darwin", cpu: "arm64" },
  { file: "ltm-windows-x64.exe", os: "win32", cpu: "x64" },
];

const missing = targets.filter((t) => !existsSync(join(dist, t.file)));
if (missing.length > 0) {
  console.error(`build-npm: missing ${missing.map((t) => t.file).join(", ")} in ${dist}; run scripts/build-binaries.sh first`);
  process.exit(1);
}

const common = {
  version,
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/kendrick/long-term-memory-kit.git" },
};
const write = (dir: string, pkg: object) => {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
};

rmSync(out, { recursive: true, force: true });

const optionalDependencies: Record<string, string> = {};
for (const t of targets) {
  const name = `@${scope}/ltm-${t.os}-${t.cpu}`;
  const exe = t.os === "win32" ? "ltm.exe" : "ltm";
  const dir = join(out, `ltm-${t.os}-${t.cpu}`);
  write(dir, { name, ...common, description: `The ltm binary for ${t.os}-${t.cpu}.`, os: [t.os], cpu: [t.cpu], files: [`bin/${exe}`] });
  copyFileSync(join(dist, t.file), join(dir, "bin", exe));
  chmodSync(join(dir, "bin", exe), 0o755);
  optionalDependencies[name] = version;
}

const main = join(out, "ltm");
write(main, {
  name: `@${scope}/ltm`,
  ...common,
  description: "Org-level memory for coding agents: the ltm CLI and MCP server.",
  bin: { ltm: "bin/ltm.js" },
  files: ["bin/ltm.js"],
  optionalDependencies,
});
copyFileSync(join(root, "npm/ltm/bin/ltm.js"), join(main, "bin/ltm.js"));
chmodSync(join(main, "bin/ltm.js"), 0o755);

console.log(`build-npm: wrote @${scope}/ltm and ${targets.length} platform packages ${version} to ${out}`);
