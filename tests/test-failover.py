#!/usr/bin/env python3
"""Offline integration test: python tests/test-failover.py /path/to/xray.

Uses the shipped routing/observatory and DNS outbound with local
stand-ins for both nodes. No router changes, credentials, or Internet probes.
Requires Python 3 and an Xray binary supporting the shipped configuration.
"""

import copy
import http.client
import json
from pathlib import Path
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]


class HTTPHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not self.server.available.is_set():
            self.close_connection = True
            return
        body = self.server.label.encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class DNSHandler(socketserver.BaseRequestHandler):
    def handle(self):
        if not self.server.available.is_set():
            return
        query, sock = self.request
        # Test queries contain one uncompressed TXT question.
        label = self.server.label.encode()
        header = query[:2] + struct.pack("!HHHHH", 0x8180, 1, 1, 0, 0)
        answer = b"\xc0\x0c" + struct.pack("!HHIH", 16, 1, 0, len(label) + 1)
        sock.sendto(header + query[12:] + answer + bytes([len(label)]) + label,
                    self.client_address)


def server(stack, cls, handler, port=0):
    instance = cls(("127.0.0.1", port), handler)
    stack.callback(instance.server_close)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    stack.callback(instance.shutdown)
    return instance


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def receive(sock, length):
    data = b""
    while len(data) < length:
        part = sock.recv(length - len(data))
        if not part:
            raise OSError("unexpected SOCKS EOF")
        data += part
    return data


def request_http(port, destination="8.8.8.8"):
    with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
        sock.sendall(b"\x05\x01\x00")
        assert receive(sock, 2) == b"\x05\x00"
        host = destination.encode()
        sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host + b"\x00\x50")
        header = receive(sock, 4)
        if header[1] != 0:
            raise OSError("SOCKS connection rejected")
        length = {1: 4, 4: 16}.get(header[3])
        if length is None:
            length = receive(sock, 1)[0]
        receive(sock, length + 2)
        sock.sendall(b"GET / HTTP/1.1\r\nHost: test.invalid\r\nConnection: close\r\n\r\n")
        response = http.client.HTTPResponse(sock)
        response.begin()
        return response.read().decode()


def request_txt(port):
    query = struct.pack("!HHHHHH", 1234, 0x0100, 1, 0, 0, 0)
    query += b"\x04test\x07invalid\x00" + struct.pack("!HH", 16, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        sock.sendto(query, ("127.0.0.1", port))
        response = sock.recv(4096)
    assert response[:2] == query[:2]
    assert struct.unpack("!H", response[6:8])[0] == 1
    return response[-6:].decode()  # Both node labels are six bytes.


def await_label(process, check, expected):
    deadline = time.monotonic() + 20
    last = None
    while time.monotonic() < deadline:
        assert process.poll() is None, "Xray exited during failover test"
        try:
            last = check()
            if last == expected:
                return
        except (OSError, http.client.HTTPException) as exc:
            last = repr(exc)
        time.sleep(0.2)
    raise AssertionError(f"expected {expected}, got {last}")


def assert_unavailable(check):
    try:
        result = check()
    except (OSError, http.client.HTTPException):
        return
    raise AssertionError(f"unexpected success through an unavailable node: {result}")


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tests/test-failover.py /path/to/xray")
    shipped = json.loads((ROOT / "config/config.json").read_text())
    with ExitStack() as stack:
        nodes = {}
        for tag, label in (("proxy-main", "main!!"), ("proxy-backup", "backup")):
            available = threading.Event()
            available.set()
            http = server(stack, ThreadingHTTPServer, HTTPHandler)
            udp = server(stack, socketserver.ThreadingUDPServer, DNSHandler,
                         http.server_port)
            for endpoint in (http, udp):
                endpoint.label = label
                endpoint.available = available
            nodes[tag] = (http.server_port, available)

        config = copy.deepcopy(shipped)
        # Keep routing and DNS policy intact; isolate all network endpoints.
        config["log"] = {"loglevel": "info"}
        config["observatory"]["probeUrl"] = "http://127.0.0.1/health"
        config["observatory"]["probeInterval"] = "200ms"
        config["dns"] = {"servers": ["127.0.0.1"]}
        config["routing"]["rules"] = [rule for rule in config["routing"]["rules"]
            if not any(value.startswith(("geoip:", "geosite:"))
                       for key in ("ip", "domain") for value in rule.get(key, []))]
        for outbound in config["outbounds"]:
            if outbound["tag"] in nodes:
                tag = outbound["tag"]
                outbound.clear()
                outbound.update(tag=tag, protocol="freedom",
                    settings={"redirect": f"127.0.0.1:{nodes[tag][0]}"})
            outbound.get("streamSettings", {}).get("sockopt", {}).pop("mark", None)

        ports = [free_port() for _ in range(4)]
        assert len(set(ports)) == 4, "ephemeral port collision; rerun test"
        dns_in = next(i for i in config["inbounds"] if i["tag"] == "dns-in")
        dns_in["port"] = ports[2]
        config["inbounds"] = [
            {"tag": tag, "listen": "127.0.0.1", "port": port,
             "protocol": "socks", "settings": {"auth": "noauth"}}
            for tag, port in zip(("tproxy-in", "dns-global"), ports[:2])
        ] + [dns_in, {
            "tag": "client-udp-test", "listen": "127.0.0.1", "port": ports[3],
            "protocol": "tunnel", "settings": {
                "allowedNetwork": "udp", "rewriteAddress": "8.8.8.8",
                "rewritePort": 9999,
            },
        }]

        directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="xray-failover-")))
        config_path = directory / "config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        binary = str(Path(sys.argv[1]).resolve())
        subprocess.run([binary, "run", "-test", "-config", str(config_path)], check=True)
        with (directory / "xray.log").open("w+", encoding="utf-8") as log:
            process = subprocess.Popen([binary, "run", "-config", str(config_path)],
                                       stdout=log, stderr=log)
            try:
                checks = [lambda: request_http(ports[0]),
                          lambda: request_http(ports[0], "example-proxy.invalid"),
                          # TXT-shaped payload on a non-DNS port tests ordinary UDP.
                          lambda: request_txt(ports[3])]
                dns_checks = [lambda: request_http(ports[1]),
                              lambda: request_txt(ports[2])]
                for label in ("main!!", "backup", "main!!"):
                    if label == "backup":
                        nodes["proxy-main"][1].clear()
                    else:
                        nodes["proxy-main"][1].set()
                    for check in checks:
                        await_label(process, check, label)
                    if label == "backup":
                        for check in dns_checks:
                            assert_unavailable(check)
                    else:
                        for check in dns_checks:
                            await_label(process, check, label)
                    print(f"PASS: client traffic via {label}; DNS remains on primary", flush=True)
                # Both nodes unavailable: no direct connection may succeed.
                for _, available in nodes.values():
                    available.clear()
                time.sleep(1)
                for check in checks + dns_checks:
                    assert_unavailable(check)
                print("PASS: both nodes down fail closed", flush=True)
            except BaseException:
                log.flush()
                print("\n".join((directory / "xray.log").read_text().splitlines()[-100:]),
                      file=sys.stderr)
                raise
            finally:
                stop(process)


if __name__ == "__main__":
    main()
