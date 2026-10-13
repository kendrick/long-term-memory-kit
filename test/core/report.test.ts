import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { toGithub, toGitlab, toJunit } from "../../src/core/report.ts";
import type { Finding } from "../../src/core/validate.ts";

const err = (over: Partial<Finding> = {}): Finding => ({
  file: "a.md",
  line: 3,
  rule: "schema",
  severity: "error",
  key: "status",
  message: "must have required property 'status'",
  ...over,
});
const warn = (over: Partial<Finding> = {}): Finding =>
  err({ rule: "bright-line", severity: "warning", key: "applies_to", line: 7, message: "scoped to only service:a", ...over });

describe("toGithub", () => {
  test("one error and one warning give exactly two workflow-command lines", () => {
    const lines = toGithub([err(), warn()]).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("::error ")).toBe(true);
    expect(lines[1]!.startsWith("::warning ")).toBe(true);
    expect(lines[0]).toBe("::error file=a.md,line=3,title=schema::must have required property 'status'");
  });

  test("a message with a comma and a newline stays on one line", () => {
    const lines = toGithub([err({ message: "a, b\nc\r%" })]).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("::a, b%0Ac%0D%25");
  });

  test("property values escape comma and colon", () => {
    const out = toGithub([err({ file: "we,ird:name.md" })]);
    expect(out).toContain("file=we%2Cird%3Aname.md,");
  });

  test("no findings give empty output", () => {
    expect(toGithub([])).toBe("");
  });
});

describe("toGitlab", () => {
  const KEYS = ["check_name", "description", "fingerprint", "location", "severity"];

  test("every element has GitLab's five Code Quality keys", () => {
    const parsed = JSON.parse(toGitlab([err(), warn()])) as Record<string, unknown>[];
    expect(parsed).toHaveLength(2);
    for (const el of parsed) expect(Object.keys(el).sort()).toEqual(KEYS);
    expect(parsed.map((e) => e.severity)).toEqual(["major", "minor"]);
    expect(parsed[0]).toMatchObject({
      description: "must have required property 'status'",
      check_name: "schema",
      location: { path: "a.md", lines: { begin: 3 } },
    });
    expect(parsed[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fingerprints are stable, ignore message, and track key", () => {
    const fp = (f: Finding): string => (JSON.parse(toGitlab([f])) as { fingerprint: string }[])[0]!.fingerprint;
    expect(fp(err())).toBe(fp(err()));
    expect(fp(err({ message: "different words" }))).toBe(fp(err()));
    expect(fp(err({ key: "id" }))).not.toBe(fp(err()));
    expect(fp(err({ key: null }))).not.toBe(fp(err()));
  });

  test("no findings give an empty JSON array", () => {
    expect(JSON.parse(toGitlab([]))).toEqual([]);
  });
});

// Parsed by Python's stdlib XML parser rather than matched by regex, so malformed
// escaping or nesting fails here the way it would in a CI JUnit consumer.
const PY = `
import sys, json, xml.etree.ElementTree as E
root = E.fromstring(sys.stdin.read())
cases = root.findall("testcase")
print(json.dumps({
  "tag": root.tag,
  "tests": root.get("tests"),
  "failures": root.get("failures"),
  "testcases": len(list(root.iter("testcase"))),
  "failure_total": len(list(root.iter("failure"))),
  "cases": [{
    "name": c.get("name"),
    "failures": [{"message": f.get("message"), "type": f.get("type"), "text": f.text} for f in c.findall("failure")],
    "out": [o.text for o in c.findall("system-out")],
  } for c in cases],
}))
`;

type Parsed = {
  tag: string;
  tests: string;
  failures: string;
  testcases: number;
  failure_total: number;
  cases: { name: string; failures: { message: string; type: string; text: string }[]; out: string[] }[];
};

function parseJunit(xml: string): Parsed {
  const r = spawnSync("python3", ["-c", PY], { input: xml, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python3 rejected the XML: ${r.stderr}`);
  return JSON.parse(r.stdout) as Parsed;
}

describe("toJunit", () => {
  test("two errors in a.md and none in b.md sit under a.md's testcase", () => {
    const xml = toJunit([err(), err({ line: 5, rule: "canonical-list", key: "tags" })], ["a.md", "b.md"]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const p = parseJunit(xml);
    expect(p.tag).toBe("testsuite");
    expect(p.tests).toBe("2");
    expect(p.failures).toBe("2");
    expect(p.testcases).toBe(2);
    expect(p.failure_total).toBe(2);
    const a = p.cases.find((c) => c.name === "a.md")!;
    const b = p.cases.find((c) => c.name === "b.md")!;
    expect(a.failures).toHaveLength(2);
    expect(b.failures).toHaveLength(0);
    expect(a.failures[0]).toEqual({ message: "schema: status", type: "schema", text: "a.md:3: must have required property 'status'" });
  });

  test("a warning lands in system-out, not as a failure", () => {
    const p = parseJunit(toJunit([warn()], ["a.md"]));
    expect(p.failure_total).toBe(0);
    expect(p.failures).toBe("0");
    expect(p.cases[0]!.out).toHaveLength(1);
    expect(p.cases[0]!.out[0]).toContain("bright-line");
  });

  test("markup characters in a message still parse", () => {
    const p = parseJunit(toJunit([err({ message: `<&> "q" 'a'`, key: null })], ["a.md"]));
    expect(p.cases[0]!.failures[0]!.text).toBe(`a.md:3: <&> "q" 'a'`);
    expect(p.cases[0]!.failures[0]!.message).toBe("schema: -");
  });
});
