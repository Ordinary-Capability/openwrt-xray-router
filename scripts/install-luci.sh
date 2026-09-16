#!/bin/sh
# Install the optional LuCI UI. Does not start or restart Xray.
set -eu
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
APP="$ROOT/luci-app-xray-router"
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
case "${1:-}" in ''|--check) ;; *) die "Usage: $0 [--check]" ;; esac
[ "$(id -u)" = 0 ] || die "run as root on OpenWrt"
[ -r /etc/openwrt_release ] || die "this installer targets OpenWrt"
[ ! -d /tmp/xray-router-ui/lock ] || die "wait for the LuCI management operation to finish before installing"
[ ! -d /tmp/xray-router-inspector/lock ] || die "stop / clean up the traffic capture before installing"
[ -d /www/luci-static/resources ] || die "install luci-base first"
[ -x /etc/init.d/rpcd ] || die "install rpcd first"
command -v lua >/dev/null 2>&1 || die "install lua, luci-lib-jsonc and luci-lib-nixio first"
lua -e 'require "luci.jsonc"; require "nixio"; require "nixio.fs"' \
    || die "install luci-lib-jsonc and luci-lib-nixio first"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required (normally provided by BusyBox)"
[ "${1:-}" != --check ] || exit 0
[ -x /usr/sbin/xrayctl ] || die "run the project's install.sh first"
mkdir -p /usr/libexec/xray-router /usr/libexec/rpcd /usr/share/rpcd/acl.d \
    /usr/share/luci/menu.d /www/luci-static/resources/xray-router /www/luci-static/resources/view
cp "$APP/root/usr/libexec/xray-router/ui.lua" /usr/libexec/xray-router/ui.lua
cp "$APP/root/usr/libexec/xray-router/node-test.lua" /usr/libexec/xray-router/node-test.lua
cp "$APP/root/usr/libexec/xray-router/inspector.lua" /usr/libexec/xray-router/inspector.lua
cp "$APP/root/usr/libexec/xray-router/inspector-runtime.lua" /usr/libexec/xray-router/inspector-runtime.lua
cp "$APP/root/usr/libexec/rpcd/luci.xray-router" /usr/libexec/rpcd/luci.xray-router
cp "$APP/root/usr/libexec/rpcd/luci.xray-inspector" /usr/libexec/rpcd/luci.xray-inspector
cp "$APP/root/usr/share/rpcd/acl.d/luci-app-xray-router.json" /usr/share/rpcd/acl.d/
cp "$APP/htdocs/luci-static/resources/xray-router/model.js" /www/luci-static/resources/xray-router/
cp "$APP/htdocs/luci-static/resources/xray-router/inspector.js" /www/luci-static/resources/xray-router/
cp "$APP/htdocs/luci-static/resources/xray-router/style.css" /www/luci-static/resources/xray-router/
cp "$APP/htdocs/luci-static/resources/view/xray-router.js" /www/luci-static/resources/view/
cp "$APP/htdocs/luci-static/resources/view/xray-router-inspector.js" /www/luci-static/resources/view/
# LuCI keys JS requests by its own release version, which does not change when
# this app is updated. Give every app asset a content-versioned URL instead.
# Keep previous bundles available for pages already open during an upgrade.
RESOURCES="$APP/htdocs/luci-static/resources"
ASSET_VERSION="v$(cat "$0" "$RESOURCES/view/xray-router.js" \
    "$RESOURCES/view/xray-router-inspector.js" "$RESOURCES/xray-router/model.js" \
    "$RESOURCES/xray-router/inspector.js" "$RESOURCES/xray-router/style.css" \
    | sha256sum | cut -c1-16)"
ASSET_DIR="/www/luci-static/resources/xray-router/$ASSET_VERSION"
mkdir -p "$ASSET_DIR"
cp "$RESOURCES/xray-router/model.js" "$RESOURCES/xray-router/style.css" "$ASSET_DIR/"
version_assets() {
    sed -e "s/require xray-router\./require xray-router.$ASSET_VERSION./g" \
        -e "s|xray-router/style.css|xray-router/$ASSET_VERSION/style.css|g" "$1" > "$2"
    chmod 0644 "$2"
}
version_assets "$RESOURCES/xray-router/inspector.js" "$ASSET_DIR/inspector.js"
for view in xray-router xray-router-inspector; do
    version_assets "$RESOURCES/view/$view.js" "/www/luci-static/resources/view/$view-$ASSET_VERSION.js"
done
chmod 0644 "$ASSET_DIR/model.js" "$ASSET_DIR/style.css"
# Publish the menu only after the complete bundle is in place. Public page URLs
# stay the same; the view module and all app dependencies get new cache keys.
sed -e "s/\"path\": \"xray-router\"/\"path\": \"xray-router-$ASSET_VERSION\"/" \
    -e "s/\"path\": \"xray-router-inspector\"/\"path\": \"xray-router-inspector-$ASSET_VERSION\"/" \
    "$APP/root/usr/share/luci/menu.d/luci-app-xray-router.json" \
    > /usr/share/luci/menu.d/luci-app-xray-router.json.new
mv /usr/share/luci/menu.d/luci-app-xray-router.json.new /usr/share/luci/menu.d/luci-app-xray-router.json
chmod 0755 /usr/libexec/rpcd/luci.xray-router /usr/libexec/rpcd/luci.xray-inspector
chmod 0644 /usr/libexec/xray-router/inspector.lua /usr/libexec/xray-router/inspector-runtime.lua \
    /www/luci-static/resources/view/xray-router-inspector.js
chmod 0644 /usr/libexec/xray-router/ui.lua /usr/libexec/xray-router/node-test.lua /usr/share/rpcd/acl.d/luci-app-xray-router.json \
    /usr/share/luci/menu.d/luci-app-xray-router.json /www/luci-static/resources/xray-router/model.js \
    /www/luci-static/resources/xray-router/inspector.js \
    /www/luci-static/resources/xray-router/style.css \
    /www/luci-static/resources/view/xray-router.js
rm -f /tmp/luci-indexcache*
/etc/init.d/rpcd restart
printf '%s\n' "LuCI installed (assets $ASSET_VERSION). Reload Services > Xray Router; sign in again if prompted."
