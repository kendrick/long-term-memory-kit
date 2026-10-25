import pkg from "../../package.json" with { type: "json" };

// The Record `schema:` values this release accepts. They change independently of package.json's version, since a release can ship without changing what a Record may declare.
export const SCHEMA_VERSIONS: readonly number[] = [1];

export const versionJson = (versions: readonly number[]): { version: string; schemas: number[] } => ({
  version: pkg.version,
  schemas: [...versions],
});
