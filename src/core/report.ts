import { createHash } from "node:crypto";
import type { Finding } from "./validate.ts";

// GitHub unescapes only these three in a workflow command's message, so escaping more
// there would leak `%2C` into the annotation text.
const escapeGithubData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

// Property values are split on `,` and `:` before unescaping, so those need escaping too.
const escapeGithubProperty = (s: string): string => escapeGithubData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function toGithub(findings: Finding[]): string {
  return findings
    .map(
      (f) =>
        `::${f.severity} file=${escapeGithubProperty(f.file)},line=${f.line},title=${escapeGithubProperty(f.rule)}::${escapeGithubData(f.message)}\n`,
    )
    .join("");
}

// Message and line stay out of the hash: GitLab matches findings across pipelines by
// fingerprint, and a reworded message or a shifted line is still the same problem.
const fingerprint = (f: Finding): string =>
  createHash("sha256").update(`${f.rule}\0${f.file}\0${f.key ?? ""}`).digest("hex");

export function toGitlab(findings: Finding[]): string {
  const rows = findings.map((f) => ({
    description: f.message,
    check_name: f.rule,
    fingerprint: fingerprint(f),
    severity: f.severity === "error" ? "major" : "minor",
    location: { path: f.file, lines: { begin: f.line } },
  }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (s: string): string => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);

export function toJunit(findings: Finding[], files: string[]): string {
  const errors = findings.filter((f) => f.severity === "error");
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="ltm validate" tests="${files.length}" failures="${errors.length}">`,
  ];
  for (const file of files) {
    const mine = findings.filter((f) => f.file === file);
    const failures = mine.filter((f) => f.severity === "error");
    const warnings = mine.filter((f) => f.severity === "warning");
    if (failures.length === 0 && warnings.length === 0) {
      out.push(`  <testcase classname="ltm validate" name="${xml(file)}"/>`);
      continue;
    }
    out.push(`  <testcase classname="ltm validate" name="${xml(file)}">`);
    for (const f of failures) {
      out.push(
        `    <failure message="${xml(`${f.rule}: ${f.key ?? "-"}`)}" type="${xml(f.rule)}">${xml(`${f.file}:${f.line}: ${f.message}`)}</failure>`,
      );
    }
    if (warnings.length > 0) {
      const lines = warnings.map((f) => `${f.file}:${f.line}: warning ${f.rule}: ${f.key ?? "-"}: ${f.message}`);
      out.push(`    <system-out>${xml(lines.join("\n"))}</system-out>`);
    }
    out.push("  </testcase>");
  }
  out.push("</testsuite>");
  return `${out.join("\n")}\n`;
}
