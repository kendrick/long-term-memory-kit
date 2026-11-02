export type FenceStep = "open" | "inside" | "close" | "text";

// CommonMark 4.5 fences. A closer repeats the opener's character at least as many times, so an inner ``` can't end a ```` block and ~~~ can't end a backtick block. A backtick opener's info string can't hold a backtick (that line is inline code), and an unclosed fence runs to EOF. Feed one line at a time, terminator stripped. The closer's trailing run is [ \t] only, as CommonMark has it, not \s.
const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export function fenceTracker(): (line: string) => FenceStep {
  let fence: { char: string; len: number } | null = null;
  return (line) => {
    if (fence) {
      const run = CLOSE.exec(line)?.[1];
      if (run && run[0] === fence.char && run.length >= fence.len) {
        fence = null;
        return "close";
      }
      return "inside";
    }
    const open = OPEN.exec(line);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      return "open";
    }
    return "text";
  };
}
