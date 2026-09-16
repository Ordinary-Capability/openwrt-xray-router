#!/bin/sh
# Exercise download selection and list preservation without network access.
set -eu
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d /tmp/xray-router-update-cn-test.XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
sed '/^main "\$@"$/d' "$ROOT/src/xrayctl" > "$TEST_DIR/functions"
. "$TEST_DIR/functions"
mkdir "$TEST_DIR/bin" "$TEST_DIR/no-curl"
export XRAY_TEST_FETCH_LOG="$TEST_DIR/fetch.log"
export XRAY_TEST_APNIC="$TEST_DIR/apnic"
cat > "$TEST_DIR/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "${0##*/}" "$@" >> "$XRAY_TEST_FETCH_LOG"
[ "${XRAY_TEST_FAIL:-0}" = 0 ] || exit 7
while [ "$#" -gt 0 ]; do
    case "$1" in -o|-O) shift; target="$1" ;; esac
    shift
done
cp "$XRAY_TEST_APNIC" "$target"
EOF
chmod +x "$TEST_DIR/bin/curl"
cp "$TEST_DIR/bin/curl" "$TEST_DIR/bin/uclient-fetch"
cp "$TEST_DIR/bin/curl" "$TEST_DIR/no-curl/uclient-fetch"
PATH="$TEST_DIR/bin:$PATH"
export PATH
awk 'BEGIN { for (i = 0; i < 150; i++) print "apnic|CN|ipv4|1.0." i ".0|256|20200101|allocated" }' > "$XRAY_TEST_APNIC"

CONF_DIR="$TEST_DIR"
CN_FILE="$TEST_DIR/cn-ipv4.txt"
SETTINGS_FILE="$TEST_DIR/settings.conf"
cat > "$SETTINGS_FILE" <<'EOF'
CN_LIST_URL="https://example.invalid/apnic"
CN_DOWNLOAD_PROXY="socks5h://192.0.2.1:10808"
EOF
need_root() { :; }
service_running() { return 1; }

# Explicit proxy selection, proxy-side DNS, bounded wait, and no bypass.
(update_cn) > "$TEST_DIR/output" 2>&1
grep -q 'installed 150 CN IPv4 prefixes' "$TEST_DIR/output"
[ "$(wc -l < "$CN_FILE" | tr -d ' ')" = 150 ]
grep -qx '1.0.149.0/24' "$CN_FILE"
grep -qx 'curl' "$XRAY_TEST_FETCH_LOG"
grep -qx 'socks5h://192.0.2.1:10808' "$XRAY_TEST_FETCH_LOG"
grep -qx -- '--connect-timeout' "$XRAY_TEST_FETCH_LOG"
grep -qx -- '--max-time' "$XRAY_TEST_FETCH_LOG"
grep -A 1 -x -- '--noproxy' "$XRAY_TEST_FETCH_LOG" | tail -n 1 | grep -qx ''
if grep -q 'uclient-fetch' "$XRAY_TEST_FETCH_LOG"; then exit 1; fi

# A failed download must keep the installed list and must not retry directly.
cp "$CN_FILE" "$TEST_DIR/previous"
: > "$XRAY_TEST_FETCH_LOG"
export XRAY_TEST_FAIL=1
if (update_cn) > "$TEST_DIR/output" 2>&1; then exit 1; fi
cmp "$CN_FILE" "$TEST_DIR/previous"
grep -q 'previous CN list kept' "$TEST_DIR/output"
[ "$(grep -c '^curl$' "$XRAY_TEST_FETCH_LOG")" = 1 ]
if grep -q 'uclient-fetch' "$XRAY_TEST_FETCH_LOG"; then exit 1; fi
unset XRAY_TEST_FAIL

# A successful HTTP response with unusable data must also preserve the list.
printf '%s\n' 'not delegated statistics' > "$XRAY_TEST_APNIC"
if (update_cn) > "$TEST_DIR/output" 2>&1; then exit 1; fi
cmp "$CN_FILE" "$TEST_DIR/previous"
grep -q 'refusing to install' "$TEST_DIR/output"

# Existing direct downloads still work, with a request timeout.
: > "$XRAY_TEST_FETCH_LOG"
CN_DOWNLOAD_PROXY=''
fetch_url 'https://example.invalid/apnic' "$TEST_DIR/direct"
grep -qx 'uclient-fetch' "$XRAY_TEST_FETCH_LOG"
grep -qx -- '-T' "$XRAY_TEST_FETCH_LOG"

# Missing curl must fail clearly even when a native downloader is available.
: > "$XRAY_TEST_FETCH_LOG"
CN_DOWNLOAD_PROXY='http://192.0.2.1:10809'
if (PATH="$TEST_DIR/no-curl"; fetch_url 'https://example.invalid/apnic' "$TEST_DIR/missing") > "$TEST_DIR/output" 2>&1; then exit 1; fi
grep -q 'CN_DOWNLOAD_PROXY requires curl' "$TEST_DIR/output"
[ ! -s "$XRAY_TEST_FETCH_LOG" ]
printf '%s\n' 'CN update proxy and failure-preservation tests passed'
