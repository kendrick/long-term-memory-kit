import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

// qmd 2.8.3's trust gate: the opt-in env vars, built-in model URIs never gated, a recorded trust from FAKE_TRUSTED.
// Path logic is copied from its dist/trust.js.
export const isLocalConfigPath = (configPath) => basename(dirname(resolve(configPath))) === ".qmd";
export const isLocalConfigTrustOptedIn = (env = process.env) => ["QMD_TRUST_LOCAL_CONFIG", "QMD_TRUST_UPDATE_HOOKS"].some((k) => !!env[k] && !["0", "false", "off", "no", "none"].includes(env[k].trim().toLowerCase()));

const projectRootFromConfig = (configPath) => dirname(dirname(resolve(configPath)));
// shortcut: no `~` expansion, tests don't use it; copy qmd's expandUserPath if one ever does.
const resolveConfigCollectionPath = (raw, configPath) => {
  const root = projectRootFromConfig(configPath);
  if (!raw) return root;
  return isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const isCollectionPathInsideProject = (configPath, raw) => {
  const rel = relative(real(projectRootFromConfig(configPath)), real(resolveConfigCollectionPath(raw, configPath)));
  return rel === "" || (!isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."));
};

export const gatedItems = (configPath, snapshot, builtins) => ({
  hooks: snapshot.hooks,
  paths: snapshot.paths.filter((p) => !isCollectionPathInsideProject(configPath, p.path)),
  models: Object.entries(snapshot.models).filter(([slot, uri]) => uri && uri !== builtins[slot]).map(([slot, uri]) => ({ slot, uri })),
});
export const hasGatedItems = (g) => g.hooks.length + g.paths.length + g.models.length > 0;
// qmd's canonical JSON of the gated items, minus its sha256, so a test's expected digest stays readable.
const byFirst = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
export const sensitiveDigest = (snapshot, configPath, builtins) => {
  const gated = gatedItems(configPath, snapshot, builtins);
  return JSON.stringify({
    hooks: gated.hooks.map((h) => [h.collection, h.command]).sort(byFirst),
    paths: gated.paths.map((p) => [p.collection, resolveConfigCollectionPath(p.path, configPath)]).sort(byFirst),
    models: gated.models.map((m) => [m.slot, m.uri]).sort(byFirst),
  });
};
export const isTrusted = (configPath, digest) => JSON.parse(process.env.FAKE_TRUSTED ?? "{}")[configPath] === digest;
