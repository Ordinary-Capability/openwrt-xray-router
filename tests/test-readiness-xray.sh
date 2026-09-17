#!/bin/sh
# Optional integration test: real Xray on temporary loopback ports only.
set -eu
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
for cmd in xray jsonfilter netstat; do command -v "$cmd" >/dev/null || exit 77; done
TEST_DIR="$(mktemp -d /tmp/xray-readiness-integration.XXXXXX)"
pid=""
trap '[ -z "$pid" ] || kill "$pid" 2>/dev/null || true; rm -rf "$TEST_DIR"' EXIT HUP INT TERM
. "$ROOT/src/readiness.sh"
XRAY_DNS_PORT=31053
TPROXY_PORT=31345
CONFIG_FILE="$TEST_DIR/config.json"
cat > "$CONFIG_FILE" <<'EOF'
{"log":{"loglevel":"warning"},"inbounds":[
 {"tag":"dns-in","listen":"127.0.0.1","port":31053,"protocol":"tunnel","settings":{"allowedNetwork":"tcp,udp","rewriteAddress":"127.0.0.1","rewritePort":9}},
 {"tag":"tproxy-in","listen":"127.0.0.1","port":31345,"protocol":"tunnel","settings":{"allowedNetwork":"tcp,udp","rewriteAddress":"127.0.0.1","rewritePort":9}},
 {"tag":"http-in","listen":"127.0.0.1","port":31809,"protocol":"http","settings":{}}
],"outbounds":[{"protocol":"blackhole"}]}
EOF
xray_service_pid() { cat "$TEST_DIR/pid"; }
(sleep 1; exec xray run -config "$CONFIG_FILE") > "$TEST_DIR/output" 2>&1 &
pid=$!
echo "$pid" > "$TEST_DIR/pid"
wait_xray_ready
kill "$pid"
wait "$pid" 2>/dev/null || true
pid=""
# The real daemon must reject the config on startup, not in a dry run.
sed 's/"protocol":"blackhole"/"protocol":"unsupported-protocol"/' "$CONFIG_FILE" > "$CONFIG_FILE.new"
mv "$CONFIG_FILE.new" "$CONFIG_FILE"
xray run -config "$CONFIG_FILE" > "$TEST_DIR/output" 2>&1 &
pid=$!
echo "$pid" > "$TEST_DIR/pid"
if wait_xray_ready; then echo 'invalid Xray config reported ready' >&2; exit 1; fi
wait "$pid" 2>/dev/null || true
pid=""
grep -q 'Failed to start' "$TEST_DIR/output"
printf '%s\n' 'real Xray delayed startup and invalid-config readiness tests passed'
