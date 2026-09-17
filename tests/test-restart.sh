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
case "$1" in
    start|restart) touch "$XRAY_TEST_LOG.running" ;;
    stop) rm -f "$XRAY_TEST_LOG.running" ;;
esac
EOF
chmod +x "$TEST_DIR/init"
INIT_SCRIPT="$TEST_DIR/init"
export XRAY_TEST_LOG="$TEST_DIR/actions"
need_root() { :; }
load_settings() { MANAGE_DNSMASQ=1; ALLOW_BLACKHOLE_PROXY=0; }
validate_all() { die "unexpected lifecycle preflight"; }
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

# The CLI lifecycle must not call validation; successful operations still apply
# DNS after starting Xray, and failed operations still restore the baseline.
: > "$XRAY_TEST_LOG"
rm -f "$XRAY_TEST_LOG.running"
service_running() { [ -f "$XRAY_TEST_LOG.running" ]; }
dnsmasq_apply() { printf '%s\n' dnsmasq >> "$XRAY_TEST_LOG"; }
start_stack >/dev/null
restart_stack >/dev/null
[ "$(cat "$XRAY_TEST_LOG")" = "$(printf 'start\ndnsmasq\nrestart\ndnsmasq')" ]

# Exercise the real init functions with a fake procd adapter. The daemon is
# registered once, without executing a test process first.
(
    . "$ROOT/src/xray-router.init"
    PROG="$TEST_DIR/xray"
    CONFIG_FILE="$TEST_DIR/config.json"
    POLICY_SCRIPT="$TEST_DIR/policy"
    READINESS_SCRIPT="$TEST_DIR/readiness"
    printf 'wait_xray_ready() { return 0; }\n' > "$READINESS_SCRIPT"
    printf '%s\n' '{}' > "$CONFIG_FILE"
    printf '#!/bin/sh\necho unexpected-xray-test >> "%s"\nexit 1\n' "$XRAY_TEST_LOG" > "$PROG"
    printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$XRAY_TEST_LOG" > "$POLICY_SCRIPT"
    chmod +x "$PROG" "$POLICY_SCRIPT"
    load_project_settings() { XRAY_ASSET_DIR="$TEST_DIR"; }
    procd_open_instance() { :; }
    procd_set_param() { [ "$1" != command ] || printf '%s\n' "$*" >> "$XRAY_TEST_LOG"; }
    procd_close_instance() { :; }
    : > "$XRAY_TEST_LOG"
    start_service
    service_started
    [ "$(cat "$XRAY_TEST_LOG")" = "$(printf 'command %s run -config %s\nup --no-check' "$PROG" "$CONFIG_FILE")" ]
)
printf '%s\n' 'start/restart skip preflight tests passed'

# Restart keeps unchanged policy but failure still tears it down. No live procd
# or firewall is involved; use the real restart and stopped hooks.
(
    . "$ROOT/src/xray-router.init"
    READINESS_SCRIPT="$TEST_DIR/readiness"
    printf 'xray_service_pid() { echo 123; }\n' > "$READINESS_SCRIPT"
    POLICY_SCRIPT="$TEST_DIR/policy"
    printf '#!/bin/sh\n[ "$1" != unchanged ] || exit 0\nprintf "%%s\\n" "$*" >> "%s"\n' "$XRAY_TEST_LOG" > "$POLICY_SCRIPT"
    chmod +x "$POLICY_SCRIPT"
    procd_lock() { :; }
    load_project_settings() { :; }
    stop() { service_stopped; }
    start() { printf 'keep=%s\n' "$XRAY_KEEP_POLICY" >> "$XRAY_TEST_LOG"; return "${FAIL_START:-0}"; }
    : > "$XRAY_TEST_LOG"
    restart
    [ "$(cat "$XRAY_TEST_LOG")" = 'keep=1' ]
    : > "$XRAY_TEST_LOG"
    FAIL_START=1
    if restart; then exit 1; fi
    [ "$(cat "$XRAY_TEST_LOG")" = "$(printf 'keep=1\ndown')" ]
)
printf '%s\n' 'unchanged policy restart and failure cleanup tests passed'
