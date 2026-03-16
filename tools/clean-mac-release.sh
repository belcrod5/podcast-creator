#!/bin/sh
set -eu

release_root="${1:-release}"

for target in \
  "$release_root/Podcast Creator-darwin-arm64" \
  "$release_root/Podcast Creator-darwin-x64"
do
  if [ -e "$target" ]; then
    rm -rf "$target"
    printf 'Removed %s\n' "$target"
  fi
done
