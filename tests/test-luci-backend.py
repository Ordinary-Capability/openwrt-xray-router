#!/usr/bin/env python3
"""Run with Python + lupa (Lua 5.1 runtime); no router or network access."""
import hashlib
import json
from pathlib import Path
import unittest

from lupa.lua51 import LuaRuntime

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'luci-app-xray-router/root/usr/libexec/xray-router/ui.lua'


class BackendTest(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        self.conf = '/etc/xray-router'
        self.work = '/tmp/xray-router-ui'
        self.fs = {self.conf + '/' + p.name: p.read_text(encoding='utf-8')
                   for p in (ROOT / 'config').iterdir() if p.is_file()}
        self.calls = []
        self.running = False
        self.validation_fails = False
        self.restart_failures = 0
        self.write_failure = None
        self.capture_running = False
        self.jsonc_empty_arrays = False
        deps = self.lua.table_from({
            'conf': self.conf, 'work': self.work, 'read': self.fs.get,
            'mkdir': lambda _: None, 'remove': lambda p: self.fs.pop(p, None),
            'atomic': self.atomic, 'running': lambda: self.running,
            'enabled': lambda: False, 'revision': lambda _: self.revision(),
            'capture_active': lambda: self.capture_running,
            'test_node': self.run_node_test,
            'run': self.run_command,
            'json': self.lua.table_from({'parse': self.parse, 'stringify': lambda data: json.dumps(self.from_lua(data))})})
        self.backend = self.lua.execute(BACKEND.read_text(encoding='utf-8')).new(deps)
        self.perform = self.lua.eval('function(backend, request) return pcall(backend.perform, request) end')
        self.original = self.snapshot()

    def table(self, value):
        if isinstance(value, dict):
            return self.lua.table_from({k: self.table(v) for k, v in value.items()})
        if isinstance(value, list):
            return self.lua.table_from([self.table(v) for v in value])
        return value

    def parse(self, text):
        try:
            return self.table(json.loads(text))
        except ValueError:
            return None

    def from_lua(self, value):
        if hasattr(value, 'items'):
            items = dict(value.items())
            if not items and self.jsonc_empty_arrays:
                return []  # OpenWrt luci.jsonc serializes every empty Lua table as [].
            if items and all(isinstance(k, int) for k in items):
                return [self.from_lua(items[k]) for k in sorted(items)]
            return {k: self.from_lua(v) for k, v in items.items()}
        return value

    def revision(self):
        return hashlib.sha256(''.join(self.snapshot().values()).encode()).hexdigest()

    def snapshot(self):
        return {name: self.fs[self.conf + '/' + name]
                for name in ('config.json', 'settings.conf', 'nodes.json') if self.conf + '/' + name in self.fs}

    def atomic(self, path, value):
        if self.write_failure == path:
            self.write_failure = None
            raise RuntimeError('simulated disk error')
        self.fs[path] = value

    def run_command(self, action, directory=None):
        self.calls.append((action, directory))
        if action == 'firewall-check':
            self.assertNotEqual(directory, self.conf)
            candidate = json.loads(self.fs[directory + '/config.json'])
            self.assertEqual(candidate['dns'], json.loads(self.original['config.json'])['dns'])
            for name in ('cn-ipv4.txt', 'proxy-server-ipv4.txt'):
                self.assertEqual(self.fs[directory + '/' + name], self.fs[self.conf + '/' + name])
            return (1 if self.validation_fails else 0), 'validation output'
        if action == 'restart' and self.restart_failures:
            self.restart_failures -= 1
            return 1, 'restart failed'
        return 0, action + ' succeeded'

    def run_node_test(self, outbound):
        self.calls.append(('test-node', self.from_lua(outbound)))
        return self.table({'code': 0, 'output': 'Connected', 'node_test': {'success': True, 'latency_ms': 123}})

    def test_node_uses_draft_without_changing_live_files(self):
        outbound = {'protocol': 'socks', 'settings': {'address': '192.0.2.20', 'port': 1080}}
        self.running = True
        self.capture_running = True
        ok, result = self.call({'action': 'test-node', 'config': json.dumps(outbound)})
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        self.assertTrue(result['node_test']['success'])
        self.assertEqual(self.calls, [('test-node', outbound)])
        self.assertEqual(self.snapshot(), self.original)

    def test_node_rejects_invalid_payload_before_launch(self):
        for payload in ['[]', '{}', '{bad', json.dumps({'protocol': 'socks', 'tag': 'live'}), ' ' * 262145]:
            ok, result = self.call({'action': 'test-node', 'config': payload})
            self.assertFalse(ok, result)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.snapshot(), self.original)

    def request(self):
        config = json.loads(self.original['config.json'])
        config['observatory']['probeInterval'] = '20s'
        primary = next(o for o in config['outbounds'] if o['tag'] == 'proxy-main')
        primary.update(protocol='socks', settings={'address': '192.0.2.1', 'port': 1080})
        return {'action': 'save', 'config': json.dumps(config), 'revision': self.revision(),
                'settings': {'LAN_INTERFACES': 'br-lan br-guest', 'ENABLE_CN_FASTPATH': '0', 'IPV6_MODE': 'block'}}

    def call(self, request):
        return self.perform(self.backend, self.table(request))

    def test_save_stopped_retains_backup_and_other_settings(self):
        request = self.request()
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.fs[self.conf + '/config.json'], request['config'])
        self.assertIn('MANAGE_DNSMASQ="1"', self.fs[self.conf + '/settings.conf'])
        self.assertIn('LAN_INTERFACES="br-lan br-guest"', self.fs[self.conf + '/settings.conf'])
        self.assertEqual(self.fs[self.conf + '/backups/luci-last/config.json'], self.original['config.json'])
        self.assertEqual([c[0] for c in self.calls], ['firewall-check'])
        self.assertNotIn(self.conf + '/backups/luci-pending', self.fs)

    def test_running_save_restarts(self):
        self.running = True
        ok, result = self.call(self.request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 0)
        self.assertEqual([c[0] for c in self.calls], ['firewall-check', 'restart'])

    def test_xray_only_save_skips_preflight_and_rolls_back_startup_failure(self):
        self.running = True
        request = self.request()
        request['settings'] = self.backend.get()['settings']
        config = json.loads(request['config'])
        config['outbounds'][0]['protocol'] = 'unsupported-protocol'
        request['config'] = json.dumps(config)
        self.restart_failures = 1
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 1)
        self.assertIn('Previous configuration restored', result['output'])
        self.assertEqual([c[0] for c in self.calls], ['restart', 'restart'])
        self.assertEqual(self.snapshot(), self.original)

    def test_stopped_xray_only_save_defers_validation_until_start(self):
        request = self.request()
        request['settings'] = self.backend.get()['settings']
        config = json.loads(request['config'])
        config['outbounds'][0]['protocol'] = 'unsupported-protocol'
        request['config'] = json.dumps(config)
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        self.assertIn('checked on next start', result['output'])
        self.assertEqual(self.calls, [])

    def test_validation_failure_never_writes_live_files(self):
        self.validation_fails = True
        ok, result = self.call(self.request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), self.original)
        self.assertNotIn(self.conf + '/backups/luci-last/config.json', self.fs)

    def test_restart_failure_restores_and_restarts_previous(self):
        self.running = True
        self.restart_failures = 1
        ok, result = self.call(self.request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), self.original)
        self.assertEqual([c[0] for c in self.calls], ['firewall-check', 'restart', 'restart'])

    def test_partial_commit_restores_both_files(self):
        self.write_failure = self.conf + '/settings.conf'
        ok, result = self.call(self.request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), self.original)

    def test_failed_service_recovery_retains_journal(self):
        self.running = True
        self.restart_failures = 2
        ok, result = self.call(self.request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertIn(self.conf + '/backups/luci-pending', self.fs)
        self.assertTrue(self.backend.get()['recovery_required'])

    def test_stale_revision_rejected(self):
        request = self.request()
        self.fs[self.conf + '/settings.conf'] += '\n# concurrent CLI edit\n'
        ok, _ = self.call(request)
        self.assertFalse(ok)
        self.assertFalse(self.calls)

    def test_shell_injection_and_extra_settings_rejected(self):
        for value in ['br-lan;reboot', '$(reboot)', 'br-lan\nreboot', 'br-lan"', 'br-lan`reboot`']:
            request = self.request()
            request['settings']['LAN_INTERFACES'] = value
            ok, _ = self.call(request)
            self.assertFalse(ok, value)
        request = self.request()
        request['settings']['XRAY_ASSET_DIR'] = '/tmp'
        self.assertFalse(self.call(request)[0])
        self.assertEqual(self.snapshot(), self.original)

    def test_dns_and_balancer_edits_rejected(self):
        for mutate in [lambda c: c['dns'].update(servers=[]),
                       lambda c: c['routing']['balancers'][0].update(fallbackTag='direct'),
                       lambda c: c['observatory'].update(subjectSelector=['proxy-backup'])]:
            request = self.request()
            config = json.loads(request['config'])
            mutate(config)
            request['config'] = json.dumps(config)
            self.assertFalse(self.call(request)[0])
        self.assertFalse(self.calls)

    def test_empty_domain_rule_rejected(self):
        request = self.request()
        config = json.loads(request['config'])
        next(r for r in config['routing']['rules'] if r['ruleTag'] == 'FORCE-DIRECT')['domain'] = []
        request['config'] = json.dumps(config)
        self.assertFalse(self.call(request)[0])

    def streaming_request(self):
        request = self.request()
        config = json.loads(request['config'])
        stream = next(o for o in config['outbounds'] if o['tag'] == 'proxy-stream')
        stream.update(json.loads((ROOT / 'examples/outbound-stream-vless-reality.json').read_text()))
        rule = next(r for r in config['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')
        rule.update(json.loads((ROOT / 'examples/routing-streaming.json').read_text()))
        request['config'] = json.dumps(config)
        return request

    def test_streaming_enable_disable_preserves_node_and_domains(self):
        request = self.streaming_request()
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        enabled = json.loads(request['config'])
        disabled = json.loads(request['config'])
        rule = next(r for r in disabled['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')
        rule['inboundTag'] = ['xray-router-stream-disabled']
        request.update(config=json.dumps(disabled), revision=self.revision())
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        saved = json.loads(self.fs[self.conf + '/config.json'])
        self.assertEqual(saved['outbounds'], enabled['outbounds'])
        self.assertEqual(saved['dns'], enabled['dns'])
        self.assertEqual(rule['domain'], next(r for r in enabled['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')['domain'])
        request.update(config=json.dumps(enabled), revision=self.revision())
        self.assertTrue(self.call(request)[0])

    def test_streaming_multiple_proxy_inbounds_save_and_toggle(self):
        config = json.loads(self.streaming_request()['config'])
        rule = next(r for r in config['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')
        scope = ['tproxy-in', 'socks-in', 'http-in']
        rule['inboundTag'] = scope
        self.fs[self.conf + '/config.json'] = json.dumps(config)
        self.original = self.snapshot()
        request = self.request()
        for tags in (scope, ['xray-router-stream-disabled'], scope):
            rule['inboundTag'] = tags
            request.update(config=json.dumps(config), revision=self.revision())
            ok, result = self.call(request)
            self.assertTrue(ok, result)
            self.assertEqual(result['code'], 0)
            saved = json.loads(self.fs[self.conf + '/config.json'])
            self.assertEqual(saved['inbounds'], config['inbounds'])
            self.assertEqual(saved['dns'], config['dns'])
        for tags in (['tproxy-in', 'dns-in'], ['tproxy-in', 'dns-global'],
                     ['tproxy-in', 'unknown'], ['tproxy-in', 'socks-in', 'socks-in'],
                     ['socks-in'], ['tproxy-in', 'xray-router-stream-disabled']):
            rule['inboundTag'] = tags
            request.update(config=json.dumps(config), revision=self.revision())
            self.assertFalse(self.call(request)[0], tags)

    def test_streaming_upgrade_from_config_without_streaming(self):
        legacy = json.loads(self.original['config.json'])
        legacy['outbounds'] = [o for o in legacy['outbounds'] if o['tag'] != 'proxy-stream']
        legacy['routing']['rules'] = [r for r in legacy['routing']['rules'] if r['ruleTag'] != 'STREAMING-PROXY']
        request = self.streaming_request()
        candidate = json.loads(request['config'])
        # Match the UI's append-only outbound migration; keep existing outbound order.
        stream = next(o for o in candidate['outbounds'] if o['tag'] == 'proxy-stream')
        candidate['outbounds'].remove(stream)
        candidate['outbounds'].append(stream)
        self.fs[self.conf + '/config.json'] = json.dumps(legacy)
        self.original = self.snapshot()
        request.update(config=json.dumps(candidate), revision=self.revision())
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.fs[self.conf + '/backups/luci-last/config.json'], self.original['config.json'])
        self.assertTrue(self.call({'action': 'rollback', 'revision': self.revision()})[0])
        self.assertEqual(self.snapshot(), self.original)

    def test_streaming_scope_destination_order_and_duplicates_rejected(self):
        for kind in ['inbound', 'destination', 'balancer', 'order', 'duplicate-rule', 'duplicate-node', 'remove', 'extra-field']:
            with self.subTest(kind=kind):
                request = self.streaming_request()
                config = json.loads(request['config'])
                rule = next(r for r in config['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')
                if kind == 'inbound': rule['inboundTag'] = ['dns-global']
                if kind == 'destination': rule['outboundTag'] = 'direct'
                if kind == 'balancer': rule['balancerTag'] = 'proxy-failover'
                if kind == 'order':
                    config['routing']['rules'].remove(rule)
                    config['routing']['rules'].insert(0, rule)
                if kind == 'duplicate-rule': config['routing']['rules'].append(rule)
                if kind == 'duplicate-node': config['outbounds'].append(next(o for o in config['outbounds'] if o['tag'] == 'proxy-stream'))
                if kind == 'remove': config['routing']['rules'].remove(rule)
                if kind == 'extra-field': rule['port'] = '443'
                request['config'] = json.dumps(config)
                self.assertFalse(self.call(request)[0])
        self.assertFalse(self.calls)
        self.assertEqual(self.snapshot(), self.original)

    def test_streaming_blackhole_and_invalid_domains_rejected(self):
        for domains in [[], [''], ['domain:bad name'], {'0': 'netflix.com'}]:
            request = self.streaming_request()
            config = json.loads(request['config'])
            next(r for r in config['routing']['rules'] if r['ruleTag'] == 'STREAMING-PROXY')['domain'] = domains
            request['config'] = json.dumps(config)
            self.assertFalse(self.call(request)[0])
        request = self.streaming_request()
        config = json.loads(request['config'])
        next(o for o in config['outbounds'] if o['tag'] == 'proxy-stream')['protocol'] = 'blackhole'
        request['config'] = json.dumps(config)
        ok, error = self.call(request)
        self.assertFalse(ok)
        self.assertIn('Configure the streaming node', error)
        self.assertFalse(self.calls)

    def test_streaming_failed_restart_rolls_back_node_domains_and_enablement(self):
        self.running = True
        self.restart_failures = 1
        ok, result = self.call(self.streaming_request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), self.original)

    def test_streaming_validation_failure_retains_configuration(self):
        self.validation_fails = True
        ok, result = self.call(self.streaming_request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), self.original)

    def test_unknown_action_rejected(self):
        self.assertFalse(self.call({'action': 'stop; reboot'})[0])
        self.assertFalse(self.calls)

    def test_cn_update_dispatches_existing_command_and_obeys_recovery_lock(self):
        ok, result = self.call({'action': 'update-cn'})
        self.assertTrue(ok)
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.calls, [('update-cn', None)])
        self.assertEqual(self.snapshot(), self.original)
        self.assertFalse(self.call({'action': 'update-cn; reboot'})[0])
        self.fs[self.conf + '/backups/luci-pending'] = 'interrupted'
        self.assertFalse(self.call({'action': 'update-cn'})[0])
        self.assertEqual(self.calls, [('update-cn', None)])

    def test_logging_action_changes_only_level_and_stopped_service_stays_stopped(self):
        ok, result = self.call({'action': 'logging-info', 'revision': self.revision()})
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        expected = json.loads(self.original['config.json'])
        expected['log']['loglevel'] = 'info'
        self.assertEqual(json.loads(self.fs[self.conf + '/config.json']), expected)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.fs[self.conf + '/settings.conf'], self.original['settings.conf'])

    def test_logging_preserves_raw_json_with_openwrt_empty_table_encoding(self):
        self.jsonc_empty_arrays = True
        self.running = True
        config = json.loads(self.original['config.json'])
        config['inbounds'].append({'tag': 'http-in', 'listen': '192.168.80.2',
                                  'port': 10809, 'protocol': 'http', 'settings': {}})
        config['log']['access'] = 'path/with/"quotes"/and\\slashes/{},[]:loglevel'
        config['unrelated'] = {'loglevel': 'warning', 'empty_object': {}, 'empty_array': [],
                               'nullable': None, 'integer': 9007199254740993,
                               'nested': [{}, [], {'log': {'loglevel': 'warning'}}]}
        raw = json.dumps(config, indent=2) + '\n'
        self.assertEqual(self.from_lua(self.parse(raw))['inbounds'][-1]['settings'], [])
        for escaped in (False, True):
            with self.subTest(escaped_keys=escaped):
                original = raw.replace('"log":', '"lo\\u0067":', 1) if escaped else raw
                original = original.replace('"loglevel":', '"log\\u006cevel":', 1) if escaped else original
                self.fs[self.conf + '/config.json'] = original
                self.original = self.snapshot()
                ok, result = self.call({'action': 'logging-info', 'revision': self.revision()})
                self.assertTrue(ok, result)
                self.assertEqual(result['code'], 0)
                self.assertEqual(self.fs[self.conf + '/config.json'], original.replace('"warning"', '"info"', 1))
                ok, result = self.call({'action': 'logging-warning', 'revision': self.revision()})
                self.assertTrue(ok, result)
                self.assertEqual(result['code'], 0)
                self.assertEqual(self.snapshot(), self.original)

    def test_logging_creates_missing_log_object_or_level(self):
        for log in ('missing', None, {}, {'access': 'none', 'dnsLog': False}):
            with self.subTest(log=log):
                config = json.loads(self.original['config.json'])
                config.pop('log', None)
                if log != 'missing':
                    config['log'] = log
                self.fs[self.conf + '/config.json'] = json.dumps(config)
                ok, result = self.call({'action': 'logging-info', 'revision': self.revision()})
                self.assertTrue(ok, result)
                self.assertEqual(result['code'], 0)
                config['log'] = {**(log if isinstance(log, dict) else {}), 'loglevel': 'info'}
                self.assertEqual(json.loads(self.fs[self.conf + '/config.json']), config)

    def test_logging_rejects_ambiguous_duplicate_members(self):
        original = self.original['config.json']
        for raw in (original.replace('"log":', '"log": {}, "lo\\u0067":', 1),
                    original.replace('"loglevel":', '"loglevel": "error", "log\\u006cevel":', 1)):
            self.fs[self.conf + '/config.json'] = raw
            before = self.snapshot()
            ok, error = self.call({'action': 'logging-info', 'revision': self.revision()})
            self.assertFalse(ok)
            self.assertIn('Duplicate JSON member', str(error))
            self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.calls, [])

    def test_logging_unchanged_level_does_not_restart(self):
        self.running = True
        ok, result = self.call({'action': 'logging-warning', 'revision': self.revision()})
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.snapshot(), self.original)

    def test_logging_restart_failure_rolls_back_and_capture_blocks_log_changes(self):
        self.running = True
        self.restart_failures = 1
        ok, result = self.call({'action': 'logging-info', 'revision': self.revision()})
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), self.original)
        self.capture_running = True
        for action in ['logging-info', 'logging-warning', 'restart', 'firewall-reload', 'rollback', 'update-cn']:
            self.assertFalse(self.call({'action': action, 'revision': self.revision()})[0])
        self.assertFalse(self.call(self.request())[0])
        self.assertTrue(self.call({'action': 'stop'})[0], 'emergency service stop must stay available')

    def test_logging_requires_current_revision_and_cannot_be_changed_by_normal_save(self):
        self.assertFalse(self.call({'action': 'logging-info', 'revision': 'stale'})[0])
        request = self.request()
        config = json.loads(request['config'])
        config['log']['loglevel'] = 'info'
        request['config'] = json.dumps(config)
        self.assertFalse(self.call(request)[0])
        self.assertEqual(self.snapshot(), self.original)

    def test_rollback_and_interrupted_transaction_recovery(self):
        self.assertTrue(self.call(self.request())[0])
        self.fs[self.conf + '/backups/luci-pending'] = 'interrupted'
        self.assertFalse(self.call(self.request())[0])
        ok, result = self.call({'action': 'rollback', 'revision': self.revision()})
        self.assertTrue(ok)
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.snapshot(), self.original)
        self.assertNotIn(self.conf + '/backups/luci-pending', self.fs)

    def seed_host_node(self):
        config = json.loads(self.fs[self.conf + '/config.json'])
        primary = next(o for o in config['outbounds'] if o['tag'] == 'proxy-main')
        primary.update(protocol='socks', settings={'address': '192.168.80.1', 'port': 50777},
                       streamSettings={'sockopt': {'mark': 2}})
        self.fs[self.conf + '/config.json'] = json.dumps(config)
        self.original = self.snapshot()

    def library_request(self):
        state = self.backend.get()
        return {'action': 'save', 'config': state['config'], 'revision': state['revision'],
                'settings': self.from_lua(state['settings']), 'nodes': state['nodes']}

    def test_library_migration_is_read_only_and_preserves_outbound(self):
        self.seed_host_node()
        state = self.backend.get()
        library = json.loads(state['nodes'])
        self.assertEqual(self.snapshot(), self.original)
        self.assertFalse(self.calls)
        self.assertEqual(library['bindings']['proxy-main'], 'node-proxy-main')
        self.assertEqual(library['bindings']['proxy-backup'], '')
        node = library['nodes']['node-proxy-main']
        self.assertEqual(node['alias'], 'host-socks')
        self.assertNotIn('tag', node['outbound'])
        self.assertEqual(node['outbound']['streamSettings']['sockopt']['mark'], 2)

    def test_library_only_save_and_rename_do_not_restart_or_rewrite_runtime(self):
        self.seed_host_node()
        self.running = True
        request = self.library_request()
        library = json.loads(request['nodes'])
        library['nodes']['node-proxy-main']['alias'] = 'us-vps'
        library['nodes']['node-unused'] = {'alias': 'jp-vps', 'outbound': {'protocol': 'socks', 'settings': {'address': '192.0.2.20', 'port': 1080}}}
        request['nodes'] = json.dumps(library)
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        self.assertIn('no restart', result['output'])
        self.assertFalse(self.calls)
        for name, content in self.original.items():
            self.assertEqual(self.fs[self.conf + '/' + name], content)
        self.assertEqual(json.loads(self.fs[self.conf + '/nodes.json']), library)
        self.assertNotEqual(self.revision(), request['revision'])

    def test_shared_node_assignment_keeps_routing_and_sets_each_tag(self):
        self.seed_host_node()
        self.running = True
        request = self.library_request()
        library = json.loads(request['nodes'])
        config = json.loads(request['config'])
        for tag in ('proxy-backup', 'proxy-stream'):
            library['bindings'][tag] = 'node-proxy-main'
            index = next(i for i, o in enumerate(config['outbounds']) if o['tag'] == tag)
            config['outbounds'][index] = dict(library['nodes']['node-proxy-main']['outbound'], tag=tag)
        request.update(config=json.dumps(config), nodes=json.dumps(library))
        ok, result = self.call(request)
        self.assertTrue(ok, result)
        self.assertEqual(result['code'], 0)
        self.assertEqual([c[0] for c in self.calls], ['restart'])
        saved = json.loads(self.fs[self.conf + '/config.json'])
        self.assertEqual(saved['routing'], json.loads(self.original['config.json'])['routing'])
        self.assertEqual(saved['inbounds'], json.loads(self.original['config.json'])['inbounds'])

    def test_bad_library_and_mismatched_materialization_are_rejected(self):
        self.seed_host_node()
        mutations = [
            lambda lib: lib['bindings'].update({'proxy-main': 'node-missing'}),
            lambda lib: lib['bindings'].update({'direct': 'node-proxy-main'}),
            lambda lib: lib['nodes']['node-proxy-main']['outbound'].update(tag='arbitrary'),
            lambda lib: lib['nodes']['node-proxy-main']['outbound']['settings'].update(port=9999),
            lambda lib: lib['nodes'].update({'node-copy': dict(lib['nodes']['node-proxy-main'])}),
            lambda lib: lib['nodes']['node-proxy-main'].update(alias=' invalid '),
            lambda lib: lib['nodes'].pop('node-proxy-main'),
            lambda lib: lib.update(version=2),
        ]
        for mutate in mutations:
            request = self.library_request()
            library = json.loads(request['nodes'])
            mutate(library)
            request['nodes'] = json.dumps(library)
            self.assertFalse(self.call(request)[0])
        self.assertEqual(self.snapshot(), self.original)
        self.assertFalse(self.calls)

    def test_library_partial_write_failure_restores_absent_file_without_restart(self):
        self.seed_host_node()
        self.running = True
        self.write_failure = self.conf + '/nodes.json'
        ok, result = self.call(self.library_request())
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), self.original)
        self.assertNotIn(self.conf + '/nodes.json', self.fs)
        self.assertFalse(self.calls)

    def test_library_and_runtime_recover_together_after_failed_restart(self):
        self.seed_host_node()
        self.assertEqual(self.call(self.library_request())[1]['code'], 0)
        before = self.snapshot()
        request = self.library_request()
        library, config = json.loads(request['nodes']), json.loads(request['config'])
        library['nodes']['node-proxy-main']['outbound']['settings']['port'] = 50888
        next(o for o in config['outbounds'] if o['tag'] == 'proxy-main')['settings']['port'] = 50888
        request.update(nodes=json.dumps(library), config=json.dumps(config))
        self.running = True
        self.restart_failures = 1
        ok, result = self.call(request)
        self.assertTrue(ok)
        self.assertEqual(result['code'], 1)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual([c[0] for c in self.calls], ['restart', 'restart'])

    def test_metadata_rollback_and_old_backups_without_library(self):
        self.seed_host_node()
        before = self.snapshot()
        self.assertEqual(self.call(self.library_request())[1]['code'], 0)
        self.running = True
        ok, result = self.call({'action': 'rollback', 'revision': self.revision()})
        self.assertTrue(ok)
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.calls)

    def test_library_conflict_detection_and_external_outbound_import(self):
        self.seed_host_node()
        self.assertEqual(self.call(self.library_request())[1]['code'], 0)
        request = self.library_request()
        library = json.loads(request['nodes'])
        library['nodes']['node-proxy-main']['alias'] = 'renamed-elsewhere'
        self.fs[self.conf + '/nodes.json'] = json.dumps(library)
        self.assertFalse(self.call(request)[0], 'metadata-only writes must check the library revision')
        config = json.loads(self.fs[self.conf + '/config.json'])
        next(o for o in config['outbounds'] if o['tag'] == 'proxy-main')['settings']['port'] = 50888
        self.fs[self.conf + '/config.json'] = json.dumps(config)
        before = self.snapshot()
        state = self.backend.get()
        imported = json.loads(state['nodes'])
        self.assertIn('outside', state['nodes_notice'])
        self.assertEqual(len(imported['nodes']), 2)
        current = imported['nodes'][imported['bindings']['proxy-main']]
        self.assertEqual(current['outbound']['settings']['port'], 50888)
        self.assertEqual(self.snapshot(), before, 'get must not persist imported changes')

    def test_logging_preserves_the_library(self):
        self.seed_host_node()
        self.assertEqual(self.call(self.library_request())[1]['code'], 0)
        before = self.fs[self.conf + '/nodes.json']
        ok, result = self.call({'action': 'logging-info', 'revision': self.revision()})
        self.assertTrue(ok)
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.fs[self.conf + '/nodes.json'], before)


