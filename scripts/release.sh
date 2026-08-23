#!/usr/bin/env bash
# chita release script (cur-099 F1: each platform compiles SEPARATELY —
# `--target=bun` only produces the host's executable; one compile CANNOT be
# renamed into five assets)
#
# Usage:
#   scripts/release.sh v0.1.0        # bump VERSION, compile 5 targets, create
#                                    # GitHub release + upload assets + SHA256SUMS
#
# Requires: bun, gh (authenticated), jq not needed.
# The VERSION constant in packages/cli/src/index.ts MUST equal the tag minus
# the leading 'v' (cur-099 F6) — this script enforces it before building.

set -euo pipefail

TAG="${1:?usage: scripts/release.sh vX.Y.Z}"
VERSION_NUM="${TAG#v}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
PKG="$ROOT/packages/cli/src/index.ts"

# --- 1. enforce VERSION == tag (cur-099 F6) -------------------------------
grep -q "export const VERSION = \"$VERSION_NUM\";" "$PKG" || {
  echo "error: packages/cli/src/index.ts VERSION != $VERSION_NUM (tag). Bump it first." >&2
  exit 1
}

# --- 2. compile all five targets (each its own asset name) -----------------
TARGETS=(
  "bun-darwin-arm64:chita-darwin-arm64"
  "bun-darwin-x64:chita-darwin-x64"
  "bun-linux-arm64:chita-linux-arm64"
  "bun-linux-x64:chita-linux-x64"
  "bun-windows-x64:chita-windows-x64.exe"
)

mkdir -p "$DIST"
ASSETS=()
for pair in "${TARGETS[@]}"; do
  target="${pair%%:*}"
  name="${pair##*:}"
  echo "==> building $name ($target)"
  bun build --compile --target="$target" \
    "$ROOT/packages/cli/src/index.ts" \
    --outfile "$DIST/$name"
  ASSETS+=("$DIST/$name")
done

# --- 3. SHA256SUMS for integrity verification (cur-099 F5) -----------------
# shasum (macOS) vs sha256sum (Linux) — pick whatever exists on the release box
SUM_CMD=""
for c in shasum sha256sum; do
  if command -v "$c" >/dev/null 2>&1; then SUM_CMD="$c"; break; fi
done
if [ -z "$SUM_CMD" ]; then
  echo "error: neither shasum nor sha256sum found" >&2
  exit 1
fi
(
  cd "$DIST"
  if [ "$SUM_CMD" = "shasum" ]; then
    shasum -a 256 "${ASSETS[@]##*/}" > SHA256SUMS
  else
    sha256sum "${ASSETS[@]##*/}" > SHA256SUMS
  fi
)
ASSETS+=("$DIST/SHA256SUMS")

# --- 4. create release + upload --------------------------------------------
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists" >&2
  exit 1
fi
git tag "$TAG"
git push origin "$TAG"

gh release create "$TAG" \
  --repo luxuguang-leo/chita-agent \
  --title "chita $TAG" \
  --notes "chita $TAG — see CHANGELOG / commit history." \
  "${ASSETS[@]}"

echo "==> released $TAG with $((${#ASSETS[@]})) assets"
