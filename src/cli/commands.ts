import { head } from "./head.ts";
import type { Command } from "./run.ts";

// Add new commands to this array; the dispatcher in run.ts needs no edit.
export const defaultCommands: Command[] = [head];
