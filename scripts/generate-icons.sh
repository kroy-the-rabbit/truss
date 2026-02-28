#!/usr/bin/env bash
# Generate all platform icon assets from build/icon.svg.
# Requires: inkscape, imagemagick (magick), and the app-builder binary from
# electron-builder (node_modules/.bin or app-builder-bin).
#
# Usage: bash scripts/generate-icons.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO_ROOT/app/build"
PUBLIC="$REPO_ROOT/app/public"
SVG="$BUILD/icon.svg"
APP_BUILDER="$REPO_ROOT/app/node_modules/app-builder-bin/linux/x64/app-builder"

if [[ ! -f "$SVG" ]]; then
  echo "Error: $SVG not found. Place the master SVG at app/build/icon.svg first." >&2
  exit 1
fi

if ! command -v inkscape &>/dev/null; then
  echo "Error: inkscape not found. Install it first." >&2
  exit 1
fi

if ! command -v magick &>/dev/null; then
  echo "Error: imagemagick (magick) not found. Install it first." >&2
  exit 1
fi

echo "→ Rendering master 1024×1024 PNG..."
inkscape --export-type=png --export-width=1024 --export-height=1024 \
  --export-filename="$BUILD/icon.png" "$SVG" 2>/dev/null

echo "→ Copying to public/ (renderer favicon)..."
cp "$BUILD/icon.png" "$PUBLIC/icon.png"

echo "→ Rendering Linux icon set..."
mkdir -p "$BUILD/icons"
for SIZE in 16 24 32 48 64 128 256 512; do
  inkscape --export-type=png --export-width=$SIZE --export-height=$SIZE \
    --export-filename="$BUILD/icons/${SIZE}x${SIZE}.png" "$SVG" 2>/dev/null
  echo "   ${SIZE}x${SIZE}.png"
done

echo "→ Generating macOS icon.icns..."
"$APP_BUILDER" icon --format=icns -i "$BUILD/icon.png" --out "$BUILD/" 2>/dev/null
echo "   $(du -sh "$BUILD/icon.icns" | cut -f1)  icon.icns"

echo "→ Generating Windows icon.ico (multi-resolution)..."
magick \
  "$BUILD/icons/16x16.png" \
  "$BUILD/icons/24x24.png" \
  "$BUILD/icons/32x32.png" \
  "$BUILD/icons/48x48.png" \
  "$BUILD/icons/64x64.png" \
  "$BUILD/icons/128x128.png" \
  "$BUILD/icons/256x256.png" \
  "$BUILD/icon.ico"
echo "   $(du -sh "$BUILD/icon.ico" | cut -f1)  icon.ico ($(identify "$BUILD/icon.ico" 2>/dev/null | wc -l) sizes)"

echo ""
echo "Done. Generated files:"
ls -lh "$BUILD/icon.png" "$BUILD/icon.icns" "$BUILD/icon.ico"
ls -lh "$BUILD/icons/"
