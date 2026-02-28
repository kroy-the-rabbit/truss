#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTDIR="${ROOT}/release"
ICON_SVG="${ROOT}/assets/kube-commander.svg"
ICON_PNG="${ROOT}/app/build/icon.png"

GO_VERSION="${GO_VERSION:-1.25}"
NODE_VERSION="${NODE_VERSION:-22}"

# Pick arch: x64 | arm64 | both
ARCH="${1:-both}"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1" >&2; exit 1; }; }

need_cmd docker
need_cmd mkdir
need_cmd rm
need_cmd id

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

mkdir -p "${OUTDIR}"
mkdir -p "$(dirname "${ICON_PNG}")"
mkdir -p "${ROOT}/.cache/npm" "${ROOT}/.cache/electron" "${ROOT}/.cache/electron-builder" "${ROOT}/.home"

# -------------------------
# npm helper (robust)
# -------------------------
npm_cmd_in_app() {
  if [[ -s "${ROOT}/app/package-lock.json" || -s "${ROOT}/app/npm-shrinkwrap.json" ]]; then
    echo "npm ci"
  else
    echo "npm install --package-lock --no-audit"
  fi
}

# -------------------------
# Icon export (SVG -> PNG)
# -------------------------
if command -v inkscape >/dev/null 2>&1; then
  inkscape "${ICON_SVG}" --export-type=png --export-filename="${ICON_PNG}" -w 1024 -h 1024
elif command -v rsvg-convert >/dev/null 2>&1; then
  # Note: librsvg may warn on some SVG filters (e.g., feDropShadow). Prefer inkscape if possible.
  rsvg-convert -w 1024 -h 1024 -o "${ICON_PNG}" "${ICON_SVG}"
else
  echo "Need inkscape or rsvg-convert to export PNG from SVG." >&2
  echo "  Fedora: sudo dnf install -y inkscape   # or: librsvg2-tools" >&2
  exit 1
fi

# -------------------------
# Build backend (Go, linux)
# -------------------------
goarch_for() {
  case "$1" in
    x64)   echo "amd64" ;;
    arm64) echo "arm64" ;;
    *) echo "Unknown ARCH '$1' (expected x64|arm64)" >&2; exit 1 ;;
  esac
}

build_backend() {
  local a="$1"
  local goarch
  goarch="$(goarch_for "${a}")"

  local outdir="${ROOT}/backend/bin/linux/${a}"
  mkdir -p "${outdir}"

  echo "==> Building backend linux/${a} (GOARCH=${goarch})"

  docker run --rm -t \
    -v "${ROOT}:/work:Z" -w /work \
    "golang:${GO_VERSION}" \
    bash -lc "
      set -euo pipefail

      # golang:1.25 has go at /usr/local/go/bin/go but doesn't include it in PATH
      export PATH=/usr/local/go/bin:\$PATH

      echo '==> Go preflight:'
      command -v go
      go version

      cd backend
      # Adjust if your main package lives elsewhere
      if [[ -d ./cmd/kubed ]]; then
        PKG=./cmd/kubed
      else
        PKG=.
      fi

      # -buildvcs=false avoids 'error obtaining VCS status' in container builds
      CGO_ENABLED=0 GOOS=linux GOARCH=${goarch} \
        go build -buildvcs=false -trimpath -ldflags='-s -w' \
        -o /work/backend/bin/linux/${a}/kubed \${PKG}

      file /work/backend/bin/linux/${a}/kubed || true
    "
}

# -------------------------
# Cleanup (handles root-owned leftovers)
# -------------------------
cleanup_as_user() {
  docker run --rm -t \
    --user "${HOST_UID}:${HOST_GID}" \
    -e HOME=/work/.home \
    -e XDG_CACHE_HOME=/work/.cache \
    -v "${ROOT}:/work:Z" -w /work \
    alpine:latest \
    sh -lc "rm -rf app/dist app/release || true"
}

