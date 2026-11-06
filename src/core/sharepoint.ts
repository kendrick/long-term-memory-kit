import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byCodeUnit, firstLine } from "./text.ts";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// The override exists for tests. Plain http is allowed only on loopback so a real token never crosses the network in clear text.
export function graphBase(env: Record<string, string | undefined>): string | { error: string } {
  const raw = env.LTM_GRAPH_BASE_URL;
  if (!raw) return GRAPH_BASE;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: `LTM_GRAPH_BASE_URL is not a URL: ${raw}` };
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return raw.replace(/\/+$/, "");
  return { error: `LTM_GRAPH_BASE_URL must use https://, or http:// on 127.0.0.1 or localhost: ${raw}` };
}

// Site and drive ids go in verbatim because Graph site ids carry commas that must stay literal; the CLI rejects ids with URL metacharacters.
export function uploadUrl(base: string, site: string, drive: string, folder: string, name: string): string {
  const path = [...folder.split("/").filter(Boolean), name].map(encodeURIComponent).join("/");
  return `${base}/sites/${site}/drives/${drive}/root:/${path}:/content`;
}

export function listUploads(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort(byCodeUnit);
}

export type UploadResult = { sent: string[]; failed: { name: string; reason: string }[] };

// Every file uploads every run, changed or not: the scheduled workflow decides whether to call this at all.
export async function uploadAll(opts: {
  base: string;
  token: string;
  site: string;
  drive: string;
  folder: string;
  dir: string;
  names: string[];
  fetch?: typeof fetch;
}): Promise<UploadResult> {
  const send = opts.fetch ?? fetch;
  const result: UploadResult = { sent: [], failed: [] };
  for (const name of opts.names) {
    try {
      const res = await send(uploadUrl(opts.base, opts.site, opts.drive, opts.folder, name), {
        method: "PUT",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/octet-stream" },
        body: readFileSync(join(opts.dir, name)),
      });
      // Drain the body so keep-alive sockets get reused. statusText is left out of the reason since a server controls it.
      await res.arrayBuffer().catch(() => {});
      if (res.ok) result.sent.push(name);
      else result.failed.push({ name, reason: `HTTP ${res.status}` });
    } catch (err) {
      // A runtime error message can echo request details; scrub the token in case one ever does.
      const msg = firstLine(err instanceof Error ? err.message : String(err));
      result.failed.push({ name, reason: opts.token ? msg.replaceAll(opts.token, "[token]") : msg });
    }
  }
  return result;
}
