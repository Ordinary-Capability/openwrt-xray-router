-- XRAY_ROUTER_PROJECT: LuCI backend. Dependencies are injected for isolated tests.
local M = {}
local files = { "config.json", "settings.conf", "nodes.json" }
local proxy_tags = { "proxy-main", "proxy-backup", "proxy-stream", "proxy-stream2" }
local stream_disabled_tag = "xray-router-stream-disabled"
local streams = {
    { tag = "proxy-stream", rule = "STREAMING-PROXY", after = "FORCE-DIRECT", placeholder = "domain:example-stream.invalid" },
    { tag = "proxy-stream2", rule = "STREAMING2-PROXY", after = "STREAMING-PROXY", placeholder = "domain:example-stream2.invalid" }
}
local function check(ok, message) if not ok then error(message, 0) end end
local function equal(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= "table" then return a == b end
    for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
end
local function optional(list, key, value)
    local found
    for _, item in ipairs(list or {}) do
        if item[key] == value then
            check(not found, "Duplicate " .. value)
            found = item
        end
    end
    return found
end
local function named(list, key, value)
    local found = optional(list, key, value)
    check(found, "Missing " .. value .. "; merge the current project configuration first")
    return found
end
local function streaming_scope(config, tags)
    if type(tags) ~= "table" or #tags == 0 then return false end
    local seen, count = {}, 0
    for key, tag in pairs(tags) do
        if type(key) ~= "number" or key < 1 or key > #tags or key % 1 ~= 0 or
            type(tag) ~= "string" or seen[tag] or tag == stream_disabled_tag then return false end
        if tag ~= "tproxy-in" then
            local inbound = optional(config.inbounds, "tag", tag)
            if not inbound or (inbound.protocol ~= "socks" and inbound.protocol ~= "http") then return false end
        end
        seen[tag], count = true, count + 1
    end
    return seen["tproxy-in"] and count == #tags
end
local function ensure_streaming(config, slot)
    if not optional(config.outbounds, "tag", slot.tag) then
        table.insert(config.outbounds, { tag = slot.tag, protocol = "blackhole",
            settings = { response = { type = "none" } } })
    end
    if not optional(config.routing.rules, "ruleTag", slot.rule) then
        local direct = named(config.routing.rules, "ruleTag", slot.after)
        for index, rule in ipairs(config.routing.rules) do
            if rule == direct then
                table.insert(config.routing.rules, index + 1, { type = "field",
                    inboundTag = { stream_disabled_tag }, domain = { slot.placeholder },
                    outboundTag = slot.tag, ruleTag = slot.rule })
                break
            end
        end
    end
end
local function valid_domains(domains)
    check(type(domains) == "table" and #domains > 0, "Domain lists must not be empty")
    local count = 0
    for key, value in pairs(domains) do
        count = count + 1
        check(type(key) == "number" and key >= 1 and key <= #domains and key % 1 == 0,
            "Domain list must be an array")
        check(type(value) == "string" and value ~= "" and #value <= 512 and not value:find("[%c%s]"), "Invalid domain rule")
    end
    check(count == #domains, "Domain list must be an array")
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
    -- luci.jsonc loses the distinction between {} and [] in Lua tables. Splice
    -- only the requested member so logging changes retain every other byte,
    -- including empty protocol settings, nulls and large numeric values.
    local function replace_member(raw, key, update)
        local function whitespace(pos)
            while raw:sub(pos, pos):match("%s") do pos = pos + 1 end
            return pos
        end
        local function string_end(pos)
            check(raw:sub(pos, pos) == '"', "Expected a JSON member name")
            pos = pos + 1
            while pos <= #raw do
                local char = raw:sub(pos, pos)
                if char == '"' then return pos + 1 end
                pos = pos + (char == '\\' and 2 or 1)
            end
            error("Unterminated JSON string", 0)
        end
        local opening = whitespace(1)
        check(raw:sub(opening, opening) == "{", "Logging settings must be a JSON object")
        local pos, first, last = whitespace(opening + 1)
        local has_members = raw:sub(pos, pos) ~= "}"
        while raw:sub(pos, pos) ~= "}" do
            local name_end = string_end(pos)
            local name = parse("[" .. raw:sub(pos, name_end - 1) .. "]")[1]
            pos = whitespace(name_end)
            check(raw:sub(pos, pos) == ":", "Expected a JSON member value")
            local start = whitespace(pos + 1)
            pos = start
            local depth = 0
            while pos <= #raw do
                local char = raw:sub(pos, pos)
                if char == '"' then pos = string_end(pos)
                elseif depth == 0 and (char == "," or char == "}") then break
                else
                    if char == "{" or char == "[" then depth = depth + 1
                    elseif char == "}" or char == "]" then depth = depth - 1 end
                    pos = pos + 1
                end
            end
            check(pos <= #raw, "Unterminated JSON object")
            if name == key then
                check(not first, "Duplicate JSON member: " .. key)
                first, last = start, pos - 1
                while raw:sub(last, last):match("%s") do last = last - 1 end
            end
            if raw:sub(pos, pos) == "," then pos = whitespace(pos + 1) end
        end
        check(whitespace(pos + 1) > #raw, "Unexpected data after JSON object")
        if first then return raw:sub(1, first - 1) .. update(raw:sub(first, last)) .. raw:sub(last + 1) end
        return raw:sub(1, opening) .. d.json.stringify(key) .. ":" .. update(nil) ..
            (has_members and "," or "") .. raw:sub(opening + 1)
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
    local function copy(value) return parse(d.json.stringify(value)) end
    local function without_tag(outbound)
        local value = copy(outbound)
        value.tag = nil
        return value
    end
    local function validate_library(raw)
        check(type(raw) == "string" and #raw <= 262144, "Node library exceeds 256 KiB")
        local library = parse(raw)
        check(library.version == 1 and type(library.nodes) == "table" and type(library.bindings) == "table", "Invalid node library")
        for key in pairs(library) do check(key == "version" or key == "nodes" or key == "bindings", "Unknown library field") end
        local count, aliases = 0, {}
        for id, node in pairs(library.nodes) do
            count = count + 1
            check(type(id) == "string" and #id <= 64 and id:match("^node%-%w[%w%-]*$"), "Invalid node ID")
            check(type(node) == "table", "Invalid proxy node")
            for key in pairs(node) do check(key == "alias" or key == "outbound", "Unknown node field") end
            local alias = node.alias
            check(type(alias) == "string" and #alias > 0 and #alias <= 64 and not alias:find("%c") and
                alias == alias:match("^%s*(.-)%s*$"), "Enter a node alias (1–64 bytes, without surrounding whitespace)")
            check(not aliases[alias:lower()], "Node aliases must be unique")
            aliases[alias:lower()] = true
            local outbound = node.outbound
            check(type(outbound) == "table" and type(outbound.protocol) == "string" and outbound.protocol:match("^[%w%-]+$"), "Invalid node outbound")
            check(outbound.tag == nil, "Node JSON must not contain a tag; tags belong to assignments")
            for key in pairs(outbound) do check(type(key) == "string", "Node outbound must be an object") end
        end
        check(count <= 64, "At most 64 proxy nodes are supported")
        for tag in pairs(library.bindings) do
            check(tag == "proxy-main" or tag == "proxy-backup" or tag == "proxy-stream" or tag == "proxy-stream2", "Unknown outbound assignment")
        end
        -- Extend existing version 1 libraries in memory; get() never writes files.
        if library.bindings["proxy-stream2"] == nil then library.bindings["proxy-stream2"] = "" end
        for _, tag in ipairs(proxy_tags) do
            local id = library.bindings[tag]
            check(type(id) == "string" and (id == "" or library.nodes[id]), "Assignment refers to a missing node: " .. tag)
        end
        return library
    end
    local function resolved(library, config, tag)
        local id = library.bindings[tag]
        if id ~= "" then
            local outbound = copy(library.nodes[id].outbound)
            outbound.tag = tag
            return outbound
        end
        local previous = optional(config.outbounds, "tag", tag)
        if previous and previous.protocol == "blackhole" then return copy(previous) end
        return { tag = tag, protocol = "blackhole", settings = { response = { type = "none" } } }
    end
    local function library_for(config, raw)
        local library = raw and validate_library(raw) or { version = 1, nodes = {}, bindings = {} }
        local imported = false
        for _, tag in ipairs(proxy_tags) do
            local outbound = optional(config.outbounds, "tag", tag)
            local id = library.bindings[tag]
            if not raw or (outbound and not equal(resolved(library, config, tag), outbound)) then
                imported = imported or raw ~= nil
                library.bindings[tag] = ""
                if outbound and outbound.protocol ~= "blackhole" then
                    local base = "node-" .. tag
                    id = base
                    local n = 1
                    while library.nodes[id] do n = n + 1; id = base .. "-" .. n end
                    local alias = tag == "proxy-main" and outbound.protocol == "socks" and "host-socks" or tag:gsub("^proxy%-", "")
                    local base_alias, used = alias, {}
                    for _, node in pairs(library.nodes) do used[node.alias:lower()] = true end
                    n = 1
                    while used[alias:lower()] do n = n + 1; alias = base_alias .. "-" .. n end
                    library.nodes[id] = { alias = alias, outbound = without_tag(outbound) }
                    library.bindings[tag] = id
                end
            end
        end
        return library, imported
    end
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
        -- Normalize only missing legacy streaming objects, then compare all other fields.
        local tags = { "proxy-main", "proxy-backup" }
        for _, slot in ipairs(streams) do
            local stream = optional(new.outbounds, "tag", slot.tag)
            local stream_rule = optional(new.routing.rules, "ruleTag", slot.rule)
            if stream or stream_rule then
                check(stream and stream_rule, "Streaming requires both an outbound and a routing rule: " .. slot.tag)
                ensure_streaming(old, slot)
                tags[#tags + 1] = slot.tag
                valid_domains(stream_rule.domain)
                local enabled = streaming_scope(old, stream_rule.inboundTag)
                check(enabled or equal(stream_rule.inboundTag, { stream_disabled_tag }), "Invalid streaming inbound scope: " .. slot.tag)
                check(not optional(new.inbounds, "tag", stream_disabled_tag), "Reserved streaming disable tag is used by an inbound")
                -- The shipped inactive rule is accepted unchanged, including by older UI clients.
                local empty = equal(stream_rule.domain, { slot.placeholder })
                check(not enabled or empty or stream.protocol ~= "blackhole", "Configure the streaming node before enabling streaming routing: " .. slot.tag)
                local previous_rule = named(old.routing.rules, "ruleTag", slot.rule)
                check(not enabled or not empty or equal(previous_rule, stream_rule), "Add at least one streaming domain or service preset: " .. slot.tag)
                previous_rule.domain = stream_rule.domain
                previous_rule.inboundTag = stream_rule.inboundTag
            end
        end
        -- Allow changes only to named nodes, health probes and exposed domain lists.
        for _, tag in ipairs(tags) do
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
            valid_domains(b.domain)
            a.domain = b.domain
        end
        check(equal(old, new), "Only named outbounds, probe URL/interval, domain lists and streaming enablement can be edited here; DNS and other routing must stay unchanged")
    end
    local function snapshot()
        local out = {}
        for _, name in ipairs(files) do
            if name == "nodes.json" then out[name] = d.read(conf .. "/" .. name) or false
            else out[name] = read(conf .. "/" .. name) end
        end
        return out
    end
    local function put(directory, contents)
        for _, name in ipairs(files) do
            local path = directory .. "/" .. name
            if contents[name] then
                if d.read(path) ~= contents[name] then d.atomic(path, contents[name]) end
            elseif d.read(path) then d.remove(path); check(not d.read(path), "Cannot remove " .. path) end
        end
    end
    local function validate(candidate)
        d.mkdir(work .. "/candidate")
        put(work .. "/candidate", candidate)
        for _, name in ipairs({ "cn-ipv4.txt", "proxy-server-ipv4.txt" }) do
            d.atomic(work .. "/candidate/" .. name, read(conf .. "/" .. name))
        end
        return d.run("firewall-check", work .. "/candidate")
    end
    local function apply(candidate, expected, rollback)
        check(expected == revision(), "Configuration changed since this page loaded; reload before saving")
        local previous, running = snapshot(), d.running()
        -- Preserve exact runtime bytes for metadata-only saves.
        if equal(parse(candidate["config.json"]), parse(previous["config.json"])) then candidate["config.json"] = previous["config.json"] end
        local runtime_changed = candidate["config.json"] ~= previous["config.json"] or candidate["settings.conf"] ~= previous["settings.conf"] or
            (rollback and d.read(pending) ~= nil)
        local code, output = 0, ""
        -- Xray validates during its real startup. Only changed routing settings
        -- require a firewall dry run; logging and node edits leave policy alone.
        if candidate["settings.conf"] ~= previous["settings.conf"] or (rollback and d.read(pending)) then
            code, output = validate(candidate)
        end
        if code ~= 0 then return result(code, "Validation failed; current files retained.\n" .. output) end
        check(expected == revision(), "Configuration changed during apply; reload before saving")
        d.mkdir(conf .. "/backups")
        d.mkdir(backup)
        -- An interrupted transaction already has the correct recovery snapshot.
        if not d.read(pending) then put(backup, previous) end
        d.atomic(pending, "Restore backups/luci-last if an apply is interrupted.\n")
        local installed, failure = pcall(function()
            put(conf, candidate)
            if running and runtime_changed then
                local rc, text = d.run("restart")
                output = output .. "\n" .. text
                check(rc == 0, "Service restart failed")
            end
        end)
        if not installed then
            local restored, restore_error = pcall(function()
                -- Restore the last complete snapshot, also after a partial file write.
                local safe = {}
                for _, name in ipairs(files) do
                    if name == "nodes.json" then safe[name] = d.read(backup .. "/" .. name) or false
                    else safe[name] = read(backup .. "/" .. name) end
                end
                put(conf, safe)
                if running and runtime_changed then
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
            (not runtime_changed and " Running configuration unchanged; no restart." or running and " Service restarted." or " Service remains stopped; Xray configuration will be checked on next start."))
    end

    function self.get()
        local before = revision()
        local response = { config = read(conf .. "/config.json"), settings = settings(read(conf .. "/settings.conf")),
            revision = before, rollback_available = d.read(backup .. "/config.json") ~= nil,
            recovery_required = d.read(pending) ~= nil }
        local library, imported = library_for(parse(response.config), d.read(conf .. "/nodes.json"))
        response.nodes = d.json.stringify(library)
        response.nodes_notice = imported and "Outbounds changed outside the node library. Current outbounds were imported into this draft; review and save to keep these assignments." or ""
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
        if action == "test-node" then
            check(type(request.config) == "string" and #request.config <= 262144, "Node JSON exceeds 256 KiB")
            local node = parse(request.config)
            -- Reuse the same node validation as library saves, including tag ownership.
            validate_library(d.json.stringify({ version = 1, nodes = { ["node-test"] = { alias = "test", outbound = node } },
                bindings = { ["proxy-main"] = "", ["proxy-backup"] = "", ["proxy-stream"] = "", ["proxy-stream2"] = "" } }))
            return d.test_node(node)
        end
        local changes_stack = { save=true, rollback=true, start=true, restart=true,
            ["firewall-reload"]=true, ["update-cn"]=true, ["logging-info"]=true, ["logging-warning"]=true }
        if changes_stack[action] and d.capture_active then
            check(not d.capture_active(), "Stop the traffic capture before changing the running stack")
        end
        if action == "logging-info" or action == "logging-warning" then
            check(not d.read(pending), "Interrupted apply detected; restore the previous configuration first")
            local candidate = snapshot()
            parse(candidate["config.json"])
            candidate["config.json"] = replace_member(candidate["config.json"], "log", function(log)
                return replace_member((not log or log == "null") and "{}" or log, "loglevel", function()
                    return action == "logging-info" and '"info"' or '"warning"'
                end)
            end)
            return apply(candidate, request.revision)
        end
        if action == "save" then
            check(not d.read(pending), "Interrupted apply detected; restore the previous configuration first")
            local previous = snapshot()
            validate_edit(previous["config.json"], request.config)
            local raw = append_settings(previous["settings.conf"], request.settings)
            if equal(settings(previous["settings.conf"]), request.settings) then raw = previous["settings.conf"] end
            local config = parse(request.config)
            local library
            if request.nodes and request.nodes ~= "" then
                library = validate_library(request.nodes)
                for _, tag in ipairs(proxy_tags) do
                    local outbound = optional(config.outbounds, "tag", tag)
                    -- A cached older UI may save a config without the optional new slot.
                    check((tag == "proxy-stream2" and not outbound and library.bindings[tag] == "") or
                        equal(resolved(library, config, tag), outbound), "Node assignment does not match outbound: " .. tag)
                end
            else
                library = library_for(config, previous["nodes.json"] or nil)
            end
            return apply({ ["config.json"] = request.config, ["settings.conf"] = raw,
                ["nodes.json"] = d.json.stringify(library) .. "\n" }, request.revision)
        elseif action == "rollback" then
            local candidate = {}
            for _, name in ipairs(files) do
                if name == "nodes.json" then candidate[name] = d.read(backup .. "/" .. name) or false
                else candidate[name] = read(backup .. "/" .. name) end
            end
            return apply(candidate, request.revision, true)
        end
        check(not d.read(pending) or action == "stop", "Interrupted apply detected; restore the previous configuration first")
        local allowed = { start = true, stop = true, restart = true, enable = true,
            disable = true, validate = true, doctor = true, ["firewall-reload"] = true, ["update-cn"] = true }
        check(allowed[action], "Unknown management action")
        local code, output = d.run(action)
        return result(code, output)
    end
    return self
end
return M
