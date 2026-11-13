#!/bin/sh
# Installs ltm: with Homebrew when brew is on PATH, else this Release's binary, checked against its SHA256SUMS. This repo copy won't run as is. `curl … | sh` leaves no sibling files to source, so scripts/build-install.sh inlines bin/ltm-fetch.sh at the marker below and stamps the tag.
set -u

if command -v brew >/dev/null 2>&1; then
  # exec, so brew's exit status is ours and nothing below can run after it.
  exec brew install kendrick/tap/ltm
fi

# @ltm-fetch.sh@

# The URL is spelled out because LTM_INSTALL_URL comes from the inlined fetch script, which an unbuilt copy lacks.
if ! command -v ltm_fetch >/dev/null 2>&1; then
  echo "ltm: this install.sh is unbuilt; run sh scripts/build-install.sh <tag>, or use a Release's install.sh; see https://github.com/kendrick/long-term-memory-kit#install" >&2
  exit 1
fi

LTM_TAG=@LTM_TAG@
tag=${LTM_VERSION:-$LTM_TAG}

# Before touching disk, so an unsupported platform leaves no empty dir behind.
ltm_asset >/dev/null || exit 1

dir=${LTM_INSTALL_DIR:-$HOME/.local/bin}
if ! mkdir -p "$dir" 2>/dev/null; then
  echo "ltm: could not create $dir; see $LTM_INSTALL_URL" >&2
  exit 1
fi
ltm_fetch "$tag" "$dir/ltm" || exit 1

echo "ltm: installed $tag to $dir/ltm"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "ltm: $dir is not on your PATH; add this to your shell profile: export PATH=\"$dir:\$PATH\"" ;;
esac
