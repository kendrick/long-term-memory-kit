#!/usr/bin/env bash
# Publishes the packages scripts/build-npm.ts wrote to dist/npm/. Usage: publish-npm.sh [--dry-run]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
placeholder="CHANGE-ME-BEFORE-PUBLISH"
dry_run=""
case "${1:-}" in
  "") ;;
  --dry-run) dry_run="--dry-run" ;;
  *) echo "usage: publish-npm.sh [--dry-run]" >&2; exit 2 ;;
esac

scope="$(sed -n 's/.*"NPM_SCOPE_NAME"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/npm/config.json")"
[ -n "$scope" ] || { echo "publish-npm: no NPM_SCOPE_NAME in npm/config.json" >&2; exit 1; }

# Nobody owns the placeholder scope, so a real publish would fail at npm or land under a scope someone else claims first. The Release doesn't wait on npm, so exit 0 with a notice instead of failing every tag run, and do it before any npm command, whatever NPM_TOKEN holds.
if [ "$scope" = "$placeholder" ]; then
  if [ -z "$dry_run" ]; then
    echo "::notice::npm publishing is off until NPM_SCOPE_NAME in npm/config.json names a real scope; skipping."
    exit 0
  fi
  # npm rejects the uppercase placeholder as a package name, so a dry run rebuilds under a throwaway scope.
  bun "$root/scripts/build-npm.ts" --scope ltm-local
fi

out="$root/dist/npm"
[ -f "$out/ltm/package.json" ] || { echo "publish-npm: $out/ltm is missing; run scripts/build-npm.ts first" >&2; exit 1; }

# Platform packages first, so the main package never points at optionalDependencies that don't exist yet.
for dir in "$out"/ltm-*/ "$out/ltm/"; do
  (cd "$dir" && npm publish --access public $dry_run)
done
