#!/usr/bin/env bash
# Runs a compiled ltm against a copy of fixtures/demo-bank where neither node nor bun exists, proving the binary stands alone.
# Linux binaries run in debian:bookworm-slim under Docker. Darwin binaries can't run in a container, so they run on the host under `env -i` with a PATH that holds no node or bun.
set -euo pipefail

bin="${1:?usage: smoke-binary.sh <dist/ltm-os-arch>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
[ -x "$bin" ] || { echo "smoke-binary: $bin isn't an executable file" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$root/fixtures/demo-bank" "$tmp/bank"

cat > "$tmp/steps.sh" <<'STEPS'
#!/bin/sh
# $1 is the ltm binary, $2 the Bank copy. Each failure exits non-zero and names its step.
ltm="$1"
cd "$2" || exit 2
fail() { echo "smoke: FAIL $*" >&2; exit 1; }

if command -v node || command -v bun; then
  echo "smoke: FAIL no-runtime: node or bun is on PATH ($PATH)" >&2
  exit 90
fi
echo "smoke: ok no-runtime (no node or bun on PATH)"

"$ltm" --version || fail "--version"
"$ltm" validate || fail "validate"

out="$("$ltm" query --type Decision --json)" || fail "query"
case "$out" in
  "[]"*) fail "query: returned no Decisions" ;;
  "["*) echo "smoke: ok query" ;;
  *) fail "query: output isn't a JSON array: $out" ;;
esac

"$ltm" head _memory/decisions/postgres-everywhere-kQ7vN2xLp4.md || fail "head"

# Keep stdin open until the tools/list reply lands, so EOF can't shut the server down before it answers.
mkfifo "$TMPDIR/mcp-in"
LTM_BANK_PATH="$2" "$ltm" mcp < "$TMPDIR/mcp-in" > "$TMPDIR/mcp-out" &
pid=$!
exec 3> "$TMPDIR/mcp-in"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' >&3
i=0
until grep -q '"id":2' "$TMPDIR/mcp-out"; do
  i=$((i + 1))
  [ "$i" -le 150 ] || { kill "$pid"; cat "$TMPDIR/mcp-out" >&2; fail "mcp: no tools/list reply in 30 s"; }
  sleep 0.2
done
# The server need not exit on EOF (the darwin build keeps running), so stop it once the reply is in.
exec 3>&-
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
reply="$(grep '"id":2' "$TMPDIR/mcp-out")"
for tool in query head facets validate propose; do
  printf '%s' "$reply" | grep -q "\"$tool\"" || fail "mcp: tools/list lacks $tool"
done
echo "smoke: ok mcp (query head facets validate propose)"
echo "smoke: PASS"
STEPS

case "$(basename "$bin")" in
  ltm-linux-x64) platform=linux/amd64 ;;
  ltm-linux-arm64) platform=linux/arm64 ;;
  ltm-darwin-*) platform="" ;;
  *) echo "smoke-binary: can't tell the platform of $(basename "$bin")" >&2; exit 2 ;;
esac

if [ -n "$platform" ]; then
  mkdir "$tmp/t"
  docker run --rm --platform "$platform" \
    -v "$bin:/usr/local/bin/ltm:ro" -v "$tmp:/smoke" -e TMPDIR=/smoke/t \
    debian:bookworm-slim sh /smoke/steps.sh /usr/local/bin/ltm /smoke/bank
else
  mkdir "$tmp/home" "$tmp/t"
  env -i PATH=/usr/bin:/bin HOME="$tmp/home" TMPDIR="$tmp/t" sh "$tmp/steps.sh" "$bin" "$tmp/bank"
fi
