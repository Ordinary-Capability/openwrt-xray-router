#!/usr/bin/env python3
"""Offline integration test: python tests/test-failover.py /path/to/xray.

Uses the shipped routing/observatory and DNS outbound with local
stand-ins for both nodes. No router changes, credentials, or Internet probes.
Requires Python 3, h2 (pip install h2), and a current Xray binary.
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
from http.server import BaseHTTPRequestHandler


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


def dns_answer(query, label):
    # One uncompressed question. Ignore EDNS padding appended by the DoH client.
    end = 12
    while query[end]:
        end += query[end] + 1
    end += 5
    qtype = struct.unpack("!H", query[end - 4:end - 2])[0]
    node_id = {"main!!": 1, "backup": 2, "direct": 3}.get(label, 4)
    if qtype == 1:
        payload = socket.inet_aton(f"198.51.100.{node_id}")
    elif qtype == 28:
        payload = socket.inet_pton(socket.AF_INET6, f"2001:db8::{node_id}")
    else:
        payload = bytes([len(label)]) + label.encode()
    header = query[:2] + struct.pack("!HHHHH", 0x8180, 1, 1, 0, 0)
    answer = b"\xc0\x0c" + struct.pack("!HHIH", qtype, 1, 0, len(payload))
    return header + query[12:end] + answer + payload


class DNSHandler(socketserver.BaseRequestHandler):
    def handle(self):
        if self.server.available.is_set():
            query, sock = self.request
            sock.sendto(dns_answer(query, self.server.label), self.client_address)


class NodeHandler(socketserver.BaseRequestHandler):
    """HTTP health/client traffic and HTTP/2 DNS on each node's TCP endpoint."""
    def handle(self):
        from h2.config import H2Configuration
        from h2.connection import H2Connection
        from h2.events import DataReceived, StreamEnded

        self.request.settimeout(2)
        try:
            if self.request.recv(1, socket.MSG_PEEK) != b"P":
                HTTPHandler(self.request, self.client_address, self.server)
                return
            if not self.server.available.is_set():
                return
            conn = H2Connection(config=H2Configuration(client_side=False))
            conn.initiate_connection()
            self.request.sendall(conn.data_to_send())
            queries = {}
            while self.server.available.is_set():
                data = self.request.recv(65536)
                if not data:
                    return
                for event in conn.receive_data(data):
                    if isinstance(event, DataReceived):
                        queries.setdefault(event.stream_id, bytearray()).extend(event.data)
                        conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                    elif isinstance(event, StreamEnded):
                        response = dns_answer(queries[event.stream_id], self.server.label)
                        conn.send_headers(event.stream_id, [(':status', '200'),
                            ('content-type', 'application/dns-message'),
                            ('content-length', str(len(response)))])
                        conn.send_data(event.stream_id, response, end_stream=True)
                        # Selection is per connection, not per DNS request. GOAWAY
                        # ensures recovery checks open a fresh DoH connection.
                        conn.close_connection(last_stream_id=event.stream_id)
                        self.request.sendall(conn.data_to_send())
                        return
                self.request.sendall(conn.data_to_send())
        except OSError:
            pass


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


def request_dns(port, qtype=16, domain="test.invalid", tcp=False):
    query = struct.pack("!HHHHHH", 1234, 0x0100, 1, 0, 0, 0)
    query += b"".join(bytes([len(part)]) + part.encode() for part in domain.split("."))
    query += b"\x00" + struct.pack("!HH", qtype, 1)
    if tcp:
        with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
            sock.sendall(struct.pack("!H", len(query)) + query)
            response = receive(sock, struct.unpack("!H", receive(sock, 2))[0])
    else:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(2)
            sock.sendto(query, ("127.0.0.1", port))
            response = sock.recv(4096)
    assert response[:2] == query[:2]
    assert struct.unpack("!H", response[6:8])[0] == 1
    if qtype in (1, 28):
        return {1: "main!!", 2: "backup", 3: "direct"}[response[-1]]
    return response[-6:].decode()  # Both node labels are six bytes.


