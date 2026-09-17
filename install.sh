#!/bin/sh
# Install project files only. It does not start services or modify dnsmasq.

set -eu

PROJECT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
CONF_DIR="/etc/xray-router"
LIBEXEC_DIR="/usr/libexec/xray-router"
WITH_LUCI=0
case "${1:-}" in
    '') ;;
    --with-luci) WITH_LUCI=1 ;;
    *) printf '%s\n' "Usage: $0 [--with-luci]" >&2; exit 2 ;;
esac

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ "$(id -u)" = "0" ] || die "run this installer as root"
[ -r /etc/openwrt_release ] || die "this installer targets OpenWrt"
[ ! -d /tmp/xray-router-ui/lock ] || die "wait for the LuCI management operation to finish before installing"
[ ! -d /tmp/xray-router-inspector/lock ] || die "stop / clean up the traffic capture before installing"
[ "$WITH_LUCI" -eq 0 ] || sh "$PROJECT_DIR/scripts/install-luci.sh" --check

for cmd in xray fw4 nft ip uci jsonfilter netstat ubus; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done

mkdir -p "$CONF_DIR" "$CONF_DIR/backups" "$LIBEXEC_DIR"

# Administrator configuration is created once and preserved on reinstall.
[ -e "$CONF_DIR/config.json" ] || cp "$PROJECT_DIR/config/config.json" "$CONF_DIR/config.json"
[ -e "$CONF_DIR/settings.conf" ] || cp "$PROJECT_DIR/config/settings.conf" "$CONF_DIR/settings.conf"
[ -e "$CONF_DIR/cn-ipv4.txt" ] || cp "$PROJECT_DIR/config/cn-ipv4.txt" "$CONF_DIR/cn-ipv4.txt"
[ -e "$CONF_DIR/proxy-server-ipv4.txt" ] || cp "$PROJECT_DIR/config/proxy-server-ipv4.txt" "$CONF_DIR/proxy-server-ipv4.txt"

# Program files are project-owned and are safely refreshed on reinstall.
cp "$PROJECT_DIR/src/policy.sh" "$LIBEXEC_DIR/policy.sh"
cp "$PROJECT_DIR/src/readiness.sh" "$LIBEXEC_DIR/readiness.sh"
cp "$PROJECT_DIR/src/xrayctl" /usr/sbin/xrayctl
cp "$PROJECT_DIR/src/xray-router.init" /etc/init.d/xray-router
chmod 0755 "$LIBEXEC_DIR/policy.sh" /usr/sbin/xrayctl /etc/init.d/xray-router
chmod 0644 "$LIBEXEC_DIR/readiness.sh"
chmod 0600 "$CONF_DIR/config.json"
chmod 0644 "$CONF_DIR/settings.conf" "$CONF_DIR/cn-ipv4.txt" \
    "$CONF_DIR/proxy-server-ipv4.txt"

say "Installed xray-router project files. No service was started and dnsmasq was not changed."
say "Next: edit $CONF_DIR/config.json, then run: xrayctl doctor && xrayctl validate"
[ "$WITH_LUCI" -eq 0 ] || sh "$PROJECT_DIR/scripts/install-luci.sh"