class RPCContractTest(unittest.TestCase):
    """Execute the real rpcd entry point with fake nixio I/O and process calls."""
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        self.outputs = []
        self.input = '{}'
        self.fs = {}
        self.dirs = {}
        self.commands = []
        self.script = (ROOT / 'luci-app-xray-router/root/usr/libexec/rpcd/luci.xray-router').read_text(encoding='utf-8').split('\n', 1)[1]
        self.lua.globals().backend_source = BACKEND.read_text(encoding='utf-8')
        self.lua.globals().py_read = lambda p: self.fs[p] if p in self.fs else (None, 'No such file', 2)
        self.lua.globals().py_write = lambda p, s: self.fs.__setitem__(p, s) or len(s)
        self.lua.globals().py_unlink = lambda p: self.fs.pop(p, None) is not None
        self.lua.globals().py_rename = lambda a, b: self.fs.__setitem__(b, self.fs.pop(a)) or True
        self.lua.globals().py_mkdir = self.mkdir
        self.lua.globals().py_rmdir = lambda p: self.dirs.pop(p, None) is not None
        self.lua.globals().py_stat = lambda p: self.lua.table_from(self.dirs[p]) if p in self.dirs else None
        self.lua.globals().py_parse = lambda text: self.to_lua(json.loads(text))
        self.lua.globals().py_encode = lambda value: json.dumps(self.from_lua(value))
        self.lua.globals().py_input = lambda: self.input
        self.lua.globals().py_command = self.command
        self.lua.globals().py_print = self.outputs.append
        self.lua.execute('''
            package.preload['luci.jsonc'] = function() return { parse=py_parse, stringify=py_encode } end
            package.preload['nixio.fs'] = function() return {
                readfile=py_read, unlink=py_unlink, rename=py_rename, mkdir=py_mkdir,
                rmdir=py_rmdir, stat=py_stat, lstat=py_stat,
                chmod=function(_, mode) assert(mode == '700', 'nixio expects octal strings'); return true end
            } end
            package.preload['nixio'] = function() return {
                getpid=function() return 4321 end, fork=function() return 4321 end,
                gettimeofday=function() return 1700000000, 1234 end,
                kill=function() return true end,
                open=function(path, flags, mode)
                    assert(mode == '600', 'nixio expects octal strings')
                    return {
                    writeall=function(_, data) return py_write(path, data) end,
                    sync=function() return true end, close=function() return true end
                } end
            } end
            dofile=function() return assert(loadstring(backend_source))() end
            print=py_print
            io.read=function() return py_input() end
            io.popen=function(cmd)
                local data=py_command(cmd)
                return {read=function() return data end, close=function() return true end}
            end
        ''')

    def to_lua(self, value):
        if isinstance(value, dict): return self.lua.table_from({k: self.to_lua(v) for k, v in value.items()})
        if isinstance(value, list): return self.lua.table_from([self.to_lua(v) for v in value])
        return value

    def from_lua(self, value):
        if hasattr(value, 'items'):
            entries = dict(value.items())
            if entries and all(isinstance(k, int) for k in entries):
                return [self.from_lua(entries[k]) for k in sorted(entries)]
            return {k: self.from_lua(v) for k, v in entries.items()}
        return value

    def mkdir(self, path, mode):
        if path in self.dirs: return False
        self.assertEqual(mode, '700')
        self.dirs[path] = {'uid': 0, 'type': 'dir', 'mtime': 9999999999}
        return True

    def command(self, cmd):
        self.commands.append(cmd)
        self.assertIn('printf', cmd)
        return 'command output\nXRAY_UI_EXIT=0\n'

    def invoke(self, mode, method=None, data=None):
        self.input = json.dumps(data or {})
        self.lua.globals().arg = self.lua.table_from([mode] + ([method] if method else []))
        self.outputs.clear()
        self.lua.execute(self.script)
        return json.loads(self.outputs[-1]) if self.outputs else None

    def test_signatures_match_acl(self):
        signatures = self.invoke('list')
        acl = json.loads((ROOT / 'luci-app-xray-router/root/usr/share/rpcd/acl.d/luci-app-xray-router.json').read_text())['luci-app-xray-router']
        reads = acl['read']['ubus']['luci.xray-router']
        writes = acl['write']['ubus']['luci.xray-router']
        self.assertEqual(set(signatures), set(reads + writes))
        self.assertEqual(writes, ['start'])
        self.assertEqual(signatures['start']['settings'], {})
        self.assertEqual(signatures['start']['nodes'], '')

    def test_queue_worker_and_progress_contract(self):
        started = self.invoke('call', 'start', {'action': 'validate'})
        self.assertTrue(started['busy'])
        self.assertTrue(started['id'])
        self.assertEqual(self.invoke('call', 'job')['id'], started['id'])
        self.assertIn('error', self.invoke('call', 'start', {'action': 'restart'}))
        self.invoke('worker')
        result = self.invoke('call', 'job')
        self.assertFalse(result['busy'])
        self.assertEqual(result['code'], 0)
        self.assertEqual(result['action'], 'validate')
        self.assertEqual(result['id'], started['id'])
        self.assertEqual(result['output'], 'command output')
        self.assertTrue(any("/usr/sbin/xrayctl 'validate'" in c for c in self.commands))
        self.assertNotIn('/tmp/xray-router-ui/request', self.fs)
        self.assertNotIn('/tmp/xray-router-ui/lock/id', self.fs)

    def test_read_only_rpc_cannot_run_service_action(self):
        result = self.invoke('call', 'diagnostics', {'action': 'restart'})
        self.assertIn('error', result)
        self.assertFalse(self.commands)


if __name__ == '__main__':
    unittest.main(verbosity=2)
