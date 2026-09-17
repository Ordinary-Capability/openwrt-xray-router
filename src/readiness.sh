#!/bin/sh
# XRAY_ROUTER_PROJECT: source from the init script; no network probes or dry runs.
xray_service_pid() {
    ubus call service list '{"name":"xray-router"}' 2>/dev/null |
        jsonfilter -e '@["xray-router"].instances["xray-router"].pid' 2>/dev/null
}

xray_listeners_ready() {
    # Match socket ownership as well as ports: another daemon (or an old Xray
    # instance still shutting down) must never satisfy the readiness check.
    netstat -lnptu 2>/dev/null | awk -v pid="$1" -v ports="$2" \
        -v dns="$XRAY_DNS_PORT" -v tproxy="$TPROXY_PORT" '
        BEGIN { n = split(ports, wanted, /[[:space:]]+/) }
        $1 ~ /^(tcp|udp)/ && $NF ~ ("^" pid "/") {
            port = $4; sub(/^.*:/, "", port)
            if ($1 ~ /^tcp/ && $6 == "LISTEN") tcp[port] = 1
            if ($1 ~ /^udp/) udp[port] = 1
        }
        END {
            for (i = 1; i <= n; i++) if (wanted[i] != "" && !tcp[wanted[i]]) exit 1
            if (!tcp[dns] || !udp[dns] || !tcp[tproxy] || !udp[tproxy]) exit 1
        }'
}

xray_fast_wait_available() {
    # LuCI installations already provide nixio. Bare CLI installations work
    # without Lua and use the coarser BusyBox sleep fallback.
    command -v lua >/dev/null 2>&1 && lua -e 'assert(require("nixio").nanosleep)' 2>/dev/null
}

xray_wait_tick() {
    if [ "$1" = fast ]; then
        lua -e 'require("nixio").nanosleep(0, 100000000)'
    else
        sleep 1
    fi
}

wait_xray_ready() {
    local ports port pid first_pid="" attempts=0 limit=15 interval=slow
    if xray_fast_wait_available; then limit=150; interval=fast; fi
    ports="$(jsonfilter -i "$CONFIG_FILE" -e '@.inbounds[*].port')" || return 1
    [ -n "$ports" ] || return 1
    # The managed stack uses TCP inbounds plus TCP/UDP DNS and TProxy. Reject
    # unsupported port ranges instead of reporting them ready by accident.
    for port in $ports; do
        case "$port" in ''|*[!0-9]*) return 1 ;; esac
    done
    while [ "$attempts" -lt "$limit" ]; do
        pid="$(xray_service_pid)"
        case "$pid" in ''|*[!0-9]*)
            [ -z "$first_pid" ] || return 1
            ;;
        *)
            [ "$pid" != "${XRAY_PREVIOUS_PID:-}" ] || return 1
            [ -z "$first_pid" ] || [ "$pid" = "$first_pid" ] || return 1
            first_pid="$pid"
            kill -0 "$pid" 2>/dev/null || return 1
            if xray_listeners_ready "$pid" "$ports"; then
                kill -0 "$pid" 2>/dev/null && return 0
                return 1
            fi
            ;;
        esac
        attempts=$((attempts + 1))
        xray_wait_tick "$interval"
    done
    return 1
}
