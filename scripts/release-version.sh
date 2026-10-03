#!/usr/bin/env bash
# Usage: release-version.sh <tag>
# Prints SEMVER=... and DISPLAY_VERSION=... for a release tag.
#   v0.97.53d0115 -> SEMVER=0.97.0       DISPLAY_VERSION=0.97.53d0115
#   v1.2.3        -> SEMVER=1.2.3        DISPLAY_VERSION=1.2.3
# package.json needs valid semver; the display version is what the app shows.
set -euo pipefail

tag="${1:?usage: release-version.sh <tag>}"
v="${tag#v}"

# Plain semver first; an all-digit short hash is also valid semver and maps to itself.
if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "SEMVER=$v"
  echo "DISPLAY_VERSION=$v"
elif [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9a-f]{7,40})$ ]]; then
  echo "SEMVER=${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.0"
  echo "DISPLAY_VERSION=$v"
else
  echo "unsupported release tag: $tag" >&2
  exit 1
fi
