# shellcheck shell=sh
# Sourced, not run, so the install.sh that #155 adds can share these with
# bin/ltm-launch. Keep it POSIX sh, since that install.sh has to run under dash,
# and keep it to function definitions so sourcing it does nothing by itself.
# POSIX has no `local`, so the helpers' variables use _ltm_ names.

LTM_INSTALL_URL=https://github.com/kendrick/long-term-memory-kit#install

ltm_asset() {
  _ltm_s=$(uname -s)
  _ltm_m=$(uname -m)
  case "$_ltm_s" in
    Darwin) _ltm_os=darwin ;;
    Linux) _ltm_os=linux ;;
    *) _ltm_os= ;;
  esac
  case "$_ltm_m" in
    arm64 | aarch64) _ltm_arch=arm64 ;;
    x86_64 | amd64) _ltm_arch=x64 ;;
    *) _ltm_arch= ;;
  esac
  if [ -z "$_ltm_os" ] || [ -z "$_ltm_arch" ]; then
    echo "ltm: unsupported platform $_ltm_s/$_ltm_m; see $LTM_INSTALL_URL" >&2
    return 1
  fi
  echo "ltm-$_ltm_os-$_ltm_arch"
}

ltm_sha256() {
  # Prints nothing when neither tool exists, so the caller can name the problem.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# ltm_fetch <tag> <dest>
ltm_fetch() {
  _ltm_asset=$(ltm_asset) || return 1
  _ltm_base=${LTM_RELEASE_BASE_URL:-https://github.com/kendrick/long-term-memory-kit/releases/download}
  _ltm_url="$_ltm_base/$1/$_ltm_asset"
  _ltm_sums_url="$_ltm_base/$1/SHA256SUMS"
  # Same dir as dest so the final mv is a rename: dest is either absent or a
  # verified binary, never a half-written one the next start would run.
  _ltm_tmp=$(mktemp "$(dirname "$2")/.ltm-fetch.XXXXXX") || return 1
  trap 'rm -f "$_ltm_tmp"; exit 1' HUP INT TERM

  if ! curl -fsL -o "$_ltm_tmp" "$_ltm_url"; then
    _ltm_fail "download failed: $_ltm_url"
    return 1
  fi
  if ! _ltm_sums=$(curl -fsL "$_ltm_sums_url"); then
    _ltm_fail "download failed: $_ltm_sums_url"
    return 1
  fi
  # Exact match on the name field, so ltm-linux-x64 can't pick up a line for
  # some longer name that merely starts with it.
  _ltm_want=$(printf '%s\n' "$_ltm_sums" | awk -v a="$_ltm_asset" '$2 == a { print $1; exit }')
  if [ -z "$_ltm_want" ]; then
    _ltm_fail "no SHA256SUMS line for $_ltm_asset at $_ltm_sums_url"
    return 1
  fi
  _ltm_got=$(ltm_sha256 "$_ltm_tmp")
  if [ -z "$_ltm_got" ]; then
    _ltm_fail "no sha256sum or shasum found"
    return 1
  fi
  if [ "$_ltm_got" != "$_ltm_want" ]; then
    _ltm_fail "checksum mismatch for $_ltm_asset"
    return 1
  fi
  if ! chmod 755 "$_ltm_tmp" || ! mv -f "$_ltm_tmp" "$2"; then
    _ltm_fail "could not install $2"
    return 1
  fi
  trap - HUP INT TERM
}

_ltm_fail() {
  rm -f "$_ltm_tmp"
  trap - HUP INT TERM
  echo "ltm: $1; see $LTM_INSTALL_URL" >&2
}
