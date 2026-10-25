#!/usr/bin/env node
// The one file in the npm install that needs Node: it finds the platform package npm picked through optionalDependencies and hands off to its compiled binary.
"use strict";
const { spawnSync } = require("node:child_process");

// The scope lives only in npm/config.json, so read it back from our own package name instead of templating it in.
const scope = require("../package.json").name.split("/")[0];
const pkg = `${scope}/ltm-${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? "ltm.exe" : "ltm";

let binary;
try {
  binary = require.resolve(`${pkg}/bin/${exe}`);
} catch {
  console.error(`ltm: no binary for ${process.platform}-${process.arch}; the optional package ${pkg} isn't installed`);
  process.exit(1);
}

const r = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (r.error) {
  console.error(`ltm: couldn't run ${binary}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
