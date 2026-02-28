#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd -- "${APP_DIR}/.." && pwd)"

SRC_SVG="${ROOT_DIR}/assets/truss.svg"
BUILD_DIR="${APP_DIR}/build"
PUBLIC_DIR="${APP_DIR}/public"
ICON_SET_DIR="${BUILD_DIR}/icons"

if [[ ! -f "${SRC_SVG}" ]]; then
  echo "Source SVG not found: ${SRC_SVG}" >&2
  exit 1
fi

mkdir -p "${BUILD_DIR}" "${PUBLIC_DIR}" "${ICON_SET_DIR}"

render_png() {
  local size="$1"
  local out="$2"

  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "${size}" -h "${size}" -o "${out}" "${SRC_SVG}"
    return 0
  fi

  if command -v magick >/dev/null 2>&1; then
    magick -background none "${SRC_SVG}" -resize "${size}x${size}" "${out}"
    return 0
  fi

  if command -v convert >/dev/null 2>&1; then
    convert -background none "${SRC_SVG}" -resize "${size}x${size}" "${out}"
    return 0
  fi

  echo "No SVG renderer found (need rsvg-convert, magick, or convert)." >&2
  exit 1
}

render_png 1024 "${BUILD_DIR}/icon.png"
cp -f "${BUILD_DIR}/icon.png" "${PUBLIC_DIR}/icon.png"

for size in 16 24 32 48 64 128 256 512; do
  render_png "${size}" "${ICON_SET_DIR}/${size}x${size}.png"
done

echo "Generated icons from ${SRC_SVG}"
