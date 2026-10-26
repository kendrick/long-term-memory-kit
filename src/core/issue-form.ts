import { MEMORY_TYPES, type MemoryType } from "./bank.ts";
import { templateBody, type ProposalInput } from "./propose.ts";

// One list for the parser and templates/github/ISSUE_TEMPLATE/ltm-proposal.yml; a test holds the two equal so a rename on either side fails.
export const ISSUE_FORM_FIELDS = [
  { id: "type", label: "Memory type", required: true },
  { id: "title", label: "Title", required: true },
  { id: "summary", label: "Summary", required: true },
  { id: "facets", label: "Facets", required: true },
  { id: "context", label: "Context", required: true },
  { id: "main", label: "Decision, rule, or exception", required: true },
  { id: "consequences", label: "Consequences", required: false },
  { id: "sources", label: "Source links", required: false },
] as const;

type FieldId = (typeof ISSUE_FORM_FIELDS)[number]["id"];

// GitHub renders a blank optional textarea as this literal.
const NO_RESPONSE = "_No response_";

const lines = (s: string | undefined): string[] =>
  (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

// Read from templateBody so the headings can't drift from the type's template.
const headings = (type: MemoryType): string[] =>
  [...templateBody(type).matchAll(/^## (.+)$/gm)].map((m) => m[1]!);

export type IssueFormResult = { input: Omit<ProposalInput, "source_refs"> & { source_refs: string[] } } | { error: string };

export function parseIssueForm(text: string): IssueFormResult {
  const values = new Map<FieldId, string>();
  let current: FieldId | undefined;
  let buf: string[] = [];
  let next = 0;
  const flush = () => {
    if (current === undefined) return;
    const v = buf.join("\n").trim();
    if (v !== "" && v !== NO_RESPONSE) values.set(current, v);
  };
  // Only the next field's heading opens a field; any other `### ` line is the submitter's own text inside a value.
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const field = ISSUE_FORM_FIELDS[next];
    if (field !== undefined && line.trim() === `### ${field.label}`) {
      flush();
      current = field.id;
      buf = [];
      next++;
    } else buf.push(line);
  }
  flush();

  // GitHub renders every field, blank optional ones as _No response_, so a missing heading means a hand-edited body.
  if (next < ISSUE_FORM_FIELDS.length) return { error: `missing field heading '${ISSUE_FORM_FIELDS[next]!.label}'` };
  for (const f of ISSUE_FORM_FIELDS) {
    if (f.required && !values.has(f.id)) return { error: `missing required field '${f.label}'` };
  }
  const type = values.get("type")!;
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    return { error: `unknown memory type '${type}' (expected ${MEMORY_TYPES.join(", ")})` };
  }
  const memoryType = type as MemoryType;

  const [contextHeading, mainHeading] = headings(memoryType);
  const sections: [string, string][] = [];
  const context = values.get("context")!;
  const main = values.get("main")!;
  if (mainHeading === undefined) sections.push([contextHeading!, `${context}\n\n${main}`]);
  else sections.push([contextHeading!, context], [mainHeading, main]);
  const consequences = values.get("consequences");
  if (consequences !== undefined) sections.push(["Consequences", consequences]);

  return {
    input: {
      type: memoryType,
      title: values.get("title")!,
      summary: values.get("summary")!,
      applies_to: lines(values.get("facets")),
      source_refs: lines(values.get("sources")),
      body: "\n" + sections.map(([h, t]) => `## ${h}\n\n${t}\n`).join("\n"),
    },
  };
}
