#!/bin/sh

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
TEMP="$(mktemp /tmp/xray-router-nft.XXXXXX)"
trap 'rm -f "$TEMP"' EXIT HUP INT TERM

for file in "$ROOT/install.sh" "$ROOT/uninstall.sh" "$ROOT/src/xrayctl" \
            "$ROOT/src/policy.sh" "$ROOT/src/xray-router.init" \
            "$ROOT/tests/test-policy.sh" "$ROOT/tests/test-placeholder.sh" \
            "$ROOT/tests/test-restart.sh" "$ROOT/tests/test-update-cn.sh" \
            "$ROOT/tests/test-dnsmasq.sh" \
            "$ROOT/scripts/install-luci.sh"; do
    sh -n "$file"
done

if command -v jq >/dev/null 2>&1; then
    jq empty "$ROOT/config/config.json"
    for example in "$ROOT"/examples/*.json; do
        jq empty "$example"
    done
fi

XRAY_ROUTER_CONF_DIR="$ROOT/config" sh "$ROOT/src/policy.sh" render "$TEMP" >/dev/null
grep -q 'chain xray_prerouting' "$TEMP"
grep -q 'fib daddr type local' "$TEMP"
grep -q 'tproxy ip to 127.0.0.1:12345' "$TEMP"
grep -q 'meta nfproto ipv6.*reject' "$TEMP"

sh "$ROOT/tests/test-policy.sh"
sh "$ROOT/tests/test-placeholder.sh"
sh "$ROOT/tests/test-restart.sh"
sh "$ROOT/tests/test-dnsmasq.sh"
sh "$ROOT/tests/test-update-cn.sh"

if command -v node >/dev/null 2>&1; then
    node "$ROOT/tests/test-luci.js"
    node "$ROOT/tests/test-inspector-ui.js"
fi

printf '%s\n' 'project static validation passed'
