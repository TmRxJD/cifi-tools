#!/bin/bash
# =============================================================================
#  Build CifiBridge.pkg (macOS installer wizard).
#  Must run on macOS - uses pkgbuild/productbuild from the Xcode CLI tools.
#
#  Usage:  ./build-pkg.sh [version]
#  Output: dist/CifiBridge-<version>.pkg
#
#  Signing (optional, removes the Gatekeeper warning):
#    export CIFI_BRIDGE_SIGN_ID="Developer ID Installer: Your Name (TEAMID)"
#  Without it the pkg is unsigned and users right-click -> Open once.
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "$here/../.." && pwd)"
version="${1:-$(node -p "require('$pkg_root/package.json').version")}"
build="$here/.build"
dist="$pkg_root/dist"

rm -rf "$build"
mkdir -p "$build/root/usr/local/share/cifi-bridge" "$build/scripts" "$dist"

# Payload is the launcher plus docs; the npm package itself is installed by
# the postinstall script.
install -m 0755 "$here/cifi-bridge-launch.command" \
  "$build/root/usr/local/share/cifi-bridge/cifi-bridge-launch.command"
install -m 0644 "$pkg_root/LICENSE" "$build/root/usr/local/share/cifi-bridge/LICENSE" 2>/dev/null || true
install -m 0644 "$pkg_root/README.md" "$build/root/usr/local/share/cifi-bridge/README.md" 2>/dev/null || true

install -m 0755 "$here/scripts/postinstall" "$build/scripts/postinstall"

pkgbuild \
  --root "$build/root" \
  --scripts "$build/scripts" \
  --identifier "com.cifihuntersim.cifi-bridge" \
  --version "$version" \
  --install-location "/" \
  "$build/component.pkg"

productbuild --package "$build/component.pkg" "$build/unsigned.pkg"

out="$dist/CifiBridge-$version.pkg"
if [ -n "${CIFI_BRIDGE_SIGN_ID:-}" ]; then
  productsign --sign "$CIFI_BRIDGE_SIGN_ID" "$build/unsigned.pkg" "$out"
  echo "Signed with: $CIFI_BRIDGE_SIGN_ID"
else
  cp "$build/unsigned.pkg" "$out"
  echo "NOTE: unsigned - users must right-click -> Open once (Gatekeeper)."
fi

rm -rf "$build"
echo "Built: $out"
