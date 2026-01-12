#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is macOS only (requires sips/iconutil)." >&2
  exit 1
fi

SRC="${1:-}"
OUT="${2:-}"

if [[ -z "$SRC" || -z "$OUT" ]]; then
  echo "Usage: $0 <source.png> <output.icns>" >&2
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "Source file not found: $SRC" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$ROOT_DIR/tmp-iconset.$$"
ICONSET_DIR="$TMP_DIR/AppIcon.iconset"

cleanup() {
  if [[ "${KEEP_TMP_ICONSET:-0}" == "1" ]]; then
    echo "Kept tmp dir: $TMP_DIR" >&2
    return 0
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$ICONSET_DIR"

make_icon() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$SRC" --out "$ICONSET_DIR/$name" >/dev/null
}

make_icon 16 "icon_16x16.png"
make_icon 32 "icon_16x16@2x.png"
make_icon 32 "icon_32x32.png"
make_icon 64 "icon_32x32@2x.png"
make_icon 128 "icon_128x128.png"
make_icon 256 "icon_128x128@2x.png"
make_icon 256 "icon_256x256.png"
make_icon 512 "icon_256x256@2x.png"
make_icon 512 "icon_512x512.png"
make_icon 1024 "icon_512x512@2x.png"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
iconutil -c icns "$ICONSET_DIR" -o "$OUT"

echo "Wrote: $OUT"

