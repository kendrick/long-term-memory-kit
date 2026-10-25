#!/usr/bin/env node
// The one file in the npm install that needs Node: it finds the platform package npm picked through optionalDependencies and hands off to its compiled binary.
"use strict";
const { spawn } = require("node:child_process");

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

// A supervisor stopping `ltm mcp` signals this shim's PID, so the binary runs as an async child the shim can pass that signal to.
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = (signal) => child.kill(signal);
for (const signal of forwarded) process.on(signal, forward);

child.on("error", (err) => {
  console.error(`ltm: couldn't run ${binary}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    // Drop the handlers before re-raising, so the shim's parent sees the same signal death the binary had.
    for (const s of forwarded) process.removeListener(s, forward);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
