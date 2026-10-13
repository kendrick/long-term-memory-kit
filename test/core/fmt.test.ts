import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { formatRecordText, liftStatus, newId, type FmtResult } from "../../src/core/fmt.ts";
import { splitFrontmatter } from "../../src/core/record.ts";

const NYGARD_BODY =
  "# 1. Record architecture decisions\n\nDate: 2026-01-01\n\n## Status\n\nAccepted\n\n## Context\n\nWe need to record the architectural decisions made on this project.\n";

const ctx = (over: Partial<Parameters<typeof formatRecordText>[1]> = {}) => ({
  folderType: "Decision" as const,
  statusAliases: [] as string[],
  takenIds: new Set<string>(),
  ...over,
});

type Ok = Exclude<FmtResult, { reason: string }>;

function ok(r: FmtResult): Ok {
  if ("reason" in r) throw new Error(`unexpected refusal: ${r.reason}`);
  return r;
}

function refused(r: FmtResult): string {
  if (!("reason" in r)) throw new Error(`expected a refusal, got:\n${r.text}`);
  return r.reason;
}

const bodyOf = (text: string): string => {
  const s = splitFrontmatter(text);
  if (!s) throw new Error("no frontmatter in output");
  return s.body;
};

const fmOf = (text: string): Record<string, unknown> => {
  const s = splitFrontmatter(text);
  if (!s) throw new Error("no frontmatter in output");
  return parse(s.frontmatterLines.join("\n")) as Record<string, unknown>;
};

const BASE_FM = "schema: 1\nid: abcdefghij\nmemory_type: Decision\ntitle: Record architecture decisions\n";

