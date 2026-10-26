import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { MEMORY_TYPES } from "../../src/core/bank.ts";
import { ISSUE_FORM_FIELDS, parseIssueForm } from "../../src/core/issue-form.ts";

const template = parse(readFileSync(fileURLToPath(new URL("../../templates/github/ISSUE_TEMPLATE/ltm-proposal.yml", import.meta.url)), "utf8"));

// GitHub renders every field, optional ones as _No response_ when blank.
const form = (type: string, consequences = "_No response_", context = "CTX"): string =>
  `### Memory type\n\n${type}\n\n### Title\n\nT\n\n### Summary\n\nS\n\n### Facets\n\na\nb\n\n### Context\n\n${context}\n\n### Decision, rule, or exception\n\nMAIN\n\n### Consequences\n\n${consequences}\n\n### Source links\n\n_No response_\n`;

const body = (r: ReturnType<typeof parseIssueForm>): string => {
  if ("error" in r) throw new Error(r.error);
  return r.input.body!;
};

describe("issue form fields", () => {
  test("the template's ids, labels, and required flags equal ISSUE_FORM_FIELDS", () => {
    const fields = template.body.map((b: any) => ({ id: b.id, label: b.attributes.label, required: b.validations?.required === true }));
    expect(fields).toEqual(ISSUE_FORM_FIELDS.map((f) => ({ ...f })));
  });

  test("the type dropdown offers exactly MEMORY_TYPES, and the label is applied", () => {
    expect(template.body[0].attributes.options).toEqual([...MEMORY_TYPES]);
    expect(template.labels).toEqual(["ltm-proposal"]);
  });
});

describe("parseIssueForm", () => {
  test("the fixture parses to a Decision with Facets, sources, and no Consequences", () => {
    const r = parseIssueForm(readFileSync(fileURLToPath(new URL("../fixtures/issue-form-body.md", import.meta.url)), "utf8"));
    if ("error" in r) throw new Error(r.error);
    expect(r.input.applies_to).toEqual(["domain:commerce", "system:data-platform"]);
    expect(r.input.source_refs).toEqual(["https://example.com/design-review"]);
    expect(r.input.body).not.toContain("## Consequences");
  });

  // A `### X` line starts a field exactly when X is the next field's label.
  test("a ### line that is not the next field's label stays in the value", () => {
    const r = parseIssueForm(form("Decision", "_No response_", "CTX\n\n### Background\n\nmore"));
    expect(body(r)).toBe("\n## Context\n\nCTX\n\n### Background\n\nmore\n\n## Decision\n\nMAIN\n");
  });

  test("### Title inside Context does not overwrite the title", () => {
    const r = parseIssueForm(form("Decision", "_No response_", "CTX\n\n### Title\n\nFake\n\nafter"));
    if ("error" in r) throw new Error(r.error);
    expect(r.input.title).toBe("T");
    expect(r.input.body).toContain("CTX\n\n### Title\n\nFake\n\nafter");
  });

  test("a body missing a field heading is an error naming it", () => {
    expect(parseIssueForm(form("Decision").replace("### Consequences\n\n_No response_\n\n", ""))).toEqual({ error: "missing field heading 'Consequences'" });
  });

  test("a missing required field is an error naming its label", () => {
    expect(parseIssueForm(form("Decision").replace("### Title\n\nT\n\n", "### Title\n\n_No response_\n\n"))).toEqual({ error: "missing required field 'Title'" });
  });

  test("a _No response_ required field counts as missing", () => {
    expect(parseIssueForm(form("Decision").replace("\nS\n", "\n_No response_\n"))).toEqual({ error: "missing required field 'Summary'" });
  });

  test("a PolicyRule's main text goes under ## Policy Rule", () => {
    expect(body(parseIssueForm(form("PolicyRule")))).toBe("\n## Context\n\nCTX\n\n## Policy Rule\n\nMAIN\n");
  });

  test("a Context appends main under its one heading", () => {
    expect(body(parseIssueForm(form("Context")))).toBe("\n## Context\n\nCTX\n\nMAIN\n");
  });

  test("a non-empty Consequences section is kept", () => {
    const r = parseIssueForm(form("Decision", "C1"));
    expect(body(r)).toBe("\n## Context\n\nCTX\n\n## Decision\n\nMAIN\n\n## Consequences\n\nC1\n");
  });
});
