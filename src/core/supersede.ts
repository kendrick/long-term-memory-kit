import { readFileSync, writeFileSync } from "node:fs";
import { type BankConfig } from "./bank.ts";
import { isCalendarDate } from "./clock.ts";
import { canonicalFrontmatter, SCHEMA_KEY_ORDER } from "./canonical.ts";
import { listRecordFiles } from "./query.ts";
import { parseRecordFile, RecordError, splitFrontmatter } from "./record.ts";
import { firstLine } from "./text.ts";
import { sharesScope } from "./validate.ts";

export type IndexedRecord = { abs: string; rel: string; text: string; data: Record<string, unknown> };

// `records` keeps listRecordFiles' path order, which is the order edits come back in.
export type BankIndex = { records: IndexedRecord[]; byId: Map<string, IndexedRecord[]> };

export type Edit = { abs: string; rel: string; text: string };
export type Planned = { edits: Edit[] } | { refusal: string };

export function readBankIndex(config: BankConfig, onSkip: (rel: string, reason: string) => void): BankIndex {
  const records: IndexedRecord[] = [];
  const byId = new Map<string, IndexedRecord[]>();
  for (const { abs, rel, type } of listRecordFiles(config, onSkip)) {
    let text: string;
    let data: Record<string, unknown>;
    try {
      text = readFileSync(abs, "utf8");
      data = parseRecordFile(abs, rel, type).frontmatter;
    } catch (e) {
      if (e instanceof RecordError) onSkip(rel, e.message);
      else if (e instanceof Error && "code" in e) onSkip(rel, firstLine(e.message));
      else throw e;
      continue;
    }
    const rec = { abs, rel, text, data };
    records.push(rec);
    if (typeof data.id !== "string") continue;
    const held = byId.get(data.id);
    if (held) held.push(rec);
    else byId.set(data.id, [rec]);
  }
  return { records, byId };
}

// Edits land on shallow copies; every write below replaces a top-level value rather
// than mutating one, so the index stays the pre-edit truth for the body and for re-plans.
type Work = { index: BankIndex; data: Map<IndexedRecord, Record<string, unknown>>; changed: Set<IndexedRecord> };

const dataOf = (w: Work, rec: IndexedRecord): Record<string, unknown> => w.data.get(rec) ?? rec.data;

function set(w: Work, rec: IndexedRecord, key: string, value: unknown): void {
  const current = dataOf(w, rec);
  if (Object.hasOwn(current, key) && JSON.stringify(current[key]) === JSON.stringify(value)) return;
  w.data.set(rec, { ...current, [key]: value });
  w.changed.add(rec);
}

function resolveId(index: BankIndex, id: string): IndexedRecord | string {
  const held = index.byId.get(id);
  if (!held) return `'${id}' matches no Record`;
  if (held.length > 1) return `'${id}' is held by ${held.length} Records`;
  return held[0]!;
}

