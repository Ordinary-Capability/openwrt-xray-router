#!/bin/sh
set -eu
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
. "$ROOT/src/readiness.sh"
TEST_DIR="$(mktemp -d /tmp/xray-readiness-test.XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
XRAY_DNS_PORT=1053
TPROXY_PORT=12345
CONFIG_FILE="$TEST_DIR/config"
jsonfilter() { printf '%s\n' 12345 1053 10808 10809; }
netstat() { cat "$TEST_DIR/sockets"; }
write_sockets() {
    for port in 1053 12345 10808 10809; do
        printf 'tcp 0 0 127.0.0.1:%s 0.0.0.0:* LISTEN %s/xray\n' "$port" "$1"
    done
    for port in 1053 12345; do
        printf 'udp 0 0 127.0.0.1:%s 0.0.0.0:* %s/xray\n' "$port" "$1"
    done
}
write_sockets 123 > "$TEST_DIR/sockets"
xray_listeners_ready 123 '12345 1053 10808 10809'
if xray_listeners_ready 456 '12345 1053 10808 10809'; then exit 1; fi
sed '/10809/d' "$TEST_DIR/sockets" > "$TEST_DIR/missing"
cp "$TEST_DIR/missing" "$TEST_DIR/sockets"
if xray_listeners_ready 123 '12345 1053 10808 10809'; then exit 1; fi
write_sockets 123 | sed '/udp.*1053/d' > "$TEST_DIR/sockets"
if xray_listeners_ready 123 '12345 1053 10808 10809'; then exit 1; fi

xray_service_pid() { echo 123; }
xray_fast_wait_available() { return 1; }
kill() { return "${DEAD:-0}"; }
sleep() { ticks=$((ticks + 1)); [ "${BECOME_READY:-0}" = 0 ] || write_sockets 123 > "$TEST_DIR/sockets"; }
ticks=0
write_sockets 123 > "$TEST_DIR/sockets"
wait_xray_ready
[ "$ticks" = 0 ] # Already ready: no compulsory sleep.
XRAY_PREVIOUS_PID=123
if wait_xray_ready; then exit 1; fi
unset XRAY_PREVIOUS_PID
: > "$TEST_DIR/sockets"
BECOME_READY=1
wait_xray_ready
[ "$ticks" = 1 ] # Running before sockets exist must wait.
DEAD=1
if wait_xray_ready; then exit 1; fi
DEAD=0
BECOME_READY=0
ticks=0
: > "$TEST_DIR/sockets"
if wait_xray_ready; then exit 1; fi
[ "$ticks" = 15 ]
printf '%s\n' 'readiness ownership, TCP/UDP listeners, delayed startup, exit and timeout tests passed'
