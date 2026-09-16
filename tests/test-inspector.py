#!/usr/bin/env python3
"""Parser and worker lifecycle tests with Lua 5.1; no root or router required."""
import json
import re
from pathlib import Path
import unittest
from lupa.lua51 import LuaRuntime

ROOT = Path(__file__).resolve().parents[1]
MODULES = ROOT / 'luci-app-xray-router/root/usr/libexec/xray-router'
DEVICE = '192.168.1.100'


class LuaTest(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        self.parser = self.lua.execute((MODULES / 'inspector.lua').read_text())

    def table(self, obj):
        if isinstance(obj, dict): return self.lua.table_from({k: self.table(v) for k, v in obj.items()})
        if isinstance(obj, list): return self.lua.table_from([self.table(v) for v in obj])
        return obj

    def plain(self, obj):
        if hasattr(obj, 'items'):
            items = dict(obj.items())
            if items and all(isinstance(k, int) for k in items): return [self.plain(items[k]) for k in sorted(items)]
            return {k: self.plain(v) for k, v in items.items()}
        return obj

    def request(self): return self.table({'device': DEVICE, 'duration': 30, 'expected': 'proxy-stream'})


class ParserTest(LuaTest):
    def setUp(self):
        super().setUp()
        self.model = self.parser.new(self.request(), 0)

    def log(self, text): self.model.log(text, 10)

    def test_correlates_source_sniff_rule_access_and_error_without_guessing_success(self):
        self.log('[Info] [101] proxy/dokodemo: received request for 192.168.1.100:50100')
        self.log('[Info] [101] app/dispatcher: sniffed domain: netflix.com')
        self.log('[Info] [101] app/dispatcher: Hit route rule: [STREAMING-PROXY] so taking detour [proxy-stream] for [tcp:8.8.8.8:443]')
        self.log('from 192.168.1.100:50100 accepted tcp:8.8.8.8:443 [tproxy-in -> proxy-stream]')
        row = self.plain(self.model.result())['rows'][0]
        self.assertEqual(row['domain'], 'netflix.com')
        self.assertEqual(row['domain_evidence'], 'sniffed')
        self.assertEqual(row['rule'], 'STREAMING-PROXY')
        self.assertEqual(row['path'], 'proxy-stream')
        self.assertEqual(row['outcome'], 'Selected; outcome unknown')
        self.assertFalse(row['mismatch'])
        self.log('[Info] [101] proxy/vless: failed to open connection: timeout')
        self.assertEqual(self.model.result()['rows'][1]['outcome'], 'Error logged')
        self.log('from 192.168.1.100:50100 accepted tcp:8.8.8.8:443 [tproxy-in -> proxy-stream]')
        self.assertEqual(self.model.result()['rows'][1]['outcome'], 'Error logged')

    def test_access_only_reports_path_without_fabricating_rule_or_hostname(self):
        self.log('from 192.168.1.100:50100 accepted udp:8.8.8.8:443 [tproxy-in -> proxy-main]')
        row = self.model.result()['rows'][1]
        self.assertTrue(row['mismatch'])
        self.assertIsNone(row['rule'])
        self.assertIsNone(row['domain'])
        self.assertEqual(row['network'], 'udp')

    def test_route_domain_and_access_ip_merge_with_kernel_row(self):
        self.packet()
        self.log('[Info] [1] proxy/dokodemo: received request for 192.168.1.100:50100')
        self.log('[Info] [1] app/dispatcher: sniffed domain: netflix.com')
        self.log('[Info] [1] app/dispatcher: Hit route rule: [STREAMING-PROXY] so taking detour [proxy-stream] for [tcp:netflix.com:443]')
        self.log('from 192.168.1.100:50100 accepted tcp:8.8.8.8:443 [tproxy-in -> proxy-stream]')
        result = self.model.result()
        self.assertEqual(len(result['rows']), 1)
        row = result['rows'][1]
        self.assertEqual(row['destination'], '8.8.8.8')
        self.assertEqual(row['domain'], 'netflix.com')
        self.assertEqual(row['rule'], 'STREAMING-PROXY')
        self.log('[Info] [1] proxy/vless: failed to open connection')
        self.assertEqual(row['outcome'], 'Error logged')

    def test_other_clients_and_unrelated_sessions_are_ignored(self):
        self.log('[Info] [201] proxy/dokodemo: received request for 192.168.1.101:50100')
        self.log('[Info] [201] app/dispatcher: sniffed domain: secret.example')
        self.log('[Info] [201] app/dispatcher: taking detour [proxy-main] for [tcp:8.8.8.8:443]')
        self.log('from 192.168.1.101:50100 accepted tcp:8.8.8.8:443 [tproxy-in -> proxy-main]')
        self.log('from 192.168.1.100:50100 accepted tcp:8.8.8.8:443 [other-in -> proxy-main]')
        self.assertEqual(len(self.model.result()['rows']), 0)

    def test_domain_merge_keeps_unique_ids_and_does_not_alias_later_connections(self):
        self.packet()
        self.log('[Info] [1] proxy/dokodemo: received request for 192.168.1.100:50100')
        self.log('[Info] [1] app/dispatcher: taking detour [proxy-stream] for [tcp:netflix.com:443]')
        self.log('from 192.168.1.100:50200 accepted tcp:1.1.1.1:443 [tproxy-in -> direct]')
        self.log('from 192.168.1.100:50100 accepted tcp:8.8.8.8:443 [tproxy-in -> proxy-stream]')
        self.log('[Info] [2] proxy/dokodemo: received request for 192.168.1.100:50100')
        self.log('[Info] [2] app/dispatcher: taking detour [proxy-stream] for [tcp:netflix.com:443]')
        self.log('from 192.168.1.100:50100 accepted tcp:8.8.4.4:443 [tproxy-in -> proxy-stream]')
        self.log('[Error] [2] proxy/vless: failed to connect')
        rows = self.plain(self.model.result())['rows']
        self.assertEqual(len({row['id'] for row in rows}), len(rows))
        first = next(row for row in rows if row['destination'] == '8.8.8.8')
        second = next(row for row in rows if row['destination'] == '8.8.4.4')
        self.assertNotIn('error', first)
        self.assertEqual(second['outcome'], 'Error logged')
        self.assertEqual(second['route_target'], 'netflix.com')

    def test_reused_session_id_from_other_client_cannot_attach_evidence(self):
        self.log('[Info] [1] proxy/dokodemo: received request for 192.168.1.100:50100')
        self.log('[Info] [1] proxy/dokodemo: received request for 192.168.1.101:50100')
        self.log('[Info] [1] app/dispatcher: taking detour [direct] for [tcp:secret.example:443]')
        self.assertEqual(len(self.model.result()['rows']), 0)

    def packet(self, ident='abcd', source=DEVICE, port=50100):
        self.model.trace(f'trace id {ident} inet fw4 xray_prerouting packet: iif "br-lan" ip saddr {source} ip daddr 8.8.8.8 tcp sport {port} tcp dport 443', 10)

    def test_kernel_bypass_is_observed_and_trace_ids_isolate_devices(self):
        self.packet()
        self.packet('beef', '192.168.1.101')
        self.model.trace('trace id beef inet fw4 xray_prerouting rule ip daddr @xray_reserved4 counter return (verdict return)', 10)
        self.model.trace('trace id abcd inet fw4 xray_prerouting rule ip daddr @xray_cn4 counter packets 1 bytes 60 return (verdict return)', 10)
        row = self.model.result()['rows'][1]
        self.assertEqual(row['path'], 'kernel-direct')
        self.assertEqual(row['kernel'], 'CN-FASTPATH')
        self.assertTrue(row['mismatch'])
        self.assertEqual(len(self.model.result()['rows']), 1)

    def test_interception_is_not_assumed_to_be_proxy_selection(self):
        self.packet()
        self.model.trace('trace id abcd inet fw4 xray_prerouting rule meta l4proto tcp counter tproxy ip to 127.0.0.1:12345 meta mark set 0x1 accept (verdict accept)', 10)
        row = self.model.result()['rows'][1]
        self.assertEqual(row['path'], 'unknown')
        self.assertEqual(row['kernel'], 'TPROXY')
        self.assertFalse(row['mismatch'])
        self.model.trace('trace id abcd inet fw4 input rule drop (verdict drop)', 10)
        self.assertEqual(row['outcome'], 'Firewall blocked')

    def test_dns_candidate_does_not_replace_sniffed_domain(self):
        self.packet()
        self.log('dnsmasq[42]: query[A] cdn.example from 192.168.1.100')
        self.log('dnsmasq[42]: reply cdn.example is 8.8.8.8')
        row = self.model.result()['rows'][1]
        self.assertEqual(row['dns_candidates'][1], 'cdn.example')
        self.assertIsNone(row['domain'])
        self.log('[Info] [1] proxy/dokodemo: received request for 192.168.1.100:50100')
        self.log('[Info] [1] app/dispatcher: sniffed domain: actual.example')
        self.log('[Info] [1] app/dispatcher: taking detour [proxy-main] for [tcp:8.8.8.8:443]')
        row = self.model.result()['rows'][1]
        self.assertEqual(row['domain'], 'actual.example')
        self.assertEqual(row['dns_candidates'][1], 'cdn.example')

    def test_capture_input_and_nft_script_are_scoped_and_expiring(self):
        for bad in ['127.0.0.1', '0.0.0.0', '224.0.0.1', '192.168.1.1;reboot', '192.168.1.01', '256.1.1.1']:
            with self.assertRaises(Exception): self.parser.request(self.table({'device': bad, 'duration': 60}))
        for duration in [0, 1, 3600, '60;reboot']:
            with self.assertRaises(Exception): self.parser.request(self.table({'device': DEVICE, 'duration': duration}))
        interfaces = self.parser.interfaces('\nLAN_INTERFACES="br-lan br-guest"\n')
        script = self.parser.rules(self.request(), interfaces, '123-456')
        self.assertIn('ip saddr @clients4', script)
        self.assertIn('192.168.1.100 timeout 30s', script)
        self.assertIn('iifname { "br-lan", "br-guest" }', script)
        self.assertIn('priority -151', script)
        self.assertIn('limit rate 5/second', script)
        self.assertNotIn('tproxy ', script)
        self.assertNotIn('flush ', script)
        with self.assertRaises(Exception): self.parser.interfaces('\nLAN_INTERFACES="br-lan;reboot"\n')

    def test_old_log_replay_and_memory_limits(self):
        model = self.parser.new(self.request(), 9999999999)
        model.log('2026/09/15 20:00:00.123456 from 192.168.1.100:50000 accepted tcp:8.8.8.8:443 [tproxy-in -> direct]', 10)
        self.assertEqual(len(model.result()['rows']), 0)
        for port in range(50000, 51000):
            self.log(f'from {DEVICE}:{port} accepted tcp:8.8.8.8:443 [tproxy-in -> direct]')
        self.assertEqual(len(self.model.result()['rows']), 500)
        self.assertGreater(self.model.result()['dropped'], 0)


class RuntimeTest(LuaTest):
    def setUp(self):
        super().setUp()
        self.clock = 1789465000.5
        self.work = '/tmp/xray-router-inspector'
        self.files = {'/etc/xray-router/config.json': (ROOT / 'config/config.json').read_text(),
                      '/etc/xray-router/settings.conf': (ROOT / 'config/settings.conf').read_text()}
        self.dirs, self.commands, self.children = {}, [], []
        self.table_comment = None
        self.fail_install = self.fail_cleanup = False
        self.stop_early = False
        self.launch_token = None
        self.control_locked = False
        self.lua.globals().py_read = self.files.get
        self.lua.globals().py_unlink = lambda p: self.files.pop(p, None) is not None
        self.lua.globals().py_rename = lambda a, b: self.files.__setitem__(b, self.files.pop(a)) or True
        self.lua.globals().py_mkdir = self.mkdir
        self.lua.globals().py_stat = lambda p: self.table(self.dirs[p]) if p in self.dirs else None
        self.lua.globals().py_rmdir = lambda p: self.dirs.pop(p, None) is not None
        self.lua.globals().py_write = lambda p, data: self.files.__setitem__(p, data) or len(data)
        self.lua.globals().py_parse = lambda raw: self.table(json.loads(raw))
        self.lua.globals().py_encode = lambda obj: json.dumps(self.plain(obj))
        self.lua.globals().py_poll = self.poll
        self.lua.globals().py_lock = self.lock
        self.lua.globals().py_unlock = lambda: setattr(self, 'control_locked', False) or True
        self.lua.globals().parser_module = self.parser
        self.lua.execute('''
            package.preload['luci.jsonc'] = function() return {parse=py_parse, stringify=py_encode} end
            package.preload['nixio.fs'] = function() return {readfile=py_read, unlink=py_unlink,
                rename=py_rename, mkdir=py_mkdir, rmdir=py_rmdir, stat=py_stat, lstat=py_stat,
                chmod=function() return true end} end
            package.preload['nixio'] = function() return {
                getpid=function() return 42 end, kill=function() return true end,
                waitpid=function() return nil end, poll=py_poll, poll_flags=function() return 1 end,
                open=function(path)
                    local locked = false
                    return {writeall=function(_, data) return py_write(path, data) end,
                        lock=function(_, mode)
                            if mode == 'ulock' then locked = false; return py_unlock() end
                            locked = py_lock(); return locked
                        end,
                        close=function() if locked then py_unlock() end; return true end}
                end
            } end
            dofile=function() return parser_module end
        ''')
        self.runtime = self.lua.execute((MODULES / 'inspector-runtime.lua').read_text(), self.table({
            'now': lambda: self.clock, 'command': self.command, 'spawn': self.spawn, 'launch': self.launch}))

    def mkdir(self, path, mode):
        if path in self.dirs: return False
        self.dirs[path] = {'uid': 0, 'type': 'dir', 'mtime': self.clock}
        return True

    def launch(self, token): self.launch_token = token

    def lock(self):
        if self.control_locked: return False
        self.control_locked = True
        return True

    def spawn(self, argv):
        args = self.plain(argv)
        self.children.append(args)
        return self.lua.eval('function(pid) return {pid=pid,buffer="",fd={read=function() return nil end,close=function() end}} end')(100 + len(self.children))

    def command(self, argv, timeout=None):
        args = self.plain(argv)
        self.commands.append(args)
        self.assertEqual(args[0], 'nft', 'capture must never run service/config commands')
        table = {'family': 'inet', 'name': 'xray_router_inspect', 'comment': self.table_comment}
        if args[1:4] == ['-j', 'list', 'tables']:
            return 0, json.dumps({'nftables': [{'table': table}] if self.table_comment else []})
        if args[1:4] == ['-j', 'list', 'table']:
            return (0, json.dumps({'nftables': [{'table': table}]})) if self.table_comment else (1, 'No such table')
        if args[1] == '-f':
            self.table_comment = re.search(r'comment "([^"]+)"', self.files[args[2]])[1]
            return (1, 'simulated install failure') if self.fail_install else (0, '')
        if args[1] == 'delete':
            if self.fail_cleanup: return 1, 'simulated cleanup failure'
            self.table_comment = None
            return 0, ''
        raise AssertionError(args)

    def poll(self, descriptors, timeout):
        self.clock += 1
        if self.stop_early: self.files[self.work + '/stop'] = self.launch_token
        return 0

    def run_capture(self):
        value = self.runtime.start(self.request())
        self.files['/proc/42/cmdline'] = '/usr/bin/lua\0/usr/libexec/rpcd/luci.xray-inspector\0worker\0' + value['id'] + '\0'
        self.runtime.worker(value['id'])
        return self.plain(self.runtime.get())

    def test_timeout_removes_only_owned_table_and_never_restarts(self):
        before = self.files['/etc/xray-router/config.json']
        result = self.run_capture()
        self.assertFalse(result['active'])
        self.assertIsNone(self.table_comment)
        self.assertNotIn(self.work + '/lock', self.dirs)
        self.assertEqual(before, self.files['/etc/xray-router/config.json'])
        self.assertEqual(self.children, [['nft', 'monitor', 'trace'], ['logread', '-f', '-l', '0']])
        self.assertGreaterEqual(self.clock, result['expires'])

    def test_stop_before_deadline_and_failed_install_cleanup(self):
        self.stop_early = True
        result = self.run_capture()
        self.assertLess(result['finished'], result['expires'])
        self.assertIsNone(self.table_comment)
        self.fail_install = True
        result = self.run_capture()
        self.assertIsNone(self.table_comment)
        self.assertTrue(any('install failure' in text for text in result['warnings']))

    def test_cleanup_failure_retains_lock_for_explicit_recovery(self):
        self.fail_cleanup = True
        result = self.run_capture()
        self.assertIn(self.work + '/lock', self.dirs)
        self.assertTrue(any('Cleanup failed' in text for text in result['warnings']))
        self.fail_cleanup = False
        self.runtime.stop(self.table({'id': result['id']}))
        self.assertIsNone(self.table_comment)
        self.assertNotIn(self.work + '/lock', self.dirs)

    def test_foreign_table_is_not_removed(self):
        self.table_comment = 'belongs-to-someone-else'
        result = self.run_capture()
        self.assertEqual(self.table_comment, 'belongs-to-someone-else')
        self.assertTrue(any('already exists' in text for text in result['warnings']))
        self.assertFalse(any(args[1] == 'delete' for args in self.commands))

    def test_get_is_read_only_and_start_cannot_steal_a_new_lock(self):
        self.runtime.start(self.request())
        self.assertTrue(self.runtime.get()['active'])
        with self.assertRaises(Exception): self.runtime.start(self.request())
        before = dict(self.files), dict(self.dirs), list(self.commands)
        self.clock += 15
        result = self.runtime.get()
        self.assertFalse(result['active'])
        self.assertTrue(result['interrupted'])
        self.assertEqual(before, (self.files, self.dirs, self.commands))

    def test_management_lock_blocks_capture(self):
        self.mkdir('/tmp/xray-router-ui/lock', 448)
        with self.assertRaises(Exception): self.runtime.start(self.request())
        self.assertFalse(self.commands)

    def test_stop_serializes_cleanup_and_rejects_obsolete_capture_ids(self):
        result = self.run_capture()
        original_command = self.command
        attempted = []

        def concurrent_start(argv, timeout=None):
            if not attempted:
                attempted.append(True)
                with self.assertRaisesRegex(Exception, 'control is busy'):
                    self.runtime.start(self.request())
            return original_command(argv, timeout)

        # Reload the real adapter with a command hook simulating a second RPC
        # arriving while Stop verifies/removes the previous capture table.
        self.runtime = self.lua.execute((MODULES / 'inspector-runtime.lua').read_text(), self.table({
            'now': lambda: self.clock, 'command': concurrent_start, 'spawn': self.spawn, 'launch': self.launch}))
        self.runtime.stop(self.table({'id': result['id']}))
        self.assertTrue(attempted)
        self.assertFalse(self.control_locked)
        self.clock += 1
        new_capture = self.runtime.start(self.request())
        with self.assertRaisesRegex(Exception, 'Capture changed'):
            self.runtime.stop(self.table({'id': result['id']}))
        self.assertEqual(self.runtime.get()['id'], new_capture['id'])
        self.assertTrue(self.runtime.get()['active'])
        self.assertFalse(self.control_locked)


class RPCContractTest(LuaTest):
    def setUp(self):
        super().setUp()
        self.outputs, self.calls = [], []
        self.input = '{}'
        self.script = (ROOT / 'luci-app-xray-router/root/usr/libexec/rpcd/luci.xray-inspector').read_text().split('\n', 1)[1]
        self.lua.globals().py_parse = lambda raw: self.table(json.loads(raw))
        self.lua.globals().py_encode = lambda value: json.dumps(self.plain(value))
        self.lua.globals().py_input = lambda size: self.input[:size]
        self.lua.globals().py_print = self.outputs.append
        self.lua.globals().py_dispatch = lambda method, request=None: self.calls.append((method, self.plain(request))) or self.table({'ok': True})
        self.lua.execute('''
            package.preload['luci.jsonc'] = function() return {parse=py_parse, stringify=py_encode} end
            print=py_print; io.read=py_input
            dofile=function() return {
                options=function() return py_dispatch('options') end,
                get=function() return py_dispatch('get') end,
                start=function(request) return py_dispatch('capture', request) end,
                stop=function(request) return py_dispatch('stop', request) end
            } end
        ''')

    def invoke(self, mode, method=None, request=None):
        self.lua.globals().arg = self.table([mode] + ([method] if method else []))
        if request is not None: self.input = json.dumps(request)
        self.lua.execute(self.script)
        return json.loads(self.outputs[-1])

    def test_signatures_match_acl_and_dispatch(self):
        signatures = self.invoke('list')
        acl = json.loads((ROOT / 'luci-app-xray-router/root/usr/share/rpcd/acl.d/luci-app-xray-router.json').read_text())['luci-app-xray-router']
        reads = acl['read']['ubus']['luci.xray-inspector']
        writes = acl['write']['ubus']['luci.xray-inspector']
        self.assertEqual(set(signatures), set(reads + writes))
        self.assertEqual(set(reads), {'options', 'get'})
        self.assertEqual(set(writes), {'capture', 'stop'})
        self.assertEqual(signatures['capture'], {'device': '', 'duration': 60, 'expected': ''})
        self.assertEqual(signatures['stop'], {'id': ''})
        for method in signatures:
            request = {'device': DEVICE, 'duration': 60, 'expected': 'proxy-stream'} if method == 'capture' else {'id': '42-123'} if method == 'stop' else {}
            self.assertTrue(self.invoke('call', method, request)['ok'])
            self.assertEqual(self.calls[-1], (method, request if method in writes else None))

    def test_invalid_and_oversized_requests_do_not_dispatch(self):
        self.assertIn('error', self.invoke('call', 'restart', {}))
        self.input = '{invalid'
        self.assertIn('error', self.invoke('call', 'capture'))
        self.input = ' ' * 4097
        self.assertIn('Request too large', self.invoke('call', 'capture')['error'])
        self.assertFalse(self.calls)


if __name__ == '__main__': unittest.main(verbosity=2)
