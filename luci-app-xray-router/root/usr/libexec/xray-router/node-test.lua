-- Isolated, bounded HTTPS probe. Never edits the service configuration or policy.
local json = require "luci.jsonc"
local fs = require "nixio.fs"
local nixio = require "nixio"
local M = { url = "https://www.gstatic.com/generate_204" }
local function now()
    local seconds, micros = nixio.gettimeofday()
    return seconds + (micros or 0) / 1000000
end
local function spawn(argv)
    local reader, writer = assert(nixio.pipe())
    assert(writer, "Cannot create probe pipe")
    local pid = nixio.fork()
    if not pid then reader:close(); writer:close(); error("Cannot start probe helper") end
    if pid == 0 then
        reader:close()
        local null = assert(nixio.open("/dev/null", "r"))
        nixio.dup(null, nixio.stdin); null:close()
        nixio.dup(writer, nixio.stdout); nixio.dup(writer, nixio.stderr); writer:close()
        nixio.execp(argv[1], unpack(argv, 2))
        os.exit(127)
    end
    writer:close(); reader:setblocking(false)
    return { pid = pid, fd = reader, output = "" }
end
local function drain(child)
    for _ = 1, 16 do
        local text = child.fd:read(4096)
        if not text or text == "" then break end
        child.output = (child.output .. text):sub(-8192)
    end
end
local function exited(child)
    if child.code ~= nil then return true end
    local pid, why, code = nixio.waitpid(child.pid, "nohang")
    if pid and pid > 0 then child.code = why == "exited" and code or 1; return true end
    return false
end
local function finish(child)
    if not child then return end
    if not exited(child) then nixio.kill(child.pid, 9); nixio.waitpid(child.pid) end
    if child.fd then child.fd:close(); child.fd = nil end
end
local function wait(child, seconds)
    local deadline = now() + seconds
    repeat
        nixio.poll({ { fd = child.fd, events = nixio.poll_flags("in", "hup") } }, 100)
        drain(child)
        if exited(child) then drain(child); return child.code, child.output end
    until now() >= deadline
    return 124, child.output
end
local function response(ok, message, milliseconds, status)
    return { code = ok and 0 or 1, output = message,
        node_test = { success = ok, message = message, latency_ms = milliseconds,
            http_status = status, url = M.url } }
end

function M.run(outbound, work)
    if not fs.access("/usr/bin/curl", "x") then
        return response(false, "Node testing requires curl. Install it with: opkg install curl")
    end
    if (outbound.proxySettings and outbound.proxySettings.tag) or
        (outbound.streamSettings and outbound.streamSettings.sockopt and outbound.streamSettings.sockopt.dialerProxy) then
        return response(false, "This node references another outbound. Standalone testing requires a self-contained node.")
    end
    local directory = work .. "/node-test-" .. nixio.getpid()
    local path = directory .. "/config.json"
    local validator, server, probe, watchdog, reservation
    local function remove_files() fs.unlink(path); fs.rmdir(directory) end
    local ok, result = pcall(function()
        assert(fs.mkdir(directory, "700"), "Cannot create temporary node test directory")
        reservation = assert(nixio.socket("inet", "stream"))
        assert(reservation:bind("127.0.0.1", 0), "Cannot reserve a loopback port")
        local _, port = reservation:getsockname()
        assert(port, "Cannot allocate probe port")
        local node = assert(json.parse(json.stringify(outbound)))
        node.tag = "node-under-test"
        local config = {
            log = { loglevel = "none" },
            inbounds = { { tag = "node-test-in", listen = "127.0.0.1", port = port,
                protocol = "socks", settings = { auth = "noauth", udp = false } } },
            outbounds = { node },
            routing = { rules = { { type = "field", inboundTag = { "node-test-in" }, outboundTag = node.tag } } }
        }
        local fd = assert(nixio.open(path, "w", "600"))
        local written = fd:writeall(json.stringify(config)); fd:close()
        assert(written, "Cannot write temporary probe configuration")
        validator = spawn({ "xray", "run", "-test", "-config", path })
        local code = wait(validator, 5)
        finish(validator); validator = nil
        if code ~= 0 then return response(false, "Xray rejected this node's configuration or validation timed out. Check its outbound JSON.") end
        reservation:close(); reservation = nil
        server = spawn({ "xray", "run", "-config", path })
        -- The watchdog also bounds the temporary server if the RPC worker dies.
        watchdog = assert(nixio.fork(), "Cannot start probe watchdog")
        if watchdog == 0 then
            server.fd:close()
            nixio.nanosleep(30)
            local cmdline = fs.readfile("/proc/" .. server.pid .. "/cmdline") or ""
            if cmdline:find(path .. "\0", 1, true) then nixio.kill(server.pid, 9) end
            remove_files()
            os.exit(0)
        end
        local ready, deadline = false, now() + 3
        repeat
            drain(server)
            if exited(server) then break end
            local socket = nixio.socket("inet", "stream")
            if socket then ready = socket:connect("127.0.0.1", port); socket:close() end
            if not ready then nixio.nanosleep(0, 100000000) end
        until ready or now() >= deadline
        if not ready or exited(server) then return response(false, "Temporary Xray listener could not start. Check the node configuration.") end
        probe = spawn({ "/usr/bin/curl", "-q", "-sS", "--connect-timeout", "5", "--max-time", "15",
            "--proxy", "socks5h://127.0.0.1:" .. port, "--noproxy", "", "--output", "/dev/null",
            "--write-out", "\nXRAY_NODE_TEST %{http_code} %{time_total}\n", M.url })
        local status, output = wait(probe, 17)
        finish(probe); probe = nil
        if exited(server) then return response(false, "Temporary Xray exited before the test completed.") end
        local http, elapsed = output:match("XRAY_NODE_TEST (%d+) ([%d.]+)")
        http, elapsed = tonumber(http), tonumber(elapsed)
        if status ~= 0 then
            local reason = output:gsub("\nXRAY_NODE_TEST[^\n]*\n", ""):gsub("%s+$", "")
            return response(false, (status == 124 or status == 28) and "Connection test timed out." or
                (reason ~= "" and reason:sub(1, 400) or "Connection failed (curl exit " .. status .. ")."))
        end
        if http ~= 204 or not elapsed then
            return response(false, "Test endpoint returned HTTP " .. tostring(http or "unknown") .. "; expected 204.", nil, http)
        end
        local milliseconds = math.floor(elapsed * 1000 + 0.5)
        return response(true, "Connected · " .. milliseconds .. " ms (HTTPS 204)", milliseconds, http)
    end)
    if reservation then reservation:close() end
    finish(probe); finish(server); finish(validator)
    if watchdog and watchdog > 0 then nixio.kill(watchdog, 9); nixio.waitpid(watchdog) end
    remove_files()
    return ok and result or response(false, "Node test failed: " .. tostring(result))
end
return M
