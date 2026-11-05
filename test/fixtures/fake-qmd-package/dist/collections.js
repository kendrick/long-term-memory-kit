import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// qmd's default config path, minus QMD_CONFIG_DIR and named indexes, which the tests don't use.
export const getConfigPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qmd", "index.yml");
export const configExists = () => existsSync(getConfigPath());
