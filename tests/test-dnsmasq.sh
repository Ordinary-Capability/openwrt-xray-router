#!/bin/sh
# Use real UCI against temporary files and a fake daemon; never touch router DNS.
set -eu
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
if ! command -v uci >/dev/null 2>&1; then
    printf '%s\n' 'SKIP dnsmasq test: uci not installed'
    exit 0
fi
TEST_DIR="$(mktemp -d /tmp/xray-router-dnsmasq-test.XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
sed '/^main "\$@"$/d' "$ROOT/src/xrayctl" > "$TEST_DIR/functions"
. "$TEST_DIR/functions"
mkdir -p "$TEST_DIR/config" "$TEST_DIR/delta" "$TEST_DIR/backup"
DHCP_CONFIG="$TEST_DIR/config/dhcp"
BACKUP_DIR="$TEST_DIR/backup"
DHCP_BACKUP="$BACKUP_DIR/dhcp.before-xray-router"
DNSMASQ_INIT_SCRIPT="$TEST_DIR/dnsmasq"
XRAY_DNS_PORT=1053
DNSMASQ_CACHE_SIZE=1000
need_root() { :; }
uci() { command uci -c "$TEST_DIR/config" -t "$TEST_DIR/delta" "$@"; }
cat > "$DHCP_CONFIG" <<'EOF'
config dnsmasq
    option noresolv '0'
    list server '192.0.2.53'
    option cachesize '500'
EOF
cp "$DHCP_CONFIG" "$TEST_DIR/baseline"
export XRAY_TEST_DNS_STATE="$TEST_DIR"
cat > "$DNSMASQ_INIT_SCRIPT" <<'EOF'
#!/bin/sh
case "$1" in
    running) [ -f "$XRAY_TEST_DNS_STATE/running" ] ;;
    restart)
        printf '%s\n' restart >> "$XRAY_TEST_DNS_STATE/restarts"
        [ ! -f "$XRAY_TEST_DNS_STATE/fail" ] || exit 1
        touch "$XRAY_TEST_DNS_STATE/running"
        ;;
    *) exit 1 ;;
esac
EOF
chmod +x "$DNSMASQ_INIT_SCRIPT"
restarts() { [ "$(wc -l < "$TEST_DIR/restarts" | tr -d ' ')" -eq "$1" ]; }

# Initial setup, repeated apply, and a changed Xray DNS port.
dnsmasq_apply >/dev/null
cmp "$TEST_DIR/baseline" "$DHCP_BACKUP"
restarts 1
[ "$(uci get 'dhcp.@dnsmasq[0].server')" = '127.0.0.1#1053' ]
dnsmasq_apply >/dev/null
restarts 1
XRAY_DNS_PORT=1054
dnsmasq_apply >/dev/null
restarts 2
[ "$(uci get 'dhcp.@dnsmasq[0].server')" = '127.0.0.1#1054' ]
DNSMASQ_CACHE_SIZE=2000
dnsmasq_apply >/dev/null
restarts 3

# Extra upstreams and pending unrelated UCI changes must not take the no-op path.
uci add_list 'dhcp.@dnsmasq[0].server=192.0.2.54'
uci commit dhcp
dnsmasq_apply >/dev/null
restarts 4
[ "$(uci get 'dhcp.@dnsmasq[0].server')" = '127.0.0.1#1054' ]
uci set 'dhcp.@dnsmasq[0].domain=lan2'
dnsmasq_apply >/dev/null
restarts 5
[ -z "$(uci changes dhcp)" ]

# A crashed/stopped daemon needs recovery even with unchanged configuration.
rm "$TEST_DIR/running"
dnsmasq_apply >/dev/null
restarts 6
cmp "$TEST_DIR/baseline" "$DHCP_BACKUP"

dnsmasq_restore >/dev/null
restarts 7
cmp "$DHCP_CONFIG" "$TEST_DIR/baseline"
dnsmasq_restore >/dev/null
restarts 7
rm "$TEST_DIR/running"
dnsmasq_restore >/dev/null
restarts 8

# Failures must propagate even when these functions are called in an if clause.
touch "$TEST_DIR/fail"
if dnsmasq_apply > "$TEST_DIR/output" 2>&1; then
    printf '%s\n' 'apply hid a DNS restart failure' >&2
    exit 1
fi
if dnsmasq_restore > "$TEST_DIR/output" 2>&1; then
    printf '%s\n' 'restore hid a DNS restart failure' >&2
    exit 1
fi
printf '%s\n' 'dnsmasq idempotency, changed settings and recovery tests passed'
