// Agent-answer eval, pure half: reads a `claude -p --output-format stream-json --verbose` transcript and scores it on cited Record ids (issue #26). No spawning, no fs access; the runner lands in this file later behind `import.meta.main`.
import { isAbsolute, relative } from "node:path";

export type Style = "single-hop" | "multi-session" | "temporal" | "knowledge-update" | "abstention";

export type Question = {
  id: string;
  style: Style;
  question: string;
  gold_ids: string[];
  forbidden_ids: string[];
  gold_files: string[];
};

export type Transcript = {
  answer: string;
  /** null when the final line has no `CITED:` line; `[]` for `CITED: NONE`. */
  cited: string[] | null;
  /** Bank-relative paths whose content entered the agent's context. */
  filesRead: string[];
};

export type Score = { correct: boolean; fileRecall: number | null };

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown };

const MCP_HEAD = "mcp__plugin_ltm_ltm__head";
const MCP_QUERY = "mcp__plugin_ltm_ltm__query";

const toText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n") : "";

// Absolute paths under the staged Bank copy collapse to the Bank-relative form `ltm query --json` prints.
function normalize(p: string, bankRoot: string): string {
  const q = p.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
  if (!isAbsolute(q)) return q;
  const rel = relative(bankRoot, q);
  return rel.startsWith("..") ? q : rel;
}

const args = (rest: string) => rest.split(/\s+/).filter((t) => t !== "" && !t.startsWith("-"));

// `ltm query --json` prints {results:[{path}]}; the MCP tool's text content is the human `bank:path  type ...` lines.
function queryPaths(result: string): string[] {
  try {
    const parsed = JSON.parse(result) as unknown;
    const rows = Array.isArray(parsed) ? parsed : (parsed as { results?: unknown }).results;
    if (Array.isArray(rows)) return rows.flatMap((r) => (typeof r?.path === "string" ? [r.path] : []));
  } catch {}
  return [...result.matchAll(/^(?:[^\s:]+:)?(\S+\.md)\s{2}/gm)].map((m) => m[1] as string);
}

function pathsRead(name: string, input: Record<string, unknown>, result: string): string[] {
  if (name === "Read") return typeof input.file_path === "string" ? [input.file_path] : [];
  if (name === MCP_HEAD) return typeof input.path === "string" ? [input.path] : [];
  if (name === MCP_QUERY) return queryPaths(result);
  if (name === "Bash" && typeof input.command === "string") {
    const cmd = input.command.trim();
    const cat = /^cat\s+(.+)$/.exec(cmd);
    if (cat) return args(cat[1] as string);
    const head = /^ltm head\s+(.+)$/.exec(cmd);
    if (head) return args(head[1] as string);
    if (/^ltm query\b/.test(cmd) && /(^|\s)--json(\s|$)/.test(cmd)) return queryPaths(result);
  }
  return [];
}

export function extractAnswer(streamJson: string, bankRoot: string): Transcript {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const read = new Set<string>();
  let final = "";
  for (const line of streamJson.split("\n")) {
    if (line.trim() === "") continue;
    let ev: { type?: string; result?: unknown; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "result" && typeof ev.result === "string") final = ev.result;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (ev.type === "assistant" && b.type === "tool_use" && b.id) calls.set(b.id, { name: b.name ?? "", input: b.input ?? {} });
      if (ev.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        const call = calls.get(b.tool_use_id);
        if (call) for (const p of pathsRead(call.name, call.input, toText(b.content))) read.add(normalize(p, bankRoot));
      }
    }
  }
  const lines = final.split("\n");
  const at = lines.findLastIndex((l) => l.startsWith("CITED: "));
  const last = at < 0 ? undefined : (lines[at] as string).slice(7).trim();
  const cited = last === undefined || last === "" ? null : last === "NONE" ? [] : last.split(",").map((s) => s.trim()).filter(Boolean);
  return { answer: lines.filter((_, i) => i !== at).join("\n").trim(), cited, filesRead: [...read] };
}

// Correctness reads only the CITED line, never the prose.
export function scoreAnswer(q: Question, t: Transcript): Score {
  const abstain = q.style === "abstention";
  const cited = t.cited;
  const correct =
    cited === null ? false
    : abstain ? cited.length === 0
    : q.gold_ids.every((id) => cited.includes(id)) && !q.forbidden_ids.some((id) => cited.includes(id));
  const fileRecall = abstain || q.gold_files.length === 0 ? null : q.gold_files.filter((f) => t.filesRead.includes(f)).length / q.gold_files.length;
  return { correct, fileRecall };
}
