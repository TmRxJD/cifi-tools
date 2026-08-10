#!/bin/bash
# =============================================================================
#  Build Linux packages for CIFI Bridge.
#
#  Linux has no SmartScreen/Gatekeeper equivalent - a .deb/.rpm installed by the
#  distro's own package manager raises no security warning at all.
#
#  Usage:  ./build-packages.sh [version]
#  Output: dist/cifi-bridge_<version>_all.deb
#          dist/cifi-bridge-<version>.noarch.rpm   (when rpmbuild is available)
#
#  Requires: fpm (gem install fpm).
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "$here/../.." && pwd)"
version="${1:-$(node -p "require('$pkg_root/package.json').version")}"
build="$here/.build"
dist="$pkg_root/dist"

rm -rf "$build"
mkdir -p "$build/usr/bin" "$build/usr/share/cifi-bridge" "$dist"

install -m 0755 "$here/cifi-bridge-launch.sh" "$build/usr/bin/cifi-bridge-launch"
install -m 0644 "$pkg_root/LICENSE" "$build/usr/share/cifi-bridge/LICENSE" 2>/dev/null || true
install -m 0644 "$pkg_root/README.md" "$build/usr/share/cifi-bridge/README.md" 2>/dev/null || true

mkdir -p "$build/usr/share/applications"
cat > "$build/usr/share/applications/cifi-bridge.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=CIFI Bridge
Comment=Local save finder for CIFI HunterSim
Exec=cifi-bridge-launch
Terminal=true
Categories=Utility;
DESKTOP

if ! command -v fpm >/dev/null 2>&1; then
  echo "fpm not found. Install it with:  gem install fpm"
  exit 1
fi

common=(
  -s dir -C "$build"
  --name cifi-bridge
  --version "$version"
  --architecture all
  --maintainer "CIFI Tools"
  --url "https://github.com/TmRxJD/cifi-tools"
  --description "Local save finder for CIFI HunterSim"
  --after-install "$here/postinstall.sh"
  --force
)

fpm "${common[@]}" -t deb -p "$dist/cifi-bridge_${version}_all.deb" .
echo "Built: $dist/cifi-bridge_${version}_all.deb"

if command -v rpmbuild >/dev/null 2>&1; then
  fpm "${common[@]}" -t rpm -p "$dist/cifi-bridge-${version}.noarch.rpm" .
  echo "Built: $dist/cifi-bridge-${version}.noarch.rpm"
else
  echo "rpmbuild not available - skipped the .rpm"
fi
