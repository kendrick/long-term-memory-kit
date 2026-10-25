#!/usr/bin/env bash
# Cross-compiles ltm for every release target into dist/, plus a SHA256SUMS that `cd dist && sha256sum -c SHA256SUMS` checks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/dist"
rm -rf "$dist"
mkdir -p "$dist"

# The x64 targets use Bun's -baseline builds so the binary runs on CPUs without AVX2 (spike #2).
targets=(
  "bun-linux-x64-baseline:ltm-linux-x64"
  "bun-linux-arm64:ltm-linux-arm64"
  "bun-darwin-x64-baseline:ltm-darwin-x64"
  "bun-darwin-arm64:ltm-darwin-arm64"
  "bun-windows-x64-baseline:ltm-windows-x64.exe"
)

for t in "${targets[@]}"; do
  target="${t%%:*}"
  name="${t#*:}"
  echo "build-binaries: $name ($target)"
  bun build --compile --target="$target" "$root/src/cli/bin.ts" --outfile "$dist/$name"
done

if command -v sha256sum >/dev/null; then
  sum=(sha256sum)
else
  sum=(shasum -a 256)
fi
# Bare file names, not paths, so the check runs from inside dist/ on any machine.
(cd "$dist" && "${sum[@]}" ltm-* > SHA256SUMS)
cat "$dist/SHA256SUMS"
