import { discover } from "./discover.ts";
import { facets } from "./facets.ts";
import { fmt } from "./fmt.ts";
import { head } from "./head.ts";
import { query } from "./query.ts";
import type { Command } from "./run.ts";
import { validate } from "./validate.ts";

// Add new commands to this array; the dispatcher in run.ts needs no edit. Each planned
// command already has a slot, so the issue that builds one edits only its own file.
export const defaultCommands: Command[] = [head, query, facets, validate, fmt, discover];
