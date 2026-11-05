import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// qmd's default config path, minus QMD_CONFIG_DIR and named indexes, which the tests don't use.
export const getConfigPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qmd", "index.yml");
export const configExists = () => existsSync(getConfigPath());
// Same walk-up as qmd 2.8.3's, so a test can put a project-local .qmd/ config above the worker's cwd.
export function findLocalConfigPath(startDir = process.cwd()) {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    for (const name of ["index.yaml", "index.yml"]) if (existsSync(join(dir, ".qmd", name))) return join(dir, ".qmd", name);
    if (dirname(dir) === dir) return undefined;
  }
}
export const getLocalDbPath = (configPath) => join(dirname(configPath), "index.sqlite");
let source;
export const setConfigSource = ({ configPath } = {}) => {
  source = configPath;
};
// Only the embed model, the one gated field the tests exercise.
export const loadConfig = () => ({ models: { embed: /^\s+embed:\s*(\S+)/m.exec(readFileSync(source ?? getConfigPath(), "utf8"))?.[1] } });
