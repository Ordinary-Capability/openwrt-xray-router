#!/usr/bin/env python3
"""Test the inspector parser against real Xray access/info logs on loopback."""
import json
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from lupa.lua51 import LuaRuntime

ROOT = Path(__file__).resolve().parents[1]
HELPERS = runpy.run_path(str(ROOT / 'tests/test-failover.py'))


def main():
    if len(sys.argv) != 2: raise SystemExit('Usage: python tests/test-inspector-xray.py /path/to/xray')
    binary = str(Path(sys.argv[1]).resolve())
    lua = LuaRuntime(unpack_returned_tuples=True)
    parser = lua.execute((ROOT / 'luci-app-xray-router/root/usr/libexec/xray-router/inspector.lua').read_text())
    with ExitStack() as stack:
        target = HELPERS['server'](stack, ThreadingHTTPServer, HELPERS['HTTPHandler'])
        target.available = threading.Event(); target.available.set(); target.label = 'stream'
        directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='xray-inspector-')))
        for level in ['info', 'warning']:
            port = HELPERS['free_port']()
            config = {
                'log': {'loglevel': level},
                'inbounds': [{'tag': 'tproxy-in', 'listen': '127.0.0.1', 'port': port, 'protocol': 'tunnel',
                    'settings': {'allowedNetwork': 'tcp', 'rewriteAddress': '8.8.8.8', 'rewritePort': 443},
                    'sniffing': {'enabled': True, 'destOverride': ['http'], 'routeOnly': True}}],
                'outbounds': [{'tag': 'blocked', 'protocol': 'blackhole'}, {'tag': 'proxy-stream', 'protocol': 'freedom',
                    'settings': {'redirect': f'127.0.0.1:{target.server_port}'}}],
                'routing': {'domainStrategy': 'AsIs', 'rules': [{'type': 'field', 'domain': ['domain:netflix.com'],
                    'ruleTag': 'STREAMING-PROXY', 'outboundTag': 'proxy-stream'}]}}
            filename = directory / 'config.json'; filename.write_text(json.dumps(config))
            output = directory / (level + '.log')
            with output.open('w', encoding='utf-8') as log:
                process = subprocess.Popen([binary, 'run', '-config', str(filename)], stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 8
                    while True:
                        assert process.poll() is None, 'Xray did not start'
                        try:
                            client = socket.create_connection(('127.0.0.1', port), timeout=1)
                            break
                        except OSError:
                            if time.monotonic() > deadline: raise
                            time.sleep(.1)
                    with client:
                        client.sendall(b'GET / HTTP/1.1\r\nHost: netflix.com\r\nConnection: close\r\n\r\n')
                        data = b''
                        while True:
                            chunk = client.recv(4096)
                            if not chunk: break
                            data += chunk
                        assert b'stream' in data, data
                finally:
                    HELPERS['stop'](process)
            model = parser.new(lua.table_from({'device': '192.168.1.100', 'duration': 30, 'expected': 'proxy-stream'}), 0)
            for line in output.read_text().splitlines():
                # Only translate the loopback client's source address to a LAN
                # test address. Destination, session IDs and messages are unmodified.
                line = line.replace('received request for 127.0.0.1:', 'received request for 192.168.1.100:')
                line = line.replace('from 127.0.0.1:', 'from 192.168.1.100:')
                model.log(line, time.time())
            rows = model.result()['rows']
            assert len(rows) == 1, output.read_text()
            row = rows[1]
            assert row['path'] == 'proxy-stream', output.read_text()
            assert row['destination'] == '8.8.8.8'
            assert row['outcome'] == 'Selected; outcome unknown'
            if level == 'info':
                assert row['domain'] == 'netflix.com', output.read_text()
                assert row['domain_evidence'] == 'sniffed'
                assert row['rule'] == 'STREAMING-PROXY'
            else:
                assert row['domain'] is None and row['rule'] is None
            print(f'PASS: real Xray {level} logs produce accurate device/path evidence', flush=True)


if __name__ == '__main__': main()