describe("status-lift falsifier", () => {
  test("no frontmatter status, body ## Status / Accepted: lifts accepted", () => {
    const input = `---\n${BASE_FM}---\n${NYGARD_BODY}`;
    const r = ok(formatRecordText(input, ctx()));
    expect(r.text).toBe(
      "---\nschema: 1\nid: abcdefghij\nmemory_type: Decision\ntitle: Record architecture decisions\nstatus: accepted\n---\n" +
        NYGARD_BODY,
    );
    expect(bodyOf(r.text)).toBe(bodyOf(input));
    expect(fmOf(r.text).status).toBe("accepted");
    expect(r.changed).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test("frontmatter status: proposed wins over the body's Accepted", () => {
    const input = `---\n${BASE_FM}status: proposed\n---\n${NYGARD_BODY}`;
    const r = ok(formatRecordText(input, ctx()));
    expect(fmOf(r.text).status).toBe("proposed");
    expect(r.text).toBe(input);
    expect(bodyOf(r.text)).toBe(bodyOf(input));
    expect(r.changed).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  test("body word Approved lifts nothing and warns once", () => {
    const body = NYGARD_BODY.replace("\nAccepted\n", "\nApproved\n");
    expect(body).not.toBe(NYGARD_BODY);
    const input = `---\n${BASE_FM}---\n${body}`;
    const r = ok(formatRecordText(input, ctx()));
    expect(Object.hasOwn(fmOf(r.text), "status")).toBe(false);
    expect(r.text).toBe(input);
    expect(bodyOf(r.text)).toBe(bodyOf(input));
    expect(r.warnings).toEqual(["## Status word 'approved' is not a status; nothing lifted"]);
  });
});

test("formatRecordText lifts Superseded by ADR-0007 as superseded, body untouched", () => {
  const body = NYGARD_BODY.replace("\nAccepted\n", "\nSuperseded by ADR-0007\n");
  const input = `---\n${BASE_FM}---\n${body}`;
  const r = ok(formatRecordText(input, ctx()));
  expect(r.text).toBe(`---\n${BASE_FM}status: superseded\n---\n${body}`);
  expect(bodyOf(r.text)).toBe(bodyOf(input));
});

describe("liftStatus", () => {
  test("Superseded by ADR-0007 lifts as superseded", () => {
    expect(liftStatus("## Status\n\nSuperseded by ADR-0007\n", [])).toEqual({ status: "superseded", word: "superseded" });
  });

  test("trailing punctuation is stripped and case folded", () => {
    expect(liftStatus("### STATUS\nDeprecated.\n", [])).toEqual({ status: "deprecated", word: "deprecated" });
  });

  test("a ## Status inside a ~~~ fence doesn't count", () => {
    const body = "# T\n\n~~~md\n## Status\n\nAccepted\n~~~\n\nText.\n";
    expect(liftStatus(body, [])).toEqual({ status: null, word: null });
  });

  test("a fence closes only on the same character, at least as long", () => {
    const body = "~~~~\n```\n~~~\n## Status\nAccepted\n~~~~\n## Status\n\nRejected\n";
    expect(liftStatus(body, [])).toEqual({ status: "rejected", word: "rejected" });
  });

  test("with aliases [State], a ## State heading counts", () => {
    const body = "## State\n\nProposed\n";
    expect(liftStatus(body, ["State"])).toEqual({ status: "proposed", word: "proposed" });
    expect(liftStatus(body, [])).toEqual({ status: null, word: null });
  });

  test("an empty Status section before the next heading gives no word", () => {
    expect(liftStatus("## Status\n\n## Context\n\nAccepted\n", [])).toEqual({ status: null, word: null });
  });

  test("CRLF bodies lift the same", () => {
    expect(liftStatus("## Status\r\n\r\nAccepted\r\n", [])).toEqual({ status: "accepted", word: "accepted" });
  });
});

describe("id", () => {
  test("a missing id is generated, well-formed and not taken", () => {
    const taken = new Set(["abcdefghij"]);
    const input = "---\nschema: 1\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n";
    const r = ok(formatRecordText(input, ctx({ takenIds: taken })));
    const id = fmOf(r.text).id;
    expect(typeof id).toBe("string");
    expect(id as string).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(id).not.toBe("abcdefghij");
    expect(r.text).toBe(`---\nschema: 1\nid: ${id}\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n`);
  });

  test("an existing id: weird! is kept", () => {
    const input = "---\nschema: 1\nid: weird!\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n";
    const r = ok(formatRecordText(input, ctx()));
    expect(r.text).toBe(input);
    expect(fmOf(r.text).id).toBe("weird!");
  });

  test("newId records what it returns, so consecutive calls on one set never collide", () => {
    const taken = new Set<string>();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = newId(taken);
      expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
      expect(seen.has(id)).toBe(false);
      expect(taken.has(id)).toBe(true);
      seen.add(id);
    }
    expect(taken.size).toBe(2000);
  });

  test("two Records formatted against one set get distinct ids", () => {
    const taken = new Set<string>();
    const input = "---\nschema: 1\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n";
    const a = fmOf(ok(formatRecordText(input, ctx({ takenIds: taken }))).text).id;
    const b = fmOf(ok(formatRecordText(input, ctx({ takenIds: taken }))).text).id;
    expect(a).not.toBe(b);
    expect(taken).toEqual(new Set([a as string, b as string]));
  });
});

describe("memory_type", () => {
  test("missing in the Decision folder gives memory_type: Decision", () => {
    const input = "---\nschema: 1\nid: abcdefghij\nstatus: accepted\n---\nBody.\n";
    const r = ok(formatRecordText(input, ctx()));
    expect(r.text).toBe("---\nschema: 1\nid: abcdefghij\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n");
    expect(r.warnings).toEqual([]);
  });

  test("Context in the Decision folder is kept, with one warning naming both", () => {
    const input = "---\nschema: 1\nid: abcdefghij\nmemory_type: Context\nstatus: accepted\n---\nBody.\n";
    const r = ok(formatRecordText(input, ctx()));
    expect(r.text).toBe(input);
    expect(r.warnings).toEqual(["memory_type is 'Context' but the file is in the Decision folder"]);
  });

  test("missing schema gets schema: 1", () => {
    const input = "---\nid: abcdefghij\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n";
    expect(ok(formatRecordText(input, ctx())).text).toBe(
      "---\nschema: 1\nid: abcdefghij\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n",
    );
  });
});

describe("no frontmatter at all", () => {
  test("a plain Nygard ADR gets a new block and stays whole after it", () => {
    const r = ok(formatRecordText(NYGARD_BODY, ctx()));
    const fm = fmOf(r.text);
    expect(fm.schema).toBe(1);
    expect(fm.id as string).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(fm.memory_type).toBe("Decision");
    expect(fm.status).toBe("accepted");
    expect(r.text).toBe(`---\nschema: 1\nid: ${fm.id}\nmemory_type: Decision\nstatus: accepted\n---\n${NYGARD_BODY}`);
    const close = r.text.indexOf("---\n", 4);
    expect(r.text.slice(close + 4)).toBe(NYGARD_BODY);
    expect(bodyOf(r.text)).toBe(NYGARD_BODY);
    expect(r.changed).toBe(true);
  });

  test("a CRLF file without frontmatter gets a CRLF block", () => {
    const crlf = NYGARD_BODY.replaceAll("\n", "\r\n");
    const r = ok(formatRecordText(crlf, ctx()));
    const id = fmOf(r.text).id;
    expect(r.text).toBe(`---\r\nschema: 1\r\nid: ${id}\r\nmemory_type: Decision\r\nstatus: accepted\r\n---\r\n${crlf}`);
  });
});

describe("line endings", () => {
  test("a CRLF Record's rewritten frontmatter is CRLF and its body is unchanged", () => {
    const body = "Line one.\r\n\r\nLine two\nmixed.\r\n";
    const input = `---\r\nstatus: accepted\r\nid: abcdefghij\r\nmemory_type: Decision\r\nschema: 1\r\n---\r\n${body}`;
    const r = ok(formatRecordText(input, ctx()));
    expect(r.text).toBe(`---\r\nschema: 1\r\nid: abcdefghij\r\nmemory_type: Decision\r\nstatus: accepted\r\n---\r\n${body}`);
    const head = r.text.slice(0, r.text.length - body.length);
    const lines = head.split("\n").slice(0, -1);
    expect(lines.length).toBe(6);
    for (const line of lines) expect(line.endsWith("\r")).toBe(true);
    expect(bodyOf(r.text)).toBe(body);
  });

  test("a closing fence at EOF without a terminator stays without one", () => {
    const input = "---\nid: abcdefghij\nschema: 1\nmemory_type: Decision\nstatus: accepted\n---";
    const r = ok(formatRecordText(input, ctx()));
    expect(r.text).toBe("---\nschema: 1\nid: abcdefghij\nmemory_type: Decision\nstatus: accepted\n---");
  });
});

describe("refusals", () => {
  const good = "schema: 1\nid: abcdefghij\nmemory_type: Decision\nstatus: accepted\n";

  test("# a comment inside the frontmatter", () => {
    expect(refused(formatRecordText(`---\n${good}# a comment\n---\nBody.\n`, ctx()))).toMatch(/comment/);
    expect(refused(formatRecordText(`---\n# a comment\n${good}---\nBody.\n`, ctx()))).toMatch(/comment/);
    expect(refused(formatRecordText(`---\nschema: 1 # trailing\n---\nBody.\n`, ctx()))).toMatch(/comment/);
  });

  test("unparseable YAML", () => {
    refused(formatRecordText("---\ntitle: [unclosed\n---\nBody.\n", ctx()));
    refused(formatRecordText("---\nid: a\nid: b\n---\nBody.\n", ctx()));
  });

  test("an unterminated opening fence", () => {
    expect(refused(formatRecordText(`---\n${good}Body with no closing fence.\n`, ctx()))).toBe("unterminated frontmatter");
    expect(refused(formatRecordText("---", ctx()))).toBe("unterminated frontmatter");
  });

  test("a nested object", () => {
    refused(formatRecordText(`---\n${good}nested:\n  a: 1\n---\nBody.\n`, ctx()));
    refused(formatRecordText(`---\n${good}tags: [[1]]\n---\nBody.\n`, ctx()));
  });

  test("a non-mapping document", () => {
    refused(formatRecordText("---\n- a\n- b\n---\nBody.\n", ctx()));
  });

  test("a leading byte order mark", () => {
    refused(formatRecordText(`\uFEFF---\n${good}---\nBody.\n`, ctx()));
  });

  test("a number spelled non-canonically is refused, not rewritten", () => {
    const fm = (line: string) => `---\n${good}${line}\n---\nBody.\n`;
    expect(refused(formatRecordText("---\nschema: 1\nid: 0123\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n", ctx()))).toBe(
      "id: '0123' would be rewritten as '123'; quote it or write it canonically",
    );
    expect(refused(formatRecordText(fm("version: 1.50"), ctx()))).toBe(
      "version: '1.50' would be rewritten as '1.5'; quote it or write it canonically",
    );
    expect(refused(formatRecordText(fm("title: 12345678901234567890"), ctx()))).toBe(
      "title: '12345678901234567890' would be rewritten as '12345678901234567000'; quote it or write it canonically",
    );
    expect(refused(formatRecordText(fm("mask: 0x1F"), ctx()))).toBe(
      "mask: '0x1F' would be rewritten as '31'; quote it or write it canonically",
    );
    expect(refused(formatRecordText(fm("n: 1e3"), ctx()))).toBe(
      "n: '1e3' would be rewritten as '1000'; quote it or write it canonically",
    );
    expect(refused(formatRecordText(fm("tags: [a, 0123]"), ctx()))).toBe(
      "tags: '0123' would be rewritten as '123'; quote it or write it canonically",
    );
  });

  test("numbers already in canonical spelling pass unchanged", () => {
    const input = `---\n${good}count: 2\noffset: -3\nratio: 1.5\n---\nBody.\n`;
    const r = ok(formatRecordText(input, ctx()));
    expect(r.changed).toBe(false);
    expect(r.text).toBe(input);
  });

  test("a quoted number-like id is a string and passes untouched", () => {
    const input = "---\nschema: 1\nid: \"0123\"\nmemory_type: Decision\nstatus: accepted\n---\nBody.\n";
    const r = ok(formatRecordText(input, ctx()));
    expect(r.changed).toBe(false);
  });

  test("booleans and nulls respell canonically, since no value is lost", () => {
    const r = ok(formatRecordText(`---\n${good}a: True\nb: ~\n---\nBody.\n`, ctx()));
    expect(r.text).toBe(`---\n${good}a: true\nb: null\n---\nBody.\n`);
  });

  test("a refusal leaves takenIds alone", () => {
    const taken = new Set<string>();
    refused(formatRecordText("---\nschema: 1\n# c\n---\nBody.\n", ctx({ takenIds: taken })));
    expect(taken.size).toBe(0);
  });
});

describe("idempotence", () => {
  const inputs: Record<string, string> = {
    "lifted ADR": `---\n${BASE_FM}---\n${NYGARD_BODY}`,
    "plain ADR": NYGARD_BODY,
    "shuffled with extras": "---\ndeciders: [alice, bob]\ntags:\n  - b\n  - a\ntitle: \"a: b\"\nmemory_type: Context\n---\nBody.\n",
    CRLF: "---\r\ntags: [x]\r\nschema: 1\r\n---\r\nBody.\r\n",
    "no closing terminator": "---\nid: abcdefghij\n---",
    "empty file": "",
  };
  for (const [name, input] of Object.entries(inputs)) {
    test(name, () => {
      const taken = new Set<string>();
      const once = ok(formatRecordText(input, ctx({ takenIds: taken })));
      const twice = ok(formatRecordText(once.text, ctx({ takenIds: taken })));
      expect(twice.changed).toBe(false);
      expect(twice.text).toBe(once.text);
    });
  }
});
