#!/bin/sh

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d /tmp/xray-router-policy-test.XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/config" "$TEST_DIR/includes" "$TEST_DIR/runtime"
cp "$ROOT/config/settings.conf" "$ROOT/config/cn-ipv4.txt" \
   "$ROOT/config/proxy-server-ipv4.txt" "$TEST_DIR/config/"

cat > "$TEST_DIR/bin/fw4" <<'EOF'
#!/bin/sh
[ "$1" = "check" ]
EOF

cat > "$TEST_DIR/bin/ip" <<'EOF'
#!/bin/sh
set -eu
state="${XRAY_TEST_STATE:?}"
if [ "$1 $2" = "-4 rule" ] && [ "$3" = "show" ]; then
    [ ! -e "$state/rule" ] || cat "$state/rule"
elif [ "$1 $2 $3" = "-4 rule add" ]; then
    printf '%s\n' '10010: from all fwmark 0x1/0x1 lookup 100' > "$state/rule"
elif [ "$1 $2 $3" = "-4 rule del" ]; then
    rm -f "$state/rule"
elif [ "$1 $2 $3" = "-4 route replace" ]; then
    printf '%s\n' 'local 0.0.0.0/0 dev lo' > "$state/route"
elif [ "$1 $2 $3" = "-4 route del" ]; then
    rm -f "$state/route"
elif [ "$1 $2 $3" = "-4 route show" ]; then
    [ ! -e "$state/route" ] || cat "$state/route"
else
    printf 'unexpected fake ip call: %s\n' "$*" >&2
    exit 1
fi
EOF

cat > "$TEST_DIR/bin/nft" <<'EOF'
#!/bin/sh
exit 0
EOF

cat > "$TEST_DIR/firewall" <<'EOF'
#!/bin/sh
[ "$1" = "reload" ]
printf '%s\n' reload >> "${XRAY_TEST_STATE:?}/firewall.log"
EOF

chmod +x "$TEST_DIR/bin/fw4" "$TEST_DIR/bin/ip" "$TEST_DIR/bin/nft" "$TEST_DIR/firewall"

export PATH="$TEST_DIR/bin:$PATH"
export XRAY_TEST_STATE="$TEST_DIR"
export XRAY_ROUTER_CONF_DIR="$TEST_DIR/config"
export XRAY_ROUTER_NFT_INCLUDE_LINK="$TEST_DIR/includes/30-xray-router.nft"
export XRAY_ROUTER_NFT_RUNTIME_DIR="$TEST_DIR/runtime"
export XRAY_ROUTER_LOCK_DIR="$TEST_DIR/policy.lock"
export XRAY_ROUTER_FIREWALL_INIT="$TEST_DIR/firewall"

sh "$ROOT/src/policy.sh" up >/dev/null
[ -L "$XRAY_ROUTER_NFT_INCLUDE_LINK" ]
[ -f "$XRAY_ROUTER_NFT_RUNTIME_DIR/30-xray-router.nft" ]
[ -f "$TEST_DIR/rule" ]
[ -f "$TEST_DIR/route" ]
grep -q 'chain xray_prerouting' "$XRAY_ROUTER_NFT_RUNTIME_DIR/30-xray-router.nft"

sh "$ROOT/src/policy.sh" down >/dev/null
[ ! -e "$XRAY_ROUTER_NFT_RUNTIME_DIR/30-xray-router.nft" ]
[ ! -e "$TEST_DIR/rule" ]
[ ! -e "$TEST_DIR/route" ]
[ "$(wc -l < "$TEST_DIR/firewall.log" | tr -d ' ')" -eq 2 ]

printf '%s\n' 'policy lifecycle test passed'
