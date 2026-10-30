import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
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

// `base` is the text the edit was planned from, so a write can tell when another command changed the file in between.
export type Edit = { abs: string; rel: string; base: string; text: string };
export type Planned = { edits: Edit[] } | { refusal: string };

export function readBankIndex(config: BankConfig, onSkip: (rel: string, reason: string) => void): BankIndex {
  const records: IndexedRecord[] = [];
  const byId = new Map<string, IndexedRecord[]>();
  for (const { abs, rel, type } of listRecordFiles(config, onSkip)) {
    let text: string;
    let data: Record<string, unknown>;
    try {
      text = fs.readFileSync(abs, "utf8");
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
  // A proposed or retired new Record would retire the old one with nothing accepted in its place.
  // planAccept stamps its Proposal accepted in the working copy before this runs, so accept passes.
  if (n.status !== "accepted") return `${newRec.rel} has status '${String(n.status)}', not 'accepted'`;
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
    if (text !== rec.text) edits.push({ abs: rec.abs, rel: rec.rel, base: rec.text, text });
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
  // Queries treat an accepted Record as active, so accepting one that still points at a successor would leave it live and retired at once.
  if (hasSupersededBy(rec.data)) return { refusal: `${rec.rel} is already superseded by '${String(rec.data.superseded_by)}'` };
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

export type StampTarget = { id: string } | { rel: string };

// Stamps are for live Records only: a Proposal has its own path (accept), and a retired one has nothing left to confirm or retire.
export function planStamp(index: BankIndex, targets: StampTarget[], change: "confirm" | "deprecate", today: string): Planned {
  const w = newWork(index);
  for (const target of targets) {
    const rec = "id" in target ? resolveId(index, target.id) : index.records.find((r) => r.rel === target.rel) ?? `${target.rel} is not a Record in the Bank`;
    if (typeof rec === "string") return { refusal: rec };
    const { status, last_confirmed: confirmed } = rec.data;
    if (status === "proposed") return { refusal: `${rec.rel} is a Proposal; accept it with ltm accept` };
    if (status !== "accepted") return { refusal: `${rec.rel} has status '${String(status)}', not 'accepted'` };
    if (change === "deprecate") {
      set(w, rec, "status", "deprecated");
      continue;
    }
    const hasConfirmed = Object.hasOwn(rec.data, "last_confirmed");
    if (hasConfirmed && !(typeof confirmed === "string" && isCalendarDate(confirmed))) {
      return { refusal: `${rec.rel}: last_confirmed '${String(confirmed)}' is not a YYYY-MM-DD date` };
    }
    // Same high-water mark as planAccept; a repeated target re-sets the same value, which `set` drops.
    set(w, rec, "last_confirmed", hasConfirmed && (confirmed as string) > today ? confirmed : today);
  }
  return finish(w);
}

export type EditFs = Pick<typeof fs, "accessSync" | "chmodSync" | "readFileSync" | "renameSync" | "statSync" | "unlinkSync" | "writeFileSync">;

const failure = (rel: string, e: unknown) => ({ rel, message: firstLine((e as Error).message) });

function unlinkAll(io: EditFs, paths: string[]): void {
  for (const path of paths) {
    try {
      io.unlinkSync(path);
    } catch {
      // A leftover temp is clutter, not a Bank change; the reported failure matters more.
    }
  }
}

// A Supersession spans two files, so an I/O error partway must not leave half of it on disk. Every edit is staged
// before any target changes, and a failed rename restores the targets already renamed. A kill mid-rename can still split it.
// `written` lists files left changed on disk, which is only ever a target whose restore also failed.
// `io` exists so tests can fail a rename, which no file mode can provoke once staging has passed.
// `nonce` exists so tests can predict a temp name and plant something there first.
export function applyEdits(
  edits: Edit[],
  io: EditFs = fs,
  nonce: () => string = () => randomBytes(6).toString("hex"),
): { written: string[]; failed: { rel: string; message: string } | null } {
  const staged: { abs: string; rel: string; tmp: string; original: Buffer }[] = [];
  for (const { abs, rel, base, text } of edits) {
    let tmp: string | undefined;
    try {
      // rename ignores the target's own mode, so a read-only Record would be replaced without this check.
      io.accessSync(abs, fs.constants.W_OK);
      const original = io.readFileSync(abs);
      // Each render is a whole file, so renaming one planned from stale text would drop whatever a concurrent ltm command wrote there. The window between this check and the rename stays open; closing it would take a Bank lock.
      if (original.toString("utf8") !== base) throw new Error("changed on disk since it was read; run the command again");
      // The basename stays out of the temp name, since a Record name near NAME_MAX plus a suffix would fail with ENAMETOOLONG.
      tmp = join(dirname(abs), `.ltm-${nonce()}.tmp`);
      // A cloned Bank can plant a symlink at a temp path; plain write would follow it and truncate the file behind it.
      io.writeFileSync(tmp, text, { flag: "wx" });
      // The temp file gets the umask's mode, and rename carries that over the target, so a private 0600 Record would come out 0644. writeFileSync's mode option is also filtered by the umask, hence chmod.
      io.chmodSync(tmp, io.statSync(abs).mode & 0o7777);
      staged.push({ abs, rel, tmp, original });
    } catch (e) {
      // EEXIST means the path was someone else's before we tried, so it isn't ours to delete.
      const ours = tmp !== undefined && (e as NodeJS.ErrnoException).code !== "EEXIST";
      unlinkAll(io, [...staged.map((s) => s.tmp), ...(ours ? [tmp!] : [])]);
      return { written: [], failed: failure(rel, e) };
    }
  }
  for (const [i, { rel, tmp, abs }] of staged.entries()) {
    try {
      io.renameSync(tmp, abs);
    } catch (e) {
      const written: string[] = [];
      for (const done of staged.slice(0, i)) {
        try {
          io.writeFileSync(done.abs, done.original);
        } catch {
          written.push(done.rel);
        }
      }
      unlinkAll(io, staged.slice(i).map((s) => s.tmp));
      return { written, failed: failure(rel, e) };
    }
  }
  return { written: staged.map((s) => s.rel), failed: null };
}