def request_txt(port):
    return request_dns(port)


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
    try:
        import h2  # Check before starting Xray or the local server threads.
    except ImportError:
        raise SystemExit("Install the test dependency first: python -m pip install h2")
    shipped = json.loads((ROOT / "config/config.json").read_text())
    with ExitStack() as stack:
        nodes = {}
        for tag, label in (("proxy-main", "main!!"), ("proxy-backup", "backup"),
                           ("direct", "direct")):
            available = threading.Event()
            available.set()
            http = server(stack, socketserver.ThreadingTCPServer, NodeHandler)
            http.server_port = http.server_address[1]
            udp = server(stack, socketserver.ThreadingUDPServer, DNSHandler,
                         http.server_port)
            for endpoint in (http, udp):
                endpoint.label = label
                endpoint.available = available
            nodes[tag] = (http.server_port, available)

        config = copy.deepcopy(shipped)
        # Keep routing/forwarding intact; replace external DNS/probe endpoints.
        config["log"] = {"loglevel": "info"}
        config["observatory"]["probeUrl"] = "http://127.0.0.1/health"
        config["observatory"]["probeInterval"] = "200ms"
        # Exercise both IP families, even though production uses IPv4 only.
        config["dns"]["queryStrategy"] = "UseIP"
        config["dns"]["disableCache"] = True
        config["dns"]["serveStale"] = False
        for resolver in config["dns"]["servers"]:
            # h2c uses Xray's real DoH client/dispatcher without external TLS
            # credentials. CN retains UDP, as in the deployed configuration.
            resolver["address"] = ("127.0.0.1" if resolver["tag"] == "dns-cn"
                                   else "h2c://127.0.0.1/dns-query")
            resolver["port"] = 53
            resolver.pop("expectedIPs", None)
            if "domains" in resolver:
                resolver["domains"] = ["domain:cn.invalid" if resolver["tag"] == "dns-cn"
                                       else "domain:global.invalid"]
        for rule in config["routing"]["rules"]:
            # Keep these competing rules to catch DNS leaks and rule-order bugs.
            if rule["ruleTag"] == "PRIVATE-DIRECT":
                rule["ip"] = ["127.0.0.0/8"]
            elif rule["ruleTag"] == "CN-IP-DIRECT":
                rule["ip"] = ["192.0.2.0/24"]
            elif rule["ruleTag"] == "CN-DOMAIN-DIRECT":
                rule["domain"] = ["domain:cn.invalid"]
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
                              lambda: request_txt(ports[2]),
                              lambda: request_dns(ports[2], tcp=True)]
                # Both tagged resolvers and both client DNS transports must fail over.
                dns_checks += [lambda qtype=qtype, domain=domain, tcp=tcp:
                               request_dns(ports[2], qtype, domain, tcp)
                               for qtype in (1, 28) for tcp in (False, True)
                               for domain in ("global.invalid", "unmatched.invalid")]
                cn_check = lambda: request_dns(ports[2], 1, "cn.invalid")
                for label in ("main!!", "backup", "main!!"):
                    if label == "backup":
                        nodes["proxy-main"][1].clear()
                    else:
                        nodes["proxy-main"][1].set()
                    for check in checks:
                        await_label(process, check, label)
                    for check in dns_checks:
                        await_label(process, check, label)
                    await_label(process, cn_check, "direct")
                    print(f"PASS: client TCP/UDP and global DNS A/AAAA/TXT via {label}; CN DNS direct", flush=True)
                # Both nodes unavailable: no direct connection may succeed.
                for tag in ("proxy-main", "proxy-backup"):
                    nodes[tag][1].clear()
                time.sleep(1)
                for check in checks + dns_checks:
                    assert_unavailable(check)
                await_label(process, cn_check, "direct")
                print("PASS: both proxy nodes down fail closed; CN DNS still works", flush=True)
            except BaseException:
                log.flush()
                print("\n".join((directory / "xray.log").read_text().splitlines()[-100:]),
                      file=sys.stderr)
                raise
            finally:
                stop(process)


if __name__ == "__main__":
    main()
