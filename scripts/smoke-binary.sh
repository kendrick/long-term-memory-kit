#!/usr/bin/env bash
# Runs a compiled ltm against a copy of fixtures/demo-bank where neither node nor bun exists, proving the binary stands alone.
# Linux binaries run in debian:bookworm-slim under Docker. Darwin binaries can't run in a container, so they run on the host under `env -i` with a PATH that holds no node or bun.
# macOS 27 kills a darwin binary whose signature doesn't verify, but macos-15 runners don't, so the smoke checks it explicitly (#183).
set -euo pipefail

bin="${1:?usage: smoke-binary.sh <dist/ltm-os-arch>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
[ -x "$bin" ] || { echo "smoke-binary: $bin isn't an executable file" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$root/fixtures/demo-bank" "$tmp/bank"
cp -R "$root/test/fixtures/fake-qmd-package" "$tmp/fake-qmd-package"

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

# recall.mode vector runs its qmd worker on the binary's embedded Bun (BUN_BE_BUN), so this proves the worker needs no installed bun either. The fake qmd package stands in for the real one.
bank="$2"
mkdir "$TMPDIR/qmdbin"
cat > "$TMPDIR/qmdbin/qmd" <<'QMD'
#!/bin/sh
if [ "$1" = skills ]; then printf '%s/skills\n' "$FAKE_PKG"; exit 0; fi
if [ "$1" = collection ]; then printf 'Collection: %s\n  Path:     %s\n' "$3" "$FAKE_ROOT"; exit 0; fi
exit 1
QMD
chmod +x "$TMPDIR/qmdbin/qmd"
printf '%s\n' 'doctor: { near_duplicate_threshold: 0.6 }' 'recall: { backend: qmd, mode: vector, collections: { Decision: decisions } }' >> memory-bank.yaml
vector() {
  PATH="$TMPDIR/qmdbin:$PATH" FAKE_PKG="$(dirname "$bank")/fake-qmd-package" FAKE_ROOT="$bank/_memory/decisions" \
    XDG_CONFIG_HOME="$TMPDIR/xdg" FAKE_STATUS="{\"decisions\":{\"active\":9,\"pending\":$1}}" "$ltm" doctor
}
vector 0 > /dev/null || fail "doctor vector: embedded collection didn't exit 0"
if out="$(vector 9 2>&1)"; then fail "doctor vector: unembedded collection exited 0"; fi
case "$out" in
  *"run qmd embed"*) echo "smoke: ok doctor vector (worker ran in the binary)" ;;
  *) fail "doctor vector: no qmd embed message: $out" ;;
esac
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
  # The container runs as root, so a directory it makes under the mount (qmdbin) is root-owned and the EXIT trap's rm fails on CI. Hand everything back to the caller before exiting.
  docker run --rm --platform "$platform" \
    -v "$bin:/usr/local/bin/ltm:ro" -v "$tmp:/smoke" -e TMPDIR=/smoke/t -e HOST_ID="$(id -u):$(id -g)" \
    debian:bookworm-slim sh -c 'sh /smoke/steps.sh "$@"; rc=$?; chown -R "$HOST_ID" /smoke; exit $rc' sh /usr/local/bin/ltm /smoke/bank
else
  # Runs on the host, outside `env -i`, so codesign resolves whatever PATH the caller has; a missing codesign fails too.
  codesign --verify --strict "$bin" || { echo "smoke: FAIL codesign: $bin doesn't pass codesign --verify --strict" >&2; exit 1; }
  echo "smoke: ok codesign"
  mkdir "$tmp/home" "$tmp/t"
  env -i PATH=/usr/bin:/bin HOME="$tmp/home" TMPDIR="$tmp/t" sh "$tmp/steps.sh" "$bin" "$tmp/bank"
fi
