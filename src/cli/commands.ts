import { accept } from "./accept.ts";
import { confirm } from "./confirm.ts";
import { connect } from "./connect.ts";
import { deprecate } from "./deprecate.ts";
import { discover } from "./discover.ts";
import { doctor } from "./doctor.ts";
import { facets } from "./facets.ts";
import { fmt } from "./fmt.ts";
import { head } from "./head.ts";
import { init } from "./init.ts";
import { mcp } from "./mcp.ts";
import { promote } from "./promote.ts";
import { propose } from "./propose.ts";
import { query } from "./query.ts";
import type { Command } from "./run.ts";
import { show } from "./show.ts";
import { supersede } from "./supersede.ts";
import { validate } from "./validate.ts";

// Add new commands to this array; the dispatcher in run.ts needs no edit. Each planned
// command already has a slot, so the issue that builds one edits only its own file.
export const defaultCommands: Command[] = [head, show, query, facets, validate, fmt, discover, connect, init, supersede, accept, confirm, deprecate, propose, promote, doctor, mcp];
