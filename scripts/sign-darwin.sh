#!/usr/bin/env bash
# Ad-hoc re-signs the darwin binaries in a dist dir and rewrites SHA256SUMS over the new bytes. Bun's darwin cross-compile on Linux leaves an ad-hoc signature that fails `codesign --verify --strict`, and macOS 27 kills such a binary at launch (#183).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="${1:-$root/dist}"
bins=(ltm-darwin-arm64 ltm-darwin-x64)

command -v codesign >/dev/null || { echo "sign-darwin: codesign not found" >&2; exit 2; }
# Check both before signing either, so a short dist never gets half-signed with a SHA256SUMS to match.
for b in "${bins[@]}"; do
  [ -f "$dist/$b" ] || { echo "sign-darwin: missing $b in $dist" >&2; exit 2; }
done

for b in "${bins[@]}"; do codesign --force -s - "$dist/$b"; done
# --strict catches the malformed signature that plain --verify lets through.
for b in "${bins[@]}"; do codesign --verify --strict "$dist/$b"; done

# Bare file names, same as build-binaries.sh, so `sha256sum -c` runs from inside dist/ on any machine.
(cd "$dist" && shasum -a 256 ltm-* > SHA256SUMS)
cat "$dist/SHA256SUMS"