cleanup_as_root_and_fix_owner() {
  echo "==> Permission issue detected; performing root cleanup + chown"
  docker run --rm -t \
    -v "${ROOT}:/work:Z" -w /work \
    alpine:latest \
    sh -lc "
      set -e
      rm -rf app/dist app/release app/node_modules
      chown -R ${HOST_UID}:${HOST_GID} app .cache .home || true
    "
}

echo "==> Cleaning previous artifacts"
if ! cleanup_as_user; then
  cleanup_as_root_and_fix_owner
fi

# Ensure node_modules is writable; if not, remove it as root and chown back.
docker run --rm -t \
  --user "${HOST_UID}:${HOST_GID}" \
  -e HOME=/work/.home \
  -e XDG_CACHE_HOME=/work/.cache \
  -v "${ROOT}:/work:Z" -w /work \
  alpine:latest \
  sh -lc 'test ! -d app/node_modules || test -w app/node_modules' \
  || cleanup_as_root_and_fix_owner

# -------------------------
# Build frontend (Node)
# -------------------------
build_frontend() {
  local cmd
  cmd="$(npm_cmd_in_app)"
  echo "==> Building frontend (using: ${cmd})"

  docker run --rm -t \
    --user "${HOST_UID}:${HOST_GID}" \
    -e HOME=/work/.home \
    -e XDG_CACHE_HOME=/work/.cache \
    -e NPM_CONFIG_CACHE=/work/.cache/npm \
    -e ELECTRON_CACHE=/work/.cache/electron \
    -e ELECTRON_BUILDER_CACHE=/work/.cache/electron-builder \
    -v "${ROOT}:/work:Z" -w /work \
    "node:${NODE_VERSION}" \
    bash -lc "
      set -euo pipefail
      mkdir -p /work/.home /work/.cache/npm /work/.cache/electron /work/.cache/electron-builder
      echo '==> Container preflight:'
      ls -la /work/app/package-lock.json || true
      cd app
      ${cmd}
      npm run build
    "
}

# -------------------------
# Package AppImage (Electron)
# -------------------------
package_appimage() {
  local a="$1"
  local cmd
  cmd="$(npm_cmd_in_app)"
  echo "==> Packaging AppImage (${a}) (using: ${cmd})"

  docker run --rm -t \
    --user "${HOST_UID}:${HOST_GID}" \
    -e CI=true \
    -e HOME=/work/.home \
    -e XDG_CACHE_HOME=/work/.cache \
    -e NPM_CONFIG_CACHE=/work/.cache/npm \
    -e ELECTRON_CACHE=/work/.cache/electron \
    -e ELECTRON_BUILDER_CACHE=/work/.cache/electron-builder \
    -v "${ROOT}:/work:Z" -w /work \
    electronuserland/builder:latest \
    bash -lc "
      set -euo pipefail
      mkdir -p /work/.home /work/.cache/npm /work/.cache/electron /work/.cache/electron-builder
      echo '==> Container preflight:'
      ls -la /work/app/package-lock.json || true
      ls -la /work/backend/bin/linux/${a}/kubed || { echo 'Missing backend binary for ${a}'; exit 1; }
      cd app
      ${cmd}
      npx electron-builder --linux AppImage --${a} --publish=never
      ls -lah dist || true
    "
}

build_frontend

if [[ "${ARCH}" == "both" || "${ARCH}" == "x64" ]]; then
  build_backend x64
  package_appimage x64
fi

if [[ "${ARCH}" == "both" || "${ARCH}" == "arm64" ]]; then
  build_backend arm64
  package_appimage arm64
fi

# Collect outputs (electron-builder defaults to app/dist)
if [[ -d "${ROOT}/app/dist" ]]; then
  find "${ROOT}/app/dist" -maxdepth 1 -type f -name "*.AppImage" -exec cp -v {} "${OUTDIR}/" \;
fi

echo "==> Done. AppImages in: ${OUTDIR}"
ls -lah "${OUTDIR}"/*.AppImage 2>/dev/null || echo "No AppImage found (check app/dist)."
