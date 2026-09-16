-- Bounded, dependency-free parsers for per-device Xray/nftables evidence.
local M = {}
local function cut(value, size) return tostring(value or ""):sub(1, size or 512) end
function M.ipv4(value)
    if type(value) ~= "string" or not value:match("^%d+%.%d+%.%d+%.%d+$") then return false end
    local parts = {}
    for part in value:gmatch("%d+") do
        if #part > 3 or (#part > 1 and part:sub(1, 1) == "0") or tonumber(part) > 255 then return false end
        parts[#parts + 1] = tonumber(part)
    end
    return #parts == 4 and parts[1] > 0 and parts[1] < 224 and parts[1] ~= 127
end
function M.request(request)
    assert(M.ipv4(request.device), "Enter a LAN device IPv4 address")
    local duration = tonumber(request.duration)
    assert(duration == 30 or duration == 60 or duration == 120, "Capture duration must be 30, 60 or 120 seconds")
    local expected = request.expected or "any"
    assert(({ any = true, direct = true, proxy = true, ["proxy-main"] = true,
        ["proxy-backup"] = true, ["proxy-stream"] = true })[expected], "Invalid expected path")
    return { device = request.device, duration = duration, expected = expected }
end
function M.interfaces(raw)
    local value = raw:match('\n%s*LAN_INTERFACES%s*=%s*"([^"\r\n]+)"')
        or raw:match("\n%s*LAN_INTERFACES%s*=%s*'([^'\r\n]+)'")
        or raw:match("\n%s*LAN_INTERFACES%s*=%s*([%w_.:@+%-]+)%s*\n")
    assert(value, "LAN_INTERFACES must be a literal interface list in settings.conf")
    local list = {}
    for dev in value:gmatch("%S+") do
        assert(#dev <= 15 and dev:match("^[%w_.:@+%-]+$"), "Invalid LAN interface name")
        list[#list + 1] = '"' .. dev .. '"'
    end
    assert(#list > 0 and #list <= 32, "Invalid LAN interface list")
    return table.concat(list, ", ")
end
function M.rules(request, interfaces, token)
    local r = M.request(request)
    assert(type(token) == "string" and token:match("^[%d%-]+$"), "Invalid capture token")
    -- The timed set expires even if the collector is killed. This table has no
    -- forwarding verdict or route change: it only enables tracing on sampled packets.
    return string.format([[add table inet xray_router_inspect { comment "XRAY_ROUTER_INSPECTOR:%s"; }
add set inet xray_router_inspect clients4 { type ipv4_addr; flags timeout; timeout %ds; }
add element inet xray_router_inspect clients4 { %s timeout %ds }
add chain inet xray_router_inspect observe { type filter hook prerouting priority -151; policy accept; }
add rule inet xray_router_inspect observe iifname { %s } ip saddr @clients4 meta l4proto { tcp, udp } ct state new limit rate 5/second burst 10 packets meta nftrace set 1
]], token, r.duration, r.device, r.duration, interfaces)
end
function M.devices(leases, arp)
    local items, seen = {}, {}
    for line in (leases or ""):gmatch("[^\n]+") do
        local ip, name = line:match("^%S+%s+%S+%s+(%S+)%s+(%S+)")
        if M.ipv4(ip) and not seen[ip] and #items < 256 then
            seen[ip] = true
            items[#items + 1] = { ip = ip, name = name ~= "*" and cut(name, 80) or ip }
        end
    end
    for line in (arp or ""):gmatch("[^\n]+") do
        local ip = line:match("^(%d+%.%d+%.%d+%.%d+)%s")
        if M.ipv4(ip) and not seen[ip] and #items < 256 then
            seen[ip] = true; items[#items + 1] = { ip = ip, name = ip }
        end
    end
    return items
end
local function endpoint(value)
    local network, target = value:match("^(%a+):(.+)$")
    if network ~= "tcp" and network ~= "udp" then network, target = nil, value end
    local address, port = target:match("^(.+):(%d+)$")
    if not address or tonumber(port) > 65535 then return end
    return address, tonumber(port), network
end
function M.new(request, started)
    local r = M.request(request)
    local self = { rows = {}, dropped = 0, dns_queries = {}, started = started, device = r.device, expected = r.expected }
    local flows, sessions, traces, queries, associations = {}, {}, {}, {}, {}
    local session_count, trace_count, association_count, next_id = 0, 0, 0, 0
    local function forget_flow(row)
        for key, item in pairs(flows) do if item == row then flows[key] = nil end end
    end
    local function flow(source_port, destination, port, network, now)
        if not source_port or not destination or not port then return end
        local key = table.concat({ network or "?", source_port, destination, port }, "|")
        local row = flows[key]
        if not row then
            if #self.rows >= 500 then self.dropped = self.dropped + 1; return end
            next_id = next_id + 1
            row = { id = next_id, source = r.device, source_port = source_port,
                destination = cut(destination, 253), port = port, network = network or "unknown",
                path = "unknown", outcome = "Not established", first = now, last = now,
                evidence = {}, dns_candidates = {} }
            flows[key] = row; self.rows[#self.rows + 1] = row
        end
        row.last = now
        return row
    end
    local function evidence(row, kind, line)
        if not row then return end
        if #row.evidence < 8 then row.evidence[#row.evidence + 1] = { kind = kind, text = cut(line) } end
    end
    local function attach(row, session)
        if not row or not session then return end
        if session.domain then row.domain, row.domain_evidence = session.domain, "sniffed" end
        session.row = row
    end
    function self.log(line, now)
        if #line > 8192 then return end
        -- logread -f may replay the ring. Ignore Xray entries older than capture start.
        local y, m, d, h, minute, s, fraction = line:match("(%d%d%d%d)/(%d%d)/(%d%d) (%d%d):(%d%d):(%d%d)%.(%d+)")
        if y then
            local stamp = os.time({ year = y, month = m, day = d, hour = h, min = minute, sec = s }) + tonumber("0." .. fraction)
            if stamp < started then return end
        else
            local months = { Jan=1, Feb=2, Mar=3, Apr=4, May=5, Jun=6, Jul=7, Aug=8, Sep=9, Oct=10, Nov=11, Dec=12 }
            local mon, day, hour, min, sec, year = line:match("^%a+ (%a+) +(%d+) (%d+):(%d+):(%d+) (%d+)")
            if months[mon] and os.time({ year=year, month=months[mon], day=day, hour=hour, min=min, sec=sec }) < math.floor(started) then return end
        end
        local sid = line:match("%[%a+%]%s+%[(%d+)%]")
        local source = line:match("received request for ([^%s]+)")
        if sid and source then
            local ip, port = endpoint(source)
            if ip == r.device then
                if not sessions[sid] and session_count >= 1024 then self.dropped = self.dropped + 1; return end
                if not sessions[sid] then session_count = session_count + 1 end
                sessions[sid] = { source_port = port }
            elseif sessions[sid] then
                sessions[sid] = nil; session_count = session_count - 1
            end
        end
        local session = sid and sessions[sid]
        if session then
            local domain = line:match("sniffed domain: ([^%s]+)")
            if domain then session.domain = cut(domain, 253); attach(session.row, session) end
            local tag, destination = line:match("taking detour %[(.-)%] for %[(.-)%]")
            if tag then
                local address, port, network = endpoint(destination)
                local row = flow(session.source_port, address, port, network, now)
                attach(row, session)
                if row then
                    row.path, row.outcome = cut(tag, 80), "Selected; outcome unknown"
                    row.route_target = cut(address, 253)
                    row.rule = cut(line:match("Hit route rule: %[(.-)%]"), 100)
                    evidence(row, "xray-route", line)
                end
            end
            if session.row and (line:find("[Warning]", 1, true) or line:find("[Error]", 1, true)
                or line:find("failed", 1, true) or line:find("timeout", 1, true)) then
                session.row.outcome, session.row.error = "Error logged", cut(line)
                evidence(session.row, "xray-error", line)
            end
        end
        local from, status, destination, detour = line:match("from (%S+) (accepted) (%S+) %[(.-)%]")
        if not from then from, status, destination, detour = line:match("from (%S+) (rejected) (%S+) %[(.-)%]") end
        if from and detour:match("^tproxy%-in ") then
            local ip, source_port = endpoint(from)
            local address, port, network = endpoint(destination)
            if ip == r.device then
                local path = cut(detour:match("[>%s]([^%s]+)$") or "unknown", 80)
                -- routeOnly logs can name the sniffed domain in the route line,
                -- while access logs retain the original IP. Correlate only a
                -- unique pending source/protocol/destination-port/path tuple.
                local candidate, candidates = nil, 0
                for _, item in ipairs(self.rows) do
                    if not item.has_access and item.route_target and not item.route_target:match("^[%d.]+$")
                        and item.source_port == source_port and item.port == port and item.network == network
                        and item.path == path and now - item.last <= 2 then
                        candidate = item; candidates = candidates + 1
                    end
                end
                local row
                if candidates == 1 then
                    local key = table.concat({ network or "?", source_port, address, port }, "|")
                    local observed = flows[key]
                    if observed and observed ~= candidate then
                        -- Kernel tracing may have created the original-IP row first.
                        for _, item in ipairs(candidate.evidence) do evidence(observed, item.kind, item.text) end
                        observed.domain, observed.domain_evidence = candidate.domain, candidate.domain_evidence
                        observed.rule, observed.route_target = candidate.rule, candidate.route_target
                        observed.outcome, observed.error = candidate.outcome, candidate.error
                        for _, session in pairs(sessions) do if session.row == candidate then session.row = observed end end
                        for id, item in pairs(traces) do if item == candidate then traces[id] = observed end end
                        forget_flow(candidate)
                        for index, item in ipairs(self.rows) do if item == candidate then table.remove(self.rows, index); break end end
                        row = observed
                    else
                        forget_flow(candidate)
                        candidate.destination = cut(address, 253); flows[key] = candidate; row = candidate
                    end
                else row = flow(source_port, address, port, network, now) end
                if row then
                    row.path, row.has_access = path, true
                    row.last = now
                    if row.outcome ~= "Error logged" then row.outcome = status == "rejected" and "Rejected" or "Selected; outcome unknown" end
                    if address and not address:match("^[%d.]+$") and not address:find(":", 1, true) and not row.domain then
                        row.domain, row.domain_evidence = cut(address, 253), "xray-destination"
                    end
                    evidence(row, "xray-access", line)
                end
            end
        end
        -- DNS associations are candidates, never authoritative hostname attribution.
        if line:find("dnsmasq", 1, true) then
            local name, ip = line:match("query%[[^%]]+%] (%S+) from (%S+)")
            if ip == r.device and #self.dns_queries < 100 then
                name = cut(name, 253); queries[name] = now
                self.dns_queries[#self.dns_queries + 1] = { domain = name, time = now }
            end
            local domain, answer = line:match("reply (%S+) is (%S+)")
            if not domain then domain, answer = line:match("cached (%S+) is (%S+)") end
            if domain and queries[domain] and now - queries[domain] <= 10 and M.ipv4(answer) then
                if not associations[answer] then
                    if association_count >= 500 then return end
                    association_count = association_count + 1; associations[answer] = {}
                end
                if #associations[answer] < 8 then associations[answer][#associations[answer] + 1] = domain end
            end
        end
    end
    function self.trace(line, now)
        local id = line:match("^trace id (%x+) ")
        if not id or #line > 8192 then return end
        local source = line:match("ip saddr ([%d.]+)")
        if source == r.device then
            local destination = line:match("ip daddr ([%d.]+)")
            local network, sport = line:match("(tcp) sport (%d+)")
            if not network then network, sport = line:match("(udp) sport (%d+)") end
            local port = line:match("[tu][cd]p dport (%d+)")
            local row = flow(tonumber(sport), destination, tonumber(port), network, now)
            if row and not traces[id] then
                if trace_count >= 1024 then self.dropped = self.dropped + 1; return end
                trace_count = trace_count + 1; traces[id] = row
                evidence(row, "nft-packet", line)
            end
        end
        local row = traces[id]
        if not row then return end
        if line:find(" inet fw4 xray_prerouting rule ", 1, true) then
            local reason
            if line:find("ip daddr @xray_cn4", 1, true) and line:find("verdict return", 1, true) then reason = "CN-FASTPATH"
            elseif line:find("ip daddr @xray_reserved4", 1, true) and line:find("verdict return", 1, true) then reason = "RESERVED-BYPASS"
            elseif line:find("ip daddr @xray_proxy_servers4", 1, true) and line:find("verdict return", 1, true) then reason = "PROXY-ENDPOINT-BYPASS"
            elseif line:find("fib daddr type local", 1, true) and line:find("verdict return", 1, true) then reason = "ROUTER-LOCAL"
            elseif line:find("meta mark", 1, true) and line:find("verdict return", 1, true) then reason = "MARK-BYPASS" end
            if reason then
                row.kernel = reason
                row.path = reason == "ROUTER-LOCAL" and "router-local" or "kernel-direct"
                row.outcome = "Kernel bypass; outcome unknown"
                evidence(row, "nft-rule", line)
            elseif line:find("tproxy", 1, true) and line:find("verdict accept", 1, true) then
                row.kernel = "TPROXY"
                evidence(row, "nft-rule", line)
            end
        end
        if line:find("verdict drop", 1, true) or line:find(" reject ", 1, true) then
            row.outcome, row.error = "Firewall blocked", cut(line)
            evidence(row, "nft-block", line)
        end
    end
    function self.result()
        for _, row in ipairs(self.rows) do
            row.dns_candidates = associations[row.destination] or {}
            local p = row.path
            local known = p ~= "unknown" and p ~= "router-local" and p ~= "dns-out"
            local matches = r.expected == "any" or p == r.expected
                or (r.expected == "direct" and p == "kernel-direct")
                or (r.expected == "proxy" and (p == "proxy-main" or p == "proxy-backup"))
            row.mismatch = known and not matches or false
        end
        return { rows = self.rows, dns_queries = self.dns_queries, dropped = self.dropped }
    end
    return self
end
return M
