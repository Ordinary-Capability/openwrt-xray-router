#!/bin/sh
# Requires OpenWrt jsonfilter; isolates the actual xrayctl placeholder guard.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d /tmp/xray-router-placeholder-test.XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM

if ! command -v jsonfilter >/dev/null 2>&1; then
    printf '%s\n' 'SKIP placeholder test: jsonfilter not installed'
    exit 0
fi

# Source function definitions without invoking xrayctl's command dispatcher.
sed '/^main "\$@"$/d' "$ROOT/src/xrayctl" > "$TEST_DIR/xrayctl-functions"
. "$TEST_DIR/xrayctl-functions"
CONFIG_FILE="$TEST_DIR/config.json"

cp "$ROOT/config/config.json" "$CONFIG_FILE"
proxy_is_placeholder

# A compact, reordered real primary beside the optional backup placeholder.
cat > "$CONFIG_FILE" <<'EOF'
{"outbounds":[{"protocol":"socks","settings":{"servers":[{"address":"127.0.0.1","port":1080}]},"tag":"proxy-main"},{"tag":"proxy-backup","protocol":"blackhole"}]}
EOF
if proxy_is_placeholder; then
    die "backup placeholder was mistaken for primary"
fi

cat > "$CONFIG_FILE" <<'EOF'
{"outbounds":[{"protocol":"blackhole","settings":{},"tag":"proxy-main"},{"tag":"proxy-backup","protocol":"socks"}]}
EOF
proxy_is_placeholder
printf '%s\n' 'placeholder guard test passed'
