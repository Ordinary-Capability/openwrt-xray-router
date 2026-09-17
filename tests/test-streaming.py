#!/usr/bin/env python3
"""Exercise streaming routes with real Xray and local nodes; no Internet access."""
import copy
import json
import os
from pathlib import Path
import runpy
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
from contextlib import ExitStack
from http.server import ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
HELPERS = runpy.run_path(str(ROOT / "tests/test-failover.py"))
server = HELPERS["server"]
receive = HELPERS["receive"]
request_http = HELPERS["request_http"]
await_label = HELPERS["await_label"]
assert_unavailable = HELPERS["assert_unavailable"]


def luci_config(config, enabled, setup=False, second_enabled=None):
    """Generate the configuration through the actual browser model."""
    script = r'''
        const fs = require('fs');
        const model = new Function('baseclass', fs.readFileSync(process.argv[1], 'utf8'))({ extend: x => x });
        const raw = fs.readFileSync(0, 'utf8');
        const values = model.read(raw);
        values.stream_enabled = process.argv[2];
        if (process.argv[4] !== 'preserve') values.stream2_enabled = process.argv[4];
        if (process.argv[3] === 'setup') {
            values.stream = model.template('socks', 'proxy-stream');
            values.stream_domains = 'geosite:netflix\ngeosite:primevideo\nfull:overlap.hbo.com';
            values.stream2 = model.template('socks', 'proxy-stream2');
            values.stream2_domains = 'geosite:hbo\ngeosite:disney';
            values.stream2_enabled = '1';
        }
        process.stdout.write(model.build(raw, values));
    '''
    output = subprocess.run(['node', '-e', script,
        str(ROOT / 'luci-app-xray-router/htdocs/luci-static/resources/xray-router/model.js'),
        '1' if enabled else '0', 'setup' if setup else 'preserve',
        'preserve' if second_enabled is None else '1' if second_enabled else '0'],
        input=json.dumps(config), capture_output=True, text=True, check=True)
    return json.loads(output.stdout)


