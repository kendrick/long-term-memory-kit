import { describe, expect, test } from "bun:test";
import { fenceTracker, type FenceStep } from "../../src/core/markdown.ts";

// The four copies below are the fence loops fmt, discover, validate, and promote carried at baf1929, changed only to push a FenceStep per line. They are frozen: don't "fix" one to agree with a row. If a row disagrees with a copy, the row or the tracker is the thing under question.

// fmt.ts liftStatus. "open" is pushed even inside the Status section, where the real loop returns.
const FMT_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
function fmtCopy(lines: string[]): FenceStep[] {
  const out: FenceStep[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) {
        fence = null;
        out.push("close");
      } else out.push("inside");
      continue;
    }
    const open = FMT_FENCE_OPEN.exec(line);
    if (open && !(open[1]!.startsWith("`") && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      out.push("open");
      continue;
    }
    out.push("text");
  }
  return out;
}

// discover.ts headingsOf. Its closer allows any \s after the run; the tracker allows only [ \t].
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
function discoverCopy(lines: string[]): FenceStep[] {
  const out: FenceStep[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = CLOSE_FENCE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        fence = null;
        out.push("close");
      } else out.push("inside");
      continue;
    }
    const open = OPEN_FENCE.exec(line);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      out.push("open");
      continue;
    }
    out.push("text");
  }
  return out;
}

// validate.ts headingTexts.
function validateCopy(lines: string[]): FenceStep[] {
  const out: FenceStep[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.len) {
        fence = null;
        out.push("close");
      } else out.push("inside");
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      out.push("open");
      continue;
    }
    out.push("text");
  }
  return out;
}

// promote.ts outsideFences. It reads Line.content, so the copy wraps each string.
const PROMOTE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
function promoteCopy(strings: string[]): FenceStep[] {
  const lines = strings.map((content) => ({ content }));
  const out: FenceStep[] = [];
  let opener: { char: string; len: number } | null = null;
  for (const line of lines) {
    if (opener) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line.content);
      if (close && close[1]![0] === opener.char && close[1]!.length >= opener.len) {
        opener = null;
        out.push("close");
      } else out.push("inside");
      continue;
    }
    const open = PROMOTE_FENCE_OPEN.exec(line.content);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      opener = { char: open[1]![0]!, len: open[1]!.length };
      out.push("open");
      continue;
    }
    out.push("text");
  }
  return out;
}

function track(lines: string[]): FenceStep[] {
  const step = fenceTracker();
  return lines.map((l) => step(l));
}

// Expected arrays are written out by hand from CommonMark 4.5, never computed.
const ROWS: { name: string; lines: string[]; expected: FenceStep[] }[] = [
  {
    name: "a ``` line inside a ```` fence stays inside",
    lines: ["````", "```", "text", "````", "after"],
    expected: ["open", "inside", "inside", "close", "text"],
  },
  {
    name: "a ``` line does not close a ~~~ fence",
    lines: ["~~~", "```", "~~~", "x"],
    expected: ["open", "inside", "close", "text"],
  },
  {
    name: "a closer longer than its opener closes it",
    lines: ["```", "a", "`````", "b"],
    expected: ["open", "inside", "close", "text"],
  },
  {
    name: "a backtick opener with a backtick in its info string is text",
    lines: ["```js `x`", "a"],
    expected: ["text", "text"],
  },
  {
    name: "four leading spaces is not a fence",
    lines: ["    ```", "a"],
    expected: ["text", "text"],
  },
  {
    name: "an unclosed fence runs to EOF",
    lines: ["```", "a", "b"],
    expected: ["open", "inside", "inside"],
  },
  {
    name: "a closer may carry trailing spaces and tabs",
    lines: ["```", "a", " ``` \t ", "b"],
    expected: ["open", "inside", "close", "text"],
  },
  {
    name: "a ~~~ opener with a backtick in its info string is still a fence",
    lines: ["~~~ a`b", "x", "~~~"],
    expected: ["open", "inside", "close"],
  },
];

describe("fenceTracker against the four frozen loops", () => {
  for (const row of ROWS) {
    test(row.name, () => {
      expect(track(row.lines)).toEqual(row.expected);
      expect(fmtCopy(row.lines)).toEqual(row.expected);
      expect(discoverCopy(row.lines)).toEqual(row.expected);
      expect(validateCopy(row.lines)).toEqual(row.expected);
      expect(promoteCopy(row.lines)).toEqual(row.expected);
    });
  }
});

describe("fenceTracker alone", () => {
  test("a shorter closer stays inside", () => {
    expect(track(["````", "```", "x"])).toEqual(["open", "inside", "inside"]);
  });

  test("a closer with an info string stays inside", () => {
    expect(track(["```", "``` js", "```"])).toEqual(["open", "inside", "close"]);
  });

  // The one place discover's old \s* differed from the other three: CommonMark allows only space and tab.
  test("a closer followed by a form feed stays inside", () => {
    expect(track(["```", "```\f", "x"])).toEqual(["open", "inside", "inside"]);
  });

  test("a closer followed by a vertical tab stays inside", () => {
    expect(track(["```", "```\v", "x"])).toEqual(["open", "inside", "inside"]);
  });

  test("a closer followed by a lone carriage return stays inside", () => {
    expect(track(["```", "```\r", "x"])).toEqual(["open", "inside", "inside"]);
  });

  test("a closer followed by a no-break space stays inside", () => {
    expect(track(["```", "```\u00a0", "x"])).toEqual(["open", "inside", "inside"]);
  });

  test("each tracker starts with no fence open", () => {
    track(["```"]);
    expect(track(["a"])).toEqual(["text"]);
  });
});
