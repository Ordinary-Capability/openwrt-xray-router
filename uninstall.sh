#!/bin/sh
# Remove project integration. Xray and dnsmasq packages are never removed.

set -eu

purge=0
case "${1:-}" in
    '') ;;
    --purge) purge=1 ;;
    *) printf '%s\n' "Usage: $0 [--purge]" >&2; exit 2 ;;
esac

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "run this uninstaller as root"
[ ! -d /tmp/xray-router-ui/lock ] || die "wait for the LuCI management operation to finish before uninstalling"
[ ! -d /tmp/xray-router-inspector/lock ] || die "stop / clean up the traffic capture before uninstalling"

if [ -x /usr/sbin/xrayctl ]; then
    /usr/sbin/xrayctl stop || die "stack rollback failed; project files were not removed"
elif [ -e /etc/xray-router/backups/dhcp.before-xray-router ]; then
    cp -p /etc/xray-router/backups/dhcp.before-xray-router /etc/config/dhcp
    /etc/init.d/dnsmasq restart || die "could not restore dnsmasq"
fi
if [ -x /etc/init.d/xray-router ]; then
    /etc/init.d/xray-router disable >/dev/null 2>&1 || true
    /etc/init.d/xray-router stop >/dev/null 2>&1 || true
fi

removed_include=0
if [ -L /usr/share/nftables.d/table-post/30-xray-router.nft ]; then
    link_target="$(readlink /usr/share/nftables.d/table-post/30-xray-router.nft)"
    if [ "$link_target" = "/tmp/xray-router/30-xray-router.nft" ]; then
        rm -f /usr/share/nftables.d/table-post/30-xray-router.nft
        removed_include=1
    fi
elif [ -e /usr/share/nftables.d/table-post/30-xray-router.nft ] && \
     grep -q XRAY_ROUTER_PROJECT /usr/share/nftables.d/table-post/30-xray-router.nft; then
    rm -f /usr/share/nftables.d/table-post/30-xray-router.nft
    removed_include=1
fi
rm -rf /tmp/xray-router
rm -rf /tmp/xray-router-ui
rm -rf /tmp/xray-router-inspector
[ "$removed_include" -eq 0 ] || /etc/init.d/firewall reload >/dev/null 2>&1 || true

rm -f /etc/init.d/xray-router /usr/sbin/xrayctl
rm -rf /usr/libexec/xray-router
rm -f /usr/libexec/rpcd/luci.xray-router \
    /usr/libexec/rpcd/luci.xray-inspector \
    /usr/share/rpcd/acl.d/luci-app-xray-router.json \
    /usr/share/luci/menu.d/luci-app-xray-router.json \
    /www/luci-static/resources/view/xray-router.js \
    /www/luci-static/resources/view/xray-router-inspector.js \
    /www/luci-static/resources/xray-router/model.js \
    /www/luci-static/resources/xray-router/inspector.js \
    /www/luci-static/resources/xray-router/style.css
rm -f /www/luci-static/resources/view/xray-router-v*.js \
    /www/luci-static/resources/view/xray-router-inspector-v*.js
rm -rf /www/luci-static/resources/xray-router/v[0-9a-f]*
rmdir /www/luci-static/resources/xray-router 2>/dev/null || true
rm -f /tmp/luci-indexcache*
[ ! -x /etc/init.d/rpcd ] || /etc/init.d/rpcd restart

if [ "$purge" -eq 1 ]; then
    rm -rf /etc/xray-router
    printf '%s\n' "Removed project files and /etc/xray-router."
else
    printf '%s\n' "Removed project programs; retained /etc/xray-router and its backup."
    printf '%s\n' "Run uninstall.sh --purge only if you also want to delete that retained configuration."
fi
