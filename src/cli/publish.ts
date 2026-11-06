import { join, resolve } from "node:path";
import { firstLine } from "../core/text.ts";
import { graphBase, listUploads, uploadAll, uploadUrl } from "../core/sharepoint.ts";
import type { Command } from "./run.ts";

// Site and drive ids are spliced into the URL verbatim, so anything that would end or reshape the path is refused.
const BAD_ID = /[/?#\s]/;

export const publish: Command = {
  name: "publish",
  summary: "Upload a Digest directory to SharePoint through Microsoft Graph",
  options: {
    site: { type: "string", description: "SharePoint site id to upload to" },
    drive: { type: "string", description: "Document library (drive) id in that site" },
    path: { type: "string", description: "Folder in the drive to put the files in" },
    "dry-run": { type: "boolean", description: "Print each upload URL and send nothing" },
  },
  positionals: [
    { name: "target", required: true },
    { name: "dir", required: true },
  ],
  // The token check lives here, not in run(), so a missing token exits 2 before any request goes out.
  checkArgs(positionals, values, env) {
    if (positionals[0] !== "sharepoint") return `unknown target '${positionals[0]}' (expected sharepoint)`;
    for (const flag of ["site", "drive", "path"] as const) {
      if (typeof values[flag] !== "string" || values[flag] === "") return `missing --${flag}`;
    }
    for (const flag of ["site", "drive"] as const) {
      if (BAD_ID.test(values[flag] as string)) return `--${flag} must not contain '/', '?', '#', or whitespace`;
    }
    const base = graphBase(env);
    if (typeof base !== "string") return base.error;
    if (values["dry-run"] !== true && !env.LTM_GRAPH_TOKEN) {
      return "LTM_GRAPH_TOKEN is not set; export an Entra app token with write access to the drive";
    }
    return undefined;
  },
  async run(ctx) {
    const dir = ctx.positionals[1]!;
    const site = ctx.values.site as string;
    const drive = ctx.values.drive as string;
    const folder = ctx.values.path as string;
    // checkArgs already rejected a bad base; the guard only narrows the type.
    const base = graphBase(ctx.env);
    if (typeof base !== "string") return 1;
    const abs = resolve(ctx.cwd, dir);
    let names: string[];
    try {
      names = listUploads(abs);
    } catch (e) {
      ctx.err(`ltm publish sharepoint: cannot read ${dir}: ${firstLine(e instanceof Error ? e.message : String(e))}\n`);
      return 1;
    }
    if (names.length === 0) {
      ctx.err(`ltm publish sharepoint: no files to upload in ${dir}\n`);
      return 1;
    }
    if (ctx.values["dry-run"] === true) {
      for (const name of names) ctx.out(`${uploadUrl(base, site, drive, folder, name)}\n`);
      return 0;
    }
    const { sent, failed } = await uploadAll({
      base,
      token: ctx.env.LTM_GRAPH_TOKEN!,
      site,
      drive,
      folder,
      dir: abs,
      names,
    });
    for (const name of sent) ctx.out(`uploaded ${name}\n`);
    for (const f of failed) ctx.err(`ltm publish sharepoint: failed ${join(dir, f.name)}: ${f.reason}\n`);
    return failed.length > 0 ? 1 : 0;
  },
};
