import { appendGap, findMarkers } from "./init.ts";

export const CONNECT_BEGIN = "<!-- ltm:connect:begin -->";
export const CONNECT_END = "<!-- ltm:connect:end -->";

const BEGIN_LINE = new RegExp(`^${CONNECT_BEGIN}\\r?$`);
const END_LINE = new RegExp(`^${CONNECT_END}\\r?$`);
const LABEL = "ltm:connect";

/** `section` is the Org memory lines joined with "\n", ending in "\n". */
export function connectRegion(section: string): string {
  return `${CONNECT_BEGIN}\n\n${section}\n${CONNECT_END}\n`;
}

export function spliceConnectRegion(fileText: string | null, region: string): string {
  if (fileText === null || fileText === "") return region;
  const span = findMarkers(fileText, BEGIN_LINE, END_LINE, LABEL);
  if (span === null) return `${fileText}${appendGap(fileText)}${region}`;
  if ("malformed" in span) throw new Error(span.malformed);
  // Appending here would leave two begin markers.
  if (span.endStart === null) throw new Error("the ltm:connect begin marker has no matching end marker");
  // The region carries its own end-marker line, so consume the old one through its terminator.
  const nl = fileText.indexOf("\n", span.endStart);
  const after = nl === -1 ? fileText.length : nl + 1;
  return `${fileText.slice(0, span.beginStart)}${region}${fileText.slice(after)}`;
}
