#!/usr/bin/env bash
# Regenerates fixtures/reflowed/<tool>/ by running each formatter at its defaults over a copy of fixtures/demo-bank.
# Exit 0 = trees rewritten, 2 = a tool binary is missing or a tool failed.
set -eu

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for tool in prettier oxfmt; do
  if [[ ! -x "$root/node_modules/.bin/$tool" ]]; then
    echo "missing $root/node_modules/.bin/$tool; run the package install first" >&2
    exit 2
  fi
done

tmps=()
trap 'rm -rf "${tmps[@]}"' EXIT

for tool in prettier oxfmt; do
  # Work outside the repo: oxfmt walks the whole working tree. pwd -P: macOS $TMPDIR is behind a /var -> /private/var symlink.
  work="$(cd "$(mktemp -d)" && pwd -P)"
  tmps+=("$work")
  mkdir "$work/bank"
  cp -R "$root/fixtures/demo-bank/." "$work/bank/"

  # oxfmt has no --no-config, so it gets an empty config kept outside the copied tree.
  case "$tool" in
    prettier) cmd=("$root/node_modules/.bin/prettier" --no-config --no-editorconfig --write .) ;;
    oxfmt)
      echo '{}' > "$work/empty.json"
      cmd=("$root/node_modules/.bin/oxfmt" -c "$work/empty.json" .) ;;
  esac
  if ! (cd "$work/bank" && "${cmd[@]}" >/dev/null); then
    echo "$tool failed" >&2
    exit 2
  fi

  rm -rf "$root/fixtures/reflowed/$tool"
  mkdir -p "$root/fixtures/reflowed/$tool"
  cp -R "$work/bank/." "$root/fixtures/reflowed/$tool/"
done
