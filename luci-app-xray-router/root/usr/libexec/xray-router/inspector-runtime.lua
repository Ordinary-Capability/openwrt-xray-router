-- OpenWrt process/file adapter. Capture never edits config or restarts a service.
-- Optional injected adapters allow lifecycle tests without router networking.
local deps = ... or {}
local json = require "luci.jsonc"
local fs = require "nixio.fs"
local nixio = require "nixio"
local parser = dofile("/usr/libexec/xray-router/inspector.lua")
local M = {}
local work = "/tmp/xray-router-inspector"
local script = "/usr/libexec/rpcd/luci.xray-inspector"
local table_name = "xray_router_inspect"
local function now()
    if deps.now then return deps.now() end
    local seconds, micros = nixio.gettimeofday()
    return seconds + (micros or 0) / 1000000
end
local function read(path) return fs.readfile(path) end
local function state() return json.parse(read(work .. "/state") or "{}") or {} end
local function mkdir()
    local info = fs.lstat(work)
    if info then assert(info.type == "dir" and info.uid == 0, "Unsafe capture directory")
    else assert(fs.mkdir(work, "700"), "Cannot create capture directory") end
    assert(fs.chmod(work, "700"), "Cannot protect capture directory")
end
local function atomic(path, data)
    local temporary = path .. ".new"
    fs.unlink(temporary)
    local fd = assert(nixio.open(temporary, "w", "600"), "Cannot write capture state")
    local ok = fd:writeall(data)
    fd:close()
    assert(ok and fs.rename(temporary, path), "Cannot replace capture state")
end
local function save(value) atomic(work .. "/state", json.stringify(value)) end
-- Process-scoped advisory locking also releases on RPC crashes. Keep the file
-- in place: unlinking a locked inode would allow a second independent lock.
local function control(callback, wait)
    mkdir()
    local fd = assert(nixio.open(work .. "/control", "w", "600"), "Cannot open capture control lock")
    local locked = fd:lock(wait and "lock" or "tlock")
    if not locked then fd:close(); error("Capture control is busy; retry shortly") end
    local ok, result = pcall(callback)
    fd:lock("ulock"); fd:close()
    if not ok then error(result) end
    return result
end
local function alive(value)
    if not value.active then return false end
    if not value.pid then return now() - (value.started or 0) < 10 end
    local command = read("/proc/" .. value.pid .. "/cmdline") or ""
    return command:find(script .. "\0worker\0" .. value.id .. "\0", 1, true) ~= nil
        and nixio.kill(value.pid, 0)
end
local function spawn(argv)
    local reader, writer = assert(nixio.pipe())
    assert(writer, "Cannot create process pipe")
    local pid = nixio.fork()
    if not pid then reader:close(); writer:close(); error("Cannot start capture helper") end
    if pid == 0 then
        reader:close()
        local null = assert(nixio.open("/dev/null", "r"))
        nixio.dup(null, nixio.stdin); null:close()
        nixio.dup(writer, nixio.stdout); nixio.dup(writer, nixio.stderr); writer:close()
        nixio.execp(argv[1], unpack(argv, 2))
        os.exit(127)
    end
    writer:close(); reader:setblocking(false)
    return { pid = pid, fd = reader, buffer = "", discarded = false }
end
spawn = deps.spawn or spawn
local function finish(child)
    if child.fd then child.fd:close(); child.fd = nil end
    if not child.done then
        local pid = nixio.waitpid(child.pid, "nohang")
        if not pid or pid == 0 then nixio.kill(child.pid, 9); nixio.waitpid(child.pid) end
        child.done = true
    end
