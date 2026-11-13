// Prints the Homebrew formula for a release, with each platform's sha256 taken from that release's SHA256SUMS.
// Usage: bun scripts/homebrew-formula.ts <version> <SHA256SUMS-path>. Exits 2 on bad usage or when a platform asset has no checksum.
import { readFileSync } from "node:fs";

const REPO = "https://github.com/kendrick/long-term-memory-kit";

// Asset names must match build-binaries.sh's uploads exactly, because the SHA256SUMS lookup keys on them.
const PLATFORMS = [
  { os: "macos", arch: "arm", asset: "ltm-darwin-arm64" },
  { os: "macos", arch: "intel", asset: "ltm-darwin-x64" },
  { os: "linux", arch: "arm", asset: "ltm-linux-arm64" },
  { os: "linux", arch: "intel", asset: "ltm-linux-x64" },
] as const;

// Keyed by exact file name so line order and extra assets (the Windows .exe) can't move a hash.
function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/.exec(line);
    if (m) sums.set(m[2]!, m[1]!.toLowerCase());
  }
  return sums;
}

export function homebrewFormula(version: string, sha256sums: string): string {
  const bare = version.replace(/^v/, "");
  const sums = parseSums(sha256sums);
  const missing = PLATFORMS.filter((p) => !sums.has(p.asset)).map((p) => p.asset);
  // An empty sha256 would make brew fail at install time on users' machines, so fail here instead.
  if (missing.length > 0) throw new Error(`SHA256SUMS has no entry for ${missing.join(", ")}`);

  const block = (os: string) =>
    PLATFORMS.filter((p) => p.os === os)
      .map(
        (p) => `    on_${p.arch} do
      url "${REPO}/releases/download/v${bare}/${p.asset}"
      sha256 "${sums.get(p.asset)}"
    end`,
      )
      .join("\n");

  return `class Ltm < Formula
  desc "Org-level memory for coding agents: query a Bank, hydrate Proposals, and promote decisions"
  homepage "${REPO}"
  version "${bare}"
  license "MIT"

  on_macos do
${block("macos")}
  end

  on_linux do
${block("linux")}
  end

  def install
    bin.install Dir["ltm-*"].first => "ltm"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ltm --version")
  end
end
`;
}

if (import.meta.main) {
  const [version, sumsPath, ...rest] = process.argv.slice(2);
  if (!version || !sumsPath || rest.length > 0) {
    console.error("usage: bun scripts/homebrew-formula.ts <version> <SHA256SUMS-path>");
    process.exit(2);
  }
  try {
    process.stdout.write(homebrewFormula(version, readFileSync(sumsPath, "utf8")));
  } catch (e) {
    console.error(`homebrew-formula: ${(e as Error).message}`);
    process.exit(2);
  }
}