def request_udp(port, destination):
    """Send a domain-addressed SOCKS UDP datagram to a non-DNS destination port."""
    with socket.create_connection(("127.0.0.1", port), timeout=2) as control:
        control.sendall(b"\x05\x01\x00")
        assert receive(control, 2) == b"\x05\x00"
        control.sendall(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
        header = receive(control, 4)
        assert header[:2] == b"\x05\x00", "SOCKS UDP association rejected"
        assert header[3] == 1, "expected an IPv4 UDP relay"
        address = socket.inet_ntoa(receive(control, 4))
        relay_port = struct.unpack("!H", receive(control, 2))[0]
        if address == "0.0.0.0":
            address = "127.0.0.1"
        host = destination.encode()
        # TXT-shaped payload identifies the local endpoint; it is not sent to DNS.
        query = struct.pack("!HHHHHH", 1234, 0x0100, 1, 0, 0, 0)
        query += b"\x04test\x07invalid\x00" + struct.pack("!HH", 16, 1)
        packet = b"\x00\x00\x00\x03" + bytes([len(host)]) + host
        packet += struct.pack("!H", 9999) + query
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.settimeout(2)
            udp.sendto(packet, (address, relay_port))
            response = udp.recv(4096)
        assert response[:3] == b"\x00\x00\x00", "unexpected SOCKS UDP response"
        offset = {1: 8, 4: 20}.get(response[3])
        if offset is None:
            assert response[3] == 3
            offset = 5 + response[4]
        payload = response[offset + 2:]
        assert payload[:2] == query[:2]
        return payload[-6:].decode()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tests/test-streaming.py /path/to/xray")
    binary = Path(sys.argv[1]).resolve()
    env = dict(os.environ)
    env.setdefault("XRAY_LOCATION_ASSET", str(binary.parent))
    shipped = json.loads((ROOT / "config/config.json").read_text())
    shipped = luci_config(shipped, True, setup=True)
    first_domains = next(r for r in shipped['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')['domain']
    with ExitStack() as stack:
        nodes = {}
        for tag, label in (("proxy-main", "main!!"), ("proxy-backup", "backup"),
                           ("proxy-stream", "stream"), ("proxy-stream2", "second"), ("direct", "direct")):
            available = threading.Event()
            available.set()
            http = server(stack, ThreadingHTTPServer, HELPERS["HTTPHandler"])
            udp = server(stack, socketserver.ThreadingUDPServer,
                         HELPERS["DNSHandler"], http.server_port)
            for endpoint in (http, udp):
                endpoint.label = label
                endpoint.available = available
            nodes[tag] = (http.server_port, available)

        config = copy.deepcopy(shipped)
        config["log"] = {"loglevel": "info"}
        config["dns"] = {"servers": ["127.0.0.1"]}
        config["observatory"]["probeUrl"] = "http://127.0.0.1/health"
        config["observatory"]["probeInterval"] = "1s"
        for outbound in config["outbounds"]:
            tag = outbound["tag"]
            if tag in nodes:
                outbound.clear()
                outbound.update(tag=tag, protocol="freedom",
                    settings={"redirect": f"127.0.0.1:{nodes[tag][0]}"})
            outbound.get("streamSettings", {}).get("sockopt", {}).pop("mark", None)
        for rule in config["routing"]["rules"]:
            if rule["ruleTag"] == "FORCE-DIRECT":
                rule["domain"] += ["full:direct-test.netflix.com", "full:direct-test.disneyplus.com"]
            if rule["ruleTag"] == "FORCE-PROXY":
                rule["domain"].append("domain:netflix.com")

        ports = [HELPERS["free_port"]() for _ in range(4)]
        assert len(set(ports)) == 4, "ephemeral port collision; rerun test"
        config["inbounds"] = [
            {"tag": tag, "listen": "127.0.0.1", "port": port,
             "protocol": "socks", "settings": {"auth": "noauth", "udp": True}}
            for tag, port in zip(("tproxy-in", "dns-global", "socks-in", "http-in"), ports)
        ]
        directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="xray-streaming-")))
        config_path = directory / "config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        subprocess.run([str(binary), "run", "-test", "-config", str(config_path)],
                       check=True, env=env)
        with (directory / "xray.log").open("w+", encoding="utf-8") as log:
            process = subprocess.Popen([str(binary), "run", "-config", str(config_path)],
                                       stdout=log, stderr=log, env=env)
            try:
                default = lambda: request_http(ports[0], "ordinary.example.invalid")
                stream = lambda: request_http(ports[0], "netflix.com")
                stream2 = lambda: request_http(ports[0], "disneyplus.com")
                await_label(process, default, "main!!")
                for domain, label in (("netflix.com", "stream"), ("nflxvideo.net", "stream"),
                        ("primevideo.com", "stream"), ("amazonvideo.com", "stream"),
                        ("hbo.com", "second"), ("hbomax.com", "second"), ("max.com", "second"),
                        ("disneyplus.com", "second"), ("bamgrid.com", "second"), ("overlap.hbo.com", "stream")):
                    # Exercise each client inbound tag; SOCKS is the local harness
                    # protocol even for the HTTP-tagged fixture.
                    for port in (ports[0], ports[2], ports[3]):
                        await_label(process, lambda: request_http(port, domain), label)
                        await_label(process, lambda: request_udp(port, domain), label)
                print("PASS: separate TCP/UDP streaming paths on all client tags; first route wins overlaps", flush=True)
                await_label(process, lambda: request_http(ports[0], "direct-test.netflix.com"), "direct")
                await_label(process, lambda: request_http(ports[0], "direct-test.disneyplus.com"), "direct")
                await_label(process, lambda: request_http(ports[0], "amazon.com"), "main!!")
                await_label(process, lambda: request_http(ports[1], "netflix.com"), "main!!")
                print("PASS: force-direct wins; Amazon shopping and global DNS keep their routes", flush=True)

                nodes["proxy-main"][1].clear()
                await_label(process, default, "backup")
                await_label(process, lambda: request_http(ports[1], "netflix.com"), "backup")
                await_label(process, stream, "stream")
                await_label(process, stream2, "second")
                print("PASS: default/global DNS failover does not change the streaming exit", flush=True)
                nodes["proxy-main"][1].set()
                await_label(process, default, "main!!")
                nodes["proxy-stream"][1].clear()
                assert_unavailable(stream)
                assert_unavailable(lambda: request_udp(ports[0], "netflix.com"))
                await_label(process, stream2, "second")
                await_label(process, default, "main!!")
                print("PASS: streaming outage has no fallback; ordinary traffic still works", flush=True)
                nodes["proxy-stream"][1].set()
                await_label(process, stream, "stream")
                nodes["proxy-stream2"][1].clear()
                assert_unavailable(stream2)
                assert_unavailable(lambda: request_udp(ports[0], "disneyplus.com"))
                await_label(process, stream, "stream")
                await_label(process, default, "main!!")
                nodes["proxy-stream2"][1].set()
                await_label(process, stream2, "second")
                print("PASS: either streaming node can fail independently without fallback", flush=True)
                # Disabling through LuCI must preserve the node and domains but stop matching.
                disabled = luci_config(config, False)
                assert disabled['outbounds'] == config['outbounds']
                assert next(r for r in disabled['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')['inboundTag'] == ['xray-router-stream-disabled']
                assert next(r for r in disabled['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')['domain'] == first_domains
                HELPERS["stop"](process)
                config_path.write_text(json.dumps(disabled), encoding="utf-8")
                subprocess.run([str(binary), "run", "-test", "-config", str(config_path)], check=True, env=env)
                process = subprocess.Popen([str(binary), "run", "-config", str(config_path)],
                                           stdout=log, stderr=log, env=env)
                await_label(process, stream, "main!!")
                await_label(process, stream2, "second")
                await_label(process, lambda: request_udp(ports[0], "disneyplus.com"), "second")
                await_label(process, lambda: request_http(ports[0], "overlap.hbo.com"), "second")
                print("PASS: disabling first stream preserves second and exposes its overlapping rule", flush=True)
                disabled = luci_config(disabled, False, second_enabled=False)
                HELPERS["stop"](process)
                config_path.write_text(json.dumps(disabled), encoding="utf-8")
                process = subprocess.Popen([str(binary), "run", "-config", str(config_path)],
                                           stdout=log, stderr=log, env=env)
                await_label(process, stream, "main!!")
                await_label(process, stream2, "main!!")
                await_label(process, lambda: request_udp(ports[0], "disneyplus.com"), "main!!")
                print("PASS: disabling both routes restores ordinary routing", flush=True)
            except BaseException:
                log.flush()
                print("\n".join((directory / "xray.log").read_text().splitlines()[-100:]),
                      file=sys.stderr)
                raise
            finally:
                HELPERS["stop"](process)


if __name__ == "__main__":
    main()