end
local function command(argv, timeout)
    local child, chunks, size = spawn(argv), {}, 0
    local deadline, code = now() + (timeout or 3), nil
    repeat
        nixio.poll({ { fd = child.fd, events = nixio.poll_flags("in", "hup") } }, 100)
        for _ = 1, 64 do
            local text = child.fd:read(4096)
            if not text or text == "" then break end
            size = size + #text
            if size > 65536 then finish(child); error("Helper output exceeds limit") end
            chunks[#chunks + 1] = text
        end
        local pid, why, exit = nixio.waitpid(child.pid, "nohang")
        if pid and pid > 0 then
            child.done = true
            code = why == "exited" and exit or 1
            -- Drain bytes emitted between the last read and the exit notification.
            for _ = 1, 16 do
                local text = child.fd:read(4096)
                if not text or text == "" then break end
                size = size + #text
                if size > 65536 then finish(child); error("Helper output exceeds limit") end
                chunks[#chunks + 1] = text
            end
        end
    until code ~= nil or now() >= deadline
    finish(child)
    return code or 124, table.concat(chunks)
end
command = deps.command or command
local function cleanup(token)
    local code, output = command({ "nft", "-j", "list", "table", "inet", table_name })
    if code ~= 0 then
        -- Verify absence separately; permission/command errors must not be reported as success.
        local listed, all = command({ "nft", "-j", "list", "tables" })
        if listed ~= 0 then return false, "Cannot verify capture table cleanup: " .. all:sub(1, 300) end
        local data = json.parse(all)
        if not data then return false, "Cannot parse nftables table list" end
        for _, item in ipairs(data.nftables or {}) do
            if item.table and item.table.family == "inet" and item.table.name == table_name then
                return false, "Cannot inspect existing capture table"
            end
        end
        return true
    end
    local data, owned, missing_comment = json.parse(output), false, false
    for _, item in ipairs(data and data.nftables or {}) do
        if item.table and item.table.name == table_name and item.table.family == "inet" then
            owned = item.table.comment == "XRAY_ROUTER_INSPECTOR:" .. tostring(token)
            missing_comment = item.table.comment == nil
        end
    end
    -- nft 1.0.2 omits table comments from JSON. Only accept the table's own
    -- leading comment in text output, never a comment on a nested rule/set.
    if not owned and missing_comment then
        local listed, text = command({ "nft", "list", "table", "inet", table_name })
        local comment = listed == 0 and text:match('^%s*table inet xray_router_inspect%s*{%s*comment "([^"]+)"')
        owned = comment == "XRAY_ROUTER_INSPECTOR:" .. tostring(token)
    end
    if not owned then return false, "Refusing to remove an unrelated capture table" end
    local removed, message = command({ "nft", "delete", "table", "inet", table_name })
    return removed == 0, removed == 0 and nil or message:sub(1, 300)
end
local function warning(value, text)
    value.warnings = value.warnings or {}
    if #value.warnings < 12 then value.warnings[#value.warnings + 1] = text end
end
local function launch(token)
    if deps.launch then return deps.launch(token) end
    local pid = assert(nixio.fork(), "Cannot start capture worker")
    if pid == 0 then
        nixio.setsid()
        local null = assert(nixio.open("/dev/null", "r+"))
        nixio.dup(null, nixio.stdin); nixio.dup(null, nixio.stdout); nixio.dup(null, nixio.stderr); null:close()
        nixio.exec("/usr/bin/lua", script, "worker", token)
        os.exit(127)
    end
end
function M.get()
    local value = state()
    if value.active and not alive(value) then
        value.active = false
        value.interrupted = true
        warning(value, "Collector stopped unexpectedly. The tracing source expires automatically; use Stop / clean up to remove its table.")
    end
    value.rows = value.rows or {}
    return value
end
function M.options()
    local config = json.parse(read("/etc/xray-router/config.json") or "{}") or {}
    local logging = config.log or {}
    local notices = {}
    if logging.loglevel ~= "info" and logging.loglevel ~= "debug" then
        notices[#notices + 1] = "Rule names, sniffed domains and detailed errors may be missing at the saved log level. Capture will not change it."
    end
    if (logging.access and logging.access ~= "") or (logging.error and logging.error ~= "") then
        notices[#notices + 1] = "This inspector reads the system log. Custom log files or disabled access/error logs are not collected."
    end
    return { devices = parser.devices(read("/tmp/dhcp.leases"), read("/proc/net/arp")),
        loglevel = logging.loglevel or "warning", notices = notices, capture = M.get() }
end
local function start(request)
    local selected = parser.request(request)
    assert(not fs.stat("/tmp/xray-router-ui/lock"), "Wait for the management operation to finish")
    local interfaces = parser.interfaces("\n" .. assert(read("/etc/xray-router/settings.conf")) .. "\n")
    mkdir()
    local previous = state()
    assert(not alive(previous), "A capture is already running")
    -- Atomic acquisition; give a new locker time to publish its state before
    -- considering recovery. Never remove another caller's newly acquired lock.
    if not fs.mkdir(work .. "/lock", "700") then
        previous = state()
        local lock = fs.stat(work .. "/lock")
        assert(lock and now() - lock.mtime > 10 and previous.id and not alive(previous), "Capture startup is already in progress")
        local cleaned, message = cleanup(previous.id)
        assert(cleaned, message)
        assert(fs.rmdir(work .. "/lock"), "Cannot clear stale capture lock")
        assert(fs.mkdir(work .. "/lock", "700"), "A capture is already starting")
    end
    local token = tostring(nixio.getpid()) .. "-" .. string.format("%.0f", now() * 1000000)
    local value = { id = token, active = true, started = now(), device = selected.device,
        duration = selected.duration, expected = selected.expected, rows = {}, warnings = {} }
    value.expires = value.started + selected.duration
    local ok, err = pcall(function()
        assert(not fs.stat("/tmp/xray-router-ui/lock"), "Wait for the management operation to finish")
        if previous.id then
            local cleaned, message = cleanup(previous.id)
            if not cleaned then value = previous; value.active = false; error(message) end
        end
        atomic(work .. "/rules.nft", parser.rules(selected, interfaces, token))
        fs.unlink(work .. "/stop")
        save(value)
        launch(token)
    end)
    if not ok then
        value.active = false; warning(value, tostring(err)); save(value)
        fs.rmdir(work .. "/lock"); error(err)
    end
    return value
end
function M.start(request) return control(function() return start(request) end) end
local function stop(request)
    mkdir()
    local value = state()
    assert(type(value.id) == "string" and request.id == value.id, "Capture changed; refresh before stopping")
    atomic(work .. "/stop", value.id)
    if not alive(value) then
        local ok, message = cleanup(value.id)
        value.active = false
        if not ok then warning(value, message) end
        save(value)
        if ok then fs.rmdir(work .. "/lock") end
    end
    return M.get()
end
function M.stop(request) return control(function() return stop(request) end) end
function M.worker(token)
    local value = control(function()
        local current = state()
        assert(current.id == token and current.active, "Capture worker is obsolete")
        current.pid = nixio.getpid(); save(current)
        return current
    end, true)
    local model, children, attempted_install = parser.new(value, value.started), {}, false
    local last_save = 0
    local initial_config = read("/etc/xray-router/config.json")
    local initial_settings = read("/etc/xray-router/settings.conf")
    local function publish()
        local result = model.result()
        value.rows = {}
        for index, row in ipairs(result.rows) do value.rows[index] = row end
        value.dns_queries, value.dropped = result.dns_queries, result.dropped
        -- Keep each RPC response well below the ubus message limit, even when
        -- attacker-controlled hostnames/errors contain JSON escape characters.
        local encoded = json.stringify(value)
        while #encoded > 196608 and #value.rows > 0 do
            table.remove(value.rows); value.dropped = value.dropped + 1
            encoded = json.stringify(value)
        end
        if state().id == token then atomic(work .. "/state", encoded) end
        last_save = now()
    end
    local ok, err = pcall(function()
        local code, output = command({ "nft", "-j", "list", "tables" })
        assert(code == 0, "nftables tracing unavailable: " .. output:sub(1, 300))
        local tables = assert(json.parse(output), "Cannot parse nftables tables")
        for _, item in ipairs(tables.nftables or {}) do
            assert(not (item.table and item.table.family == "inet" and item.table.name == table_name),
                "Capture table already exists; stop / clean up the previous capture first")
        end
        children[1] = spawn({ "nft", "monitor", "trace" })
        children[1].kind = "nft"
        children[2] = spawn({ "logread", "-f", "-l", "0" })
        children[2].kind = "log"
        -- No firewall reload: install just the expiring observation table.
        attempted_install = true
        code, output = command({ "nft", "-f", work .. "/rules.nft" })
        assert(code == 0, "Cannot enable nftables tracing: " .. output:sub(1, 300))
        while now() < value.expires and read(work .. "/stop") ~= token do
            local descriptors = {}
            for _, child in ipairs(children) do
                if not child.done then descriptors[#descriptors + 1] = { fd = child.fd, events = nixio.poll_flags("in", "hup") } end
            end
            if #descriptors == 0 then error("Both capture listeners stopped") end
            nixio.poll(descriptors, 200)
            for _, child in ipairs(children) do
                if not child.done then
                    for _ = 1, 32 do
                        local text = child.fd:read(4096)
                        if not text or text == "" then break end
                        child.buffer = child.buffer .. text
                        while child.buffer:find("\n", 1, true) do
                            local pos = child.buffer:find("\n", 1, true)
                            local line = child.buffer:sub(1, pos - 1)
                            child.buffer = child.buffer:sub(pos + 1)
                            if not child.discarded then
                                if child.kind == "nft" then model.trace(line, now()) else model.log(line, now()) end
                            end
                            child.discarded = false
                        end
                        if #child.buffer > 8192 then child.buffer = ""; child.discarded = true end
                    end
                    local pid, why, exit = nixio.waitpid(child.pid, "nohang")
                    if pid and pid > 0 then
                        child.done = true
                        warning(value, child.kind .. " listener stopped (" .. tostring(why) .. ": " .. tostring(exit) .. ")")
                    end
                end
            end
            if now() - last_save >= 2 then publish() end
        end
    end)
    for _, child in ipairs(children) do finish(child) end
    if not ok then warning(value, tostring(err):sub(1, 500)) end
    control(function()
        if state().id ~= token then return end
        local cleaned = true
        if attempted_install then
            local called, removed, message = pcall(cleanup, token)
            cleaned = called and removed
            if not cleaned then warning(value, "Cleanup failed; tracing will expire: " .. tostring(called and message or removed)) end
        end
        if read("/etc/xray-router/config.json") ~= initial_config or read("/etc/xray-router/settings.conf") ~= initial_settings then
            warning(value, "Configuration changed during capture; results may span different routing policies.")
        end
        value.active, value.finished = false, now()
        publish()
        fs.unlink(work .. "/rules.nft")
        if cleaned then fs.rmdir(work .. "/lock") end
    end, true)
end
return M
