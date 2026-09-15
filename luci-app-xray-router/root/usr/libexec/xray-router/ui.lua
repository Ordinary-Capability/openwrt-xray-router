-- XRAY_ROUTER_PROJECT: LuCI backend. Dependencies are injected for isolated tests.
local M = {}
local files = { "config.json", "settings.conf" }
local function check(ok, message) if not ok then error(message, 0) end end
local function equal(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= "table" then return a == b end
    for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
end
local function named(list, key, value)
    local found
    for _, item in ipairs(list or {}) do
        if item[key] == value then
            check(not found, "Duplicate " .. value)
            found = item
        end
    end
    check(found, "Missing " .. value .. "; merge the current project configuration first")
    return found
end

function M.new(d)
    local self = {}
    local conf = d.conf
    local work = d.work
    local backup = conf .. "/backups/luci-last"
    local pending = conf .. "/backups/luci-pending"
    local function read(path)
        local value = d.read(path)
        check(value ~= nil, "Cannot read " .. path)
        return value
    end
    local function parse(raw)
        local data = d.json.parse(raw)
        check(type(data) == "table", "Invalid JSON object")
        return data
    end
    local function result(code, output) return { code = code, output = output or "" } end
    local function settings(raw)
        local values = { LAN_INTERFACES = "br-lan", ENABLE_CN_FASTPATH = "1", IPV6_MODE = "block" }
        for line in raw:gmatch("[^\r\n]+") do
            local key, value = line:match('^%s*([A-Z_]+)%s*=%s*(.-)%s*$')
            if values[key] then
                value = value:gsub('%s+#.*$', '')
                local quoted = value:match('^"(.*)"$') or value:match("^'(.*)'$")
                values[key] = quoted or value
            end
        end
        return values
    end
    local function revision() return d.revision(files) end
    local function append_settings(raw, values)
        check(type(values) == "table", "Missing routing settings")
        for key in pairs(values) do
            check(key == "LAN_INTERFACES" or key == "ENABLE_CN_FASTPATH" or key == "IPV6_MODE", "Unknown routing setting")
        end
        local lan = values.LAN_INTERFACES
        check(type(lan) == "string" and #lan < 512 and lan:match("%S"), "Enter a LAN interface")
        for dev in lan:gmatch("%S+") do
            check(dev:match("^[%w_.:@+%-]+$"), "Invalid LAN interface name")
        end
        check(not lan:find("[\r\n]"), "Invalid LAN interface list")
        check(values.ENABLE_CN_FASTPATH == "0" or values.ENABLE_CN_FASTPATH == "1", "Invalid CN fast path")
        check(values.IPV6_MODE == "block" or values.IPV6_MODE == "bypass", "Invalid IPv6 mode")
        local lines = {}
        -- Only replace the three UI-owned assignments; retain other settings/comments.
        for line in (raw:gsub("\n$", "") .. "\n"):gmatch("([^\n]*)\n") do
            local key = line:match("^%s*([A-Z_]+)%s*=")
            if not values[key] and line ~= '# LuCI routing settings' then lines[#lines + 1] = line end
        end
        lines[#lines + 1] = '# LuCI routing settings'
        for _, key in ipairs({ "LAN_INTERFACES", "ENABLE_CN_FASTPATH", "IPV6_MODE" }) do
            lines[#lines + 1] = key .. '="' .. values[key] .. '"'
        end
        return table.concat(lines, "\n") .. "\n"
    end
    local function validate_edit(old_raw, raw)
        check(type(raw) == "string" and #raw <= 524288, "Configuration exceeds 512 KiB")
        local old, new = parse(old_raw), parse(raw)
        -- Allow changes only to nodes, health probes and the two domain lists.
        for _, tag in ipairs({ "proxy-main", "proxy-backup" }) do
            local a = named(old.outbounds, "tag", tag)
            local b = named(new.outbounds, "tag", tag)
            check(type(b.protocol) == "string" and b.protocol ~= "", "Missing outbound protocol")
            for k in pairs(a) do a[k] = nil end
            for k, v in pairs(b) do a[k] = v end
        end
        check(type(new.observatory) == "table", "Missing observatory")
        local url = new.observatory.probeUrl
        check(type(url) == "string" and #url <= 2048 and url:match("^https?://%S+$"), "Invalid HTTP(S) probe URL")
        local interval = new.observatory.probeInterval
        local seconds = type(interval) == "string" and tonumber(interval:match("^(%d+)s$"))
        check(seconds and seconds >= 1 and seconds <= 3600, "Probe interval must be 1–3600 seconds")
        old.observatory.probeUrl = url
        old.observatory.probeInterval = interval
        for _, tag in ipairs({ "FORCE-DIRECT", "FORCE-PROXY" }) do
            local a = named(old.routing.rules, "ruleTag", tag)
            local b = named(new.routing.rules, "ruleTag", tag)
            check(type(b.domain) == "table" and #b.domain > 0, "Domain lists must not be empty")
            for _, value in ipairs(b.domain) do
                check(type(value) == "string" and #value <= 512 and not value:find("[%c%s]"), "Invalid domain rule")
            end
            a.domain = b.domain
        end
        check(equal(old, new), "Only outbounds, probe URL/interval and force-domain lists can be edited here; DNS and other routing must stay unchanged")
    end
    local function snapshot()
        local out = {}
        for _, name in ipairs(files) do out[name] = read(conf .. "/" .. name) end
        return out
    end
    local function put(directory, contents)
        for _, name in ipairs(files) do d.atomic(directory .. "/" .. name, contents[name]) end
    end
    local function validate(candidate)
        d.mkdir(work .. "/candidate")
        put(work .. "/candidate", candidate)
        for _, name in ipairs({ "cn-ipv4.txt", "proxy-server-ipv4.txt" }) do
            d.atomic(work .. "/candidate/" .. name, read(conf .. "/" .. name))
        end
        return d.run("validate", work .. "/candidate")
    end
    local function apply(candidate, expected, rollback)
        check(expected == revision(), "Configuration changed since this page loaded; reload before saving")
        local code, output = validate(candidate)
        if code ~= 0 then return result(code, "Validation failed; current files retained.\n" .. output) end
        check(expected == revision(), "Configuration changed during validation; reload before saving")
        local previous, running = snapshot(), d.running()
        d.mkdir(conf .. "/backups")
        d.mkdir(backup)
        -- An interrupted transaction already has the correct recovery snapshot.
        if not d.read(pending) then put(backup, previous) end
        d.atomic(pending, "Restore backups/luci-last if an apply is interrupted.\n")
        local installed, failure = pcall(function()
            put(conf, candidate)
            if running then
                local rc, text = d.run("restart")
                output = output .. "\n" .. text
                check(rc == 0, "Service restart failed")
            end
        end)
        if not installed then
            local restored, restore_error = pcall(function()
                -- Restore the last complete snapshot, also after a partial file write.
                local safe = {}
                for _, name in ipairs(files) do safe[name] = read(backup .. "/" .. name) end
                put(conf, safe)
                if running then
                    local rc, text = d.run("restart")
                    output = output .. "\n" .. text
                    check(rc == 0, "Restored files, but service recovery failed; inspect diagnostics")
                end
                d.remove(pending)
            end)
            return result(1, tostring(failure) .. "\n" .. output .. "\n" ..
                (restored and "Previous configuration restored." or tostring(restore_error)))
        end
        d.remove(pending)
        return result(0, output .. "\n" .. (rollback and "Previous configuration restored." or "Configuration saved.") ..
            (running and " Service restarted." or " Service remains stopped."))
    end

    function self.get()
        local before = revision()
        local response = { config = read(conf .. "/config.json"), settings = settings(read(conf .. "/settings.conf")),
            revision = before, rollback_available = d.read(backup .. "/config.json") ~= nil,
            recovery_required = d.read(pending) ~= nil }
        check(before == revision(), "Configuration is being updated; retry loading the page")
        return response
    end
    function self.status()
        return { running = d.running(), enabled = d.enabled() }
    end
    function self.diagnostics(action)
        check(action == "status" or action == "logs", "Invalid read-only action")
        local code, output = d.run(action)
        return result(code, output)
    end
    function self.perform(request)
        local action = request.action
        if action == "save" then
            check(not d.read(pending), "Interrupted apply detected; restore the previous configuration first")
            local previous = snapshot()
            validate_edit(previous["config.json"], request.config)
            local raw = append_settings(previous["settings.conf"], request.settings)
            return apply({ ["config.json"] = request.config, ["settings.conf"] = raw }, request.revision)
        elseif action == "rollback" then
            local candidate = {}
            for _, name in ipairs(files) do candidate[name] = read(backup .. "/" .. name) end
            return apply(candidate, request.revision, true)
        end
        check(not d.read(pending) or action == "stop", "Interrupted apply detected; restore the previous configuration first")
        local allowed = { start = true, stop = true, restart = true, enable = true,
            disable = true, validate = true, doctor = true, ["firewall-reload"] = true }
        check(allowed[action], "Unknown management action")
        local code, output = d.run(action)
        return result(code, output)
    end
    return self
end
return M
