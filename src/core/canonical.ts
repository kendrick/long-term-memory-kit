import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isMapping } from "./bank.ts";

export type Refusal = { reason: string };

// Read at runtime rather than copied in, so adding a property to the schema moves
// it into canonical order without a second edit here.
export const SCHEMA_KEY_ORDER: readonly string[] = Object.freeze(
  Object.keys(
    (JSON.parse(readFileSync(new URL("../../schema/record.schema.json", import.meta.url), "utf8")) as {
      properties: Record<string, unknown>;
    }).properties,
  ),
);

function parsesBackAs(yaml: string, key: string, expected: (v: unknown) => boolean): boolean {
  let doc: unknown;
  try {
    doc = parse(yaml);
  } catch {
    return false;
  }
  if (!isMapping(doc)) return false;
  const keys = Object.keys(doc);
  return keys.length === 1 && keys[0] === key && expected(doc[key]);
}

// A string goes out plain only when the parser every Record reader uses reads it back
// unchanged, so `123`, `true`, or `a: b` can't come back as a number, boolean, or mapping.
// JSON output is always a valid YAML double-quoted scalar.
function canonicalString(s: string, inFlow: boolean): string {
  const plain = inFlow
    ? parsesBackAs(`k: [${s}]`, "k", (v) => Array.isArray(v) && v.length === 1 && v[0] === s)
    : parsesBackAs(`k: ${s}`, "k", (v) => v === s);
  return plain ? s : JSON.stringify(s);
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return "a list";
  if (isMapping(v)) return "a mapping";
  return `a value of type ${typeof v}`;
}

export function canonicalScalar(v: unknown, inFlow: boolean): string | Refusal {
  if (v === null) return "null";
  if (typeof v === "string") return canonicalString(v, inFlow);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    // String() gives "NaN"/"Infinity", which YAML reads back as strings.
    if (Number.isNaN(v)) return ".nan";
    if (v === Infinity) return ".inf";
    if (v === -Infinity) return "-.inf";
    return Object.is(v, -0) ? "-0" : String(v);
  }
  return { reason: `${describe(v)} is not a scalar` };
}

// Keys get the same treatment as values: a key like `a: b` or `x #y` must not change
// meaning when written back.
function canonicalKey(key: string): string {
  return parsesBackAs(`${key}: x`, key, (v) => v === "x") ? key : JSON.stringify(key);
}

export function canonicalFrontmatter(
  data: Record<string, unknown>,
  keyOrder: readonly string[],
  eol: "\n" | "\r\n",
): string | Refusal {
  const present = Object.keys(data);
  const ordered = [...keyOrder.filter((k) => Object.hasOwn(data, k)), ...present.filter((k) => !keyOrder.includes(k))];
  let out = "";
  for (const key of ordered) {
    const value = data[key];
    let rendered: string;
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (const entry of value) {
        const s = canonicalScalar(entry, true);
        if (typeof s !== "string") return { reason: `${key}: list entry is ${describe(entry)}; only flat lists of scalars are supported` };
        entries.push(s);
      }
      rendered = `[${entries.join(", ")}]`;
    } else {
      const s = canonicalScalar(value, false);
      if (typeof s !== "string") return { reason: `${key}: value is ${describe(value)}; only scalars and flat lists are supported` };
      rendered = s;
    }
    out += `${canonicalKey(key)}: ${rendered}${eol}`;
  }
  return out;
}
