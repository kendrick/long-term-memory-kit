import { basename, dirname, resolve } from "node:path";

// qmd 2.8.3's trust gate cut down to models: the opt-in env vars, built-in URIs never gated, a recorded trust from FAKE_TRUSTED.
export const isLocalConfigPath = (configPath) => basename(dirname(resolve(configPath))) === ".qmd";
export const isLocalConfigTrustOptedIn = (env = process.env) => ["QMD_TRUST_LOCAL_CONFIG", "QMD_TRUST_UPDATE_HOOKS"].some((k) => !!env[k] && !["0", "false", "off", "no", "none"].includes(env[k].trim().toLowerCase()));
export const gatedItems = (_configPath, snapshot, builtins) => ({
  hooks: snapshot.hooks,
  paths: [],
  models: Object.entries(snapshot.models).filter(([slot, uri]) => uri && uri !== builtins[slot]).map(([slot, uri]) => ({ slot, uri })),
});
export const hasGatedItems = (g) => g.hooks.length + g.paths.length + g.models.length > 0;
export const sensitiveDigest = (snapshot) => JSON.stringify(snapshot.models);
export const isTrusted = (configPath, digest) => JSON.parse(process.env.FAKE_TRUSTED ?? "{}")[configPath] === digest;
