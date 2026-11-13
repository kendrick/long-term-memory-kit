#!/bin/sh
# Prints the shippable install.sh for <tag>: bin/ltm-fetch.sh inlined at the marker line and the tag stamped in.
set -eu

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: sh scripts/build-install.sh <tag>" >&2
  exit 1
fi
root=$(dirname "$0")/..

awk -v tag="$1" -v fetch="$root/bin/ltm-fetch.sh" '
  $0 == "# @ltm-fetch.sh@" {
    while ((r = (getline line < fetch)) > 0) if (line != "# shellcheck shell=sh") print line
    if (r < 0) { print "build-install.sh: cannot read " fetch > "/dev/stderr"; exit 1 }
    next
  }
  { gsub(/@LTM_TAG@/, tag); print }
' "$root/install.sh"