const hasSupersededBy = (data: Record<string, unknown>): boolean =>
  data.superseded_by !== undefined && data.superseded_by !== null && data.superseded_by !== "";

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// Follows every holder of a shared id: a cycle through any of them is still a cycle.
function reaches(w: Work, from: IndexedRecord, target: string): boolean {
  const seen = new Set<IndexedRecord>([from]);
  const queue = [from];
  while (queue.length > 0) {
    for (const id of ids(dataOf(w, queue.shift()!).supersedes)) {
      if (id === target) return true;
      for (const next of w.index.byId.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// Checks run against the working copy, so accept's later targets see edits its earlier ones planned.
function stepSupersede(w: Work, oldId: string, newId: string): string | null {
  if (oldId === newId) return `old and new are the same Record ('${oldId}')`;
  // Both ids are checked for existence, old first, before either is checked for duplicates, so resolveId can't reorder the refusals.
  if (!w.index.byId.has(oldId)) return `'${oldId}' matches no Record`;
  if (!w.index.byId.has(newId)) return `'${newId}' matches no Record`;
  const oldRec = resolveId(w.index, oldId);
  if (typeof oldRec === "string") return oldRec;
  const newRec = resolveId(w.index, newId);
  if (typeof newRec === "string") return newRec;
  const o = dataOf(w, oldRec);
  const n = dataOf(w, newRec);
  // The old Record may already point at newId (a re-run is a no-op); the new Record may not point anywhere.
  if (hasSupersededBy(o) && o.superseded_by !== newId) {
    return `${oldRec.rel} is already superseded by '${String(o.superseded_by)}'`;
  }
  if (n.status === "superseded" || hasSupersededBy(n)) return `${newRec.rel} is itself superseded`;
  if (reaches(w, oldRec, newId)) return `superseding ${oldRec.rel} with ${newRec.rel} would make a cycle`;
  if (!sharesScope(o.applies_to, n.applies_to)) return `${oldRec.rel} and ${newRec.rel} share no applies_to entry`;
  if (Object.hasOwn(n, "supersedes") && !isIdList(n.supersedes)) return `${newRec.rel}: supersedes is not a list of ids`;
  set(w, oldRec, "superseded_by", newId);
  set(w, oldRec, "status", "superseded");
  const list = (n.supersedes as string[] | undefined) ?? [];
  if (!list.includes(oldId)) set(w, newRec, "supersedes", [...list, oldId]);
  return null;
}

function render(rec: IndexedRecord, data: Record<string, unknown>): string | { refusal: string } {
  const split = splitFrontmatter(rec.text);
  // readBankIndex only admits files parseRecordFile accepted, and it requires a fence pair.
  if (!split) return { refusal: `${rec.rel}: no frontmatter` };
  const eol = rec.text.slice(0, rec.text.indexOf("\n")).endsWith("\r") ? "\r\n" : "\n";
  const fm = canonicalFrontmatter(data, SCHEMA_KEY_ORDER, eol);
  if (typeof fm !== "string") return { refusal: `${rec.rel}: ${fm.reason}` };
  const head = rec.text.slice(0, rec.text.length - split.body.length);
  return `---${eol}${fm}---${head.endsWith("\n") ? eol : ""}${split.body}`;
}

// Every refusal is decided before the first render, and every render before anything is returned to write.
function finish(w: Work): Planned {
  const edits: Edit[] = [];
  for (const rec of w.index.records) {
    if (!w.changed.has(rec)) continue;
    const text = render(rec, dataOf(w, rec));
    if (typeof text !== "string") return text;
    if (text !== rec.text) edits.push({ abs: rec.abs, rel: rec.rel, text });
  }
  return { edits };
}

const newWork = (index: BankIndex): Work => ({ index, data: new Map(), changed: new Set() });

export function planSupersede(index: BankIndex, oldId: string, newId: string): Planned {
  const w = newWork(index);
  const refusal = stepSupersede(w, oldId, newId);
  return refusal === null ? finish(w) : { refusal };
}

export function planAccept(index: BankIndex, id: string, today: string): Planned {
  const rec = resolveId(index, id);
  if (typeof rec === "string") return { refusal: rec };
  const { status, last_confirmed: confirmed, supersedes } = rec.data;
  if (status !== "proposed") return { refusal: `${rec.rel} has status '${String(status)}', not 'proposed'` };
  const hasConfirmed = Object.hasOwn(rec.data, "last_confirmed");
  if (hasConfirmed && !(typeof confirmed === "string" && isCalendarDate(confirmed))) {
    return { refusal: `${rec.rel}: last_confirmed '${String(confirmed)}' is not a YYYY-MM-DD date` };
  }
  if (Object.hasOwn(rec.data, "supersedes") && !isIdList(supersedes)) {
    return { refusal: `${rec.rel}: supersedes is not a list of ids` };
  }
  const w = newWork(index);
  set(w, rec, "status", "accepted");
  set(w, rec, "date", today);
  // YYYY-MM-DD sorts as a string, so `>` is date order; last_confirmed is a high-water mark, date is a stamp.
  set(w, rec, "last_confirmed", hasConfirmed && (confirmed as string) > today ? confirmed : today);
  for (const oldId of ids(supersedes)) {
    const refusal = stepSupersede(w, oldId, id);
    if (refusal !== null) return { refusal };
  }
  return finish(w);
}

// No rollback: a file already written can't be unwritten safely, so the caller reports what landed.
export function applyEdits(edits: Edit[]): { written: string[]; failed: { rel: string; message: string } | null } {
  const written: string[] = [];
  for (const { abs, rel, text } of edits) {
    try {
      writeFileSync(abs, text);
    } catch (e) {
      return { written, failed: { rel, message: firstLine((e as Error).message) } };
    }
    written.push(rel);
  }
  return { written, failed: null };
}
