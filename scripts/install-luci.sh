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
cp "$APP/root/usr/libexec/rpcd/luci.xray-router" /usr/libexec/rpcd/luci.xray-router
cp "$APP/root/usr/share/rpcd/acl.d/luci-app-xray-router.json" /usr/share/rpcd/acl.d/
cp "$APP/root/usr/share/luci/menu.d/luci-app-xray-router.json" /usr/share/luci/menu.d/
cp "$APP/htdocs/luci-static/resources/xray-router/model.js" /www/luci-static/resources/xray-router/
cp "$APP/htdocs/luci-static/resources/view/xray-router.js" /www/luci-static/resources/view/
chmod 0755 /usr/libexec/rpcd/luci.xray-router
chmod 0644 /usr/libexec/xray-router/ui.lua /usr/share/rpcd/acl.d/luci-app-xray-router.json \
    /usr/share/luci/menu.d/luci-app-xray-router.json /www/luci-static/resources/xray-router/model.js \
    /www/luci-static/resources/view/xray-router.js
rm -f /tmp/luci-indexcache*
/etc/init.d/rpcd restart
printf '%s\n' 'LuCI installed. Log out and back in, then open Services > Xray Router.'
