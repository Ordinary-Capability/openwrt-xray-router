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
[ "$removed_include" -eq 0 ] || /etc/init.d/firewall reload >/dev/null 2>&1 || true

rm -f /etc/init.d/xray-router /usr/sbin/xrayctl
rm -rf /usr/libexec/xray-router

if [ "$purge" -eq 1 ]; then
    rm -rf /etc/xray-router
    printf '%s\n' "Removed project files and /etc/xray-router."
else
    printf '%s\n' "Removed project programs; retained /etc/xray-router and its backup."
    printf '%s\n' "Run uninstall.sh --purge only if you also want to delete that retained configuration."
fi
