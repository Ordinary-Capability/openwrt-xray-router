#!/bin/sh
set -eu
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d /tmp/xray-router-restart-test.XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
sed '/^main "\$@"$/d' "$ROOT/src/xrayctl" > "$TEST_DIR/functions"
. "$TEST_DIR/functions"
cat > "$TEST_DIR/init" <<'EOF'
#!/bin/sh
printf '%s\n' "$1" >> "$XRAY_TEST_LOG"
EOF
chmod +x "$TEST_DIR/init"
INIT_SCRIPT="$TEST_DIR/init"
export XRAY_TEST_LOG="$TEST_DIR/actions"
need_root() { :; }
load_settings() { MANAGE_DNSMASQ=1; ALLOW_BLACKHOLE_PROXY=0; }
validate_all() { :; }
proxy_is_placeholder() { return 1; }
check_other_xray() { :; }
service_running() { return 0; }
sleep() { :; }
dnsmasq_apply() { return 1; }
dnsmasq_restore() { printf '%s\n' restore >> "$XRAY_TEST_LOG"; }
if (restart_stack) > "$TEST_DIR/output" 2>&1; then
    printf '%s\n' 'restart falsely reported success after dnsmasq failure' >&2
    exit 1
fi
grep -q 'dnsmasq setup failed after restart' "$TEST_DIR/output"
[ "$(cat "$TEST_DIR/actions")" = "$(printf 'restart\nstop\nrestore')" ]
printf '%s\n' 'restart failure propagation test passed'
