/* No dependencies: exercise the shipped LuCI modules with a small DOM/RPC adapter. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'luci-app-xray-router/htdocs/luci-static/resources');
const raw = fs.readFileSync(path.join(root, 'config/config.json'), 'utf8');
const model = new Function('baseclass', fs.readFileSync(path.join(resources, 'xray-router/model.js'), 'utf8'))({ extend: x => x });
let values = model.read(raw);
values.primary = model.template('socks', 'wrong-tag');
values.backup = model.template('socks', 'proxy-backup');
values.probe_interval = 15;
values.direct = '';
values.proxy = 'example.org\nfull:exact.example';
const changed = JSON.parse(model.build(raw, values));
const original = JSON.parse(raw);
assert.deepEqual(changed.dns, original.dns);
assert.deepEqual(changed.inbounds, original.inbounds);
assert.deepEqual(changed.routing.balancers, original.routing.balancers);
assert.deepEqual(changed.outbounds.find(o => o.tag === 'dns-out'), original.outbounds.find(o => o.tag === 'dns-out'));
assert.deepEqual(changed.outbounds.find(o => o.tag === 'dns-failover'), original.outbounds.find(o => o.tag === 'dns-failover'));
assert.deepEqual(changed.routing.rules.find(r => r.ruleTag === 'DNS-GLOBAL-PROXY'),
	original.routing.rules.find(r => r.ruleTag === 'DNS-GLOBAL-PROXY'));
assert.equal(model.overview(raw).outbounds.find(o => o.tag === 'dns-failover').endpoint,
	'Internal routing via dns-forward');
// Existing streaming configuration round-trips through the expanded editor.
const streaming = JSON.parse(raw);
const streamOutbound = streaming.outbounds.find(o => o.tag === 'proxy-stream');
Object.assign(streamOutbound, JSON.parse(fs.readFileSync(path.join(root, 'examples/outbound-stream-vless-reality.json'), 'utf8')));
const streamRule = streaming.routing.rules.find(r => r.ruleTag === 'STREAMING-PROXY');
Object.assign(streamRule, JSON.parse(fs.readFileSync(path.join(root, 'examples/routing-streaming.json'), 'utf8')));
const streamValues = { ...model.read(JSON.stringify(streaming)), primary: values.primary, backup: values.backup };
const withStreaming = JSON.parse(model.build(JSON.stringify(streaming), streamValues));
assert.deepEqual(withStreaming.outbounds.find(o => o.tag === 'proxy-stream'), streamOutbound);
assert.deepEqual(withStreaming.routing.rules.find(r => r.ruleTag === 'STREAMING-PROXY'), streamRule);
assert.equal(model.read(raw).stream_enabled, '0');
assert.equal(model.read(raw).stream_domains, '');
const preset = model.streamingPreset('domain:custom.example\ngeosite:netflix');
assert.equal(model.streamingPreset(preset), preset, 'preset additions must be idempotent');
assert.equal(preset.split('\n').length, 5);
assert.throws(() => model.build(raw, { ...values, stream_enabled: '1', stream_domains: preset }), /Configure the streaming node/);
assert.throws(() => model.build(raw, { ...streamValues, stream_domains: '' }), /at least one streaming domain/);
assert.throws(() => model.build(raw, { ...values, stream_enabled: 'bad' }), /whether streaming routing/);
const disabled = model.build(JSON.stringify(streaming), { ...streamValues, stream_enabled: '0' });
assert.equal(model.read(disabled).stream_enabled, '0');
assert.equal(model.read(disabled).stream_domains, streamValues.stream_domains);
assert.deepEqual(JSON.parse(disabled).outbounds.find(o => o.tag === 'proxy-stream'), streamOutbound);
assert.deepEqual(JSON.parse(model.build(disabled, { ...model.read(disabled), stream_enabled: '1' }))
	.routing.rules.find(r => r.ruleTag === 'STREAMING-PROXY'), streamRule);
// A deployed router can include explicit SOCKS/HTTP listeners in the streaming scope.
const multiInbound = structuredClone(streaming);
const multiRule = multiInbound.routing.rules.find(r => r.ruleTag === 'STREAMING-PROXY');
multiRule.inboundTag = ['tproxy-in', 'socks-in', 'http-in'];
const multiRaw = JSON.stringify(multiInbound);
assert.equal(model.read(multiRaw).stream_enabled, '1');
assert.deepEqual(JSON.parse(model.build(multiRaw, model.read(multiRaw))), multiInbound,
	'ordinary saves must preserve streaming scope, DNS, and all listener settings');
const multiDisabled = model.build(multiRaw, { ...model.read(multiRaw), stream_enabled: '0' });
assert.equal(model.read(multiDisabled).stream_enabled, '0');
assert.deepEqual(JSON.parse(model.build(multiDisabled, { ...model.read(multiDisabled), stream_enabled: '1' })),
	multiInbound, 'disable/re-enable must restore streaming for SOCKS and HTTP');
const narrow = structuredClone(multiInbound);
narrow.routing.rules.find(r => r.ruleTag === 'STREAMING-PROXY').inboundTag = ['tproxy-in'];
assert.deepEqual(JSON.parse(model.build(JSON.stringify(narrow), model.read(JSON.stringify(narrow)))), narrow,
	'ordinary saves must not expand an existing scope');
const legacy = JSON.parse(raw);
legacy.outbounds = legacy.outbounds.filter(o => o.tag !== 'proxy-stream');
legacy.routing.rules = legacy.routing.rules.filter(r => r.ruleTag !== 'STREAMING-PROXY');
const legacyRaw = JSON.stringify(legacy);
assert.equal(model.read(legacyRaw).stream_enabled, '0');
const migrated = JSON.parse(model.build(legacyRaw, model.read(legacyRaw)));
assert.deepEqual(migrated.dns, legacy.dns);
assert.deepEqual(migrated.outbounds.slice(0, -1), legacy.outbounds);
const inserted = migrated.routing.rules.findIndex(r => r.ruleTag === 'STREAMING-PROXY');
assert.equal(migrated.routing.rules[inserted - 1].ruleTag, 'FORCE-DIRECT');
assert.deepEqual(migrated.routing.rules[inserted].inboundTag, ['xray-router-stream-disabled']);
assert.equal(changed.outbounds[0].tag, 'proxy-main');
assert.deepEqual(changed.routing.rules.find(r => r.ruleTag === 'FORCE-DIRECT').domain, ['domain:example-direct.invalid']);
assert.deepEqual(changed.routing.rules.find(r => r.ruleTag === 'FORCE-PROXY').domain, ['domain:example.org', 'full:exact.example']);
assert.throws(() => model.build(raw, { ...values, probe_interval: '0' }));
assert.throws(() => model.build(raw, { ...values, primary: '[]' }));
assert.throws(() => model.build(raw, { ...values, probe_url: 'file:///etc/shadow' }));

// Overview follows actual rule order and selector prefixes without exposing credentials.
const mappingRaw = JSON.stringify({ outbounds: [
	{ tag: 'proxy-main', protocol: 'socks', settings: { address: '192.168.80.1', port: 50777, password: 'private-current' } },
	{ tag: 'proxy-backup', protocol: 'vless', settings: { vnext: [{ address: 'backup.example', port: 443, users: [{ id: 'private-uuid' }] }] } },
	{ tag: 'proxy-stream', protocol: 'socks', settings: { servers: [{ address: 'stream.example', port: 1080, users: [{ pass: 'private-legacy' }] }] },
		streamSettings: { sockopt: { dialerProxy: 'proxy-main' } } },
	{ tag: 'direct', protocol: 'freedom' }
], routing: { balancers: [{ tag: 'failover', selector: ['proxy-m'], fallbackTag: 'proxy-backup', strategy: { type: 'leastPing' } }],
	rules: [
		{ ruleTag: 'DIRECT-FIRST', type: 'field', domain: ['domain:local.example'], outboundTag: 'direct' },
		{ ruleTag: 'STREAMING', type: 'field', inboundTag: ['xray-router-stream-disabled'], outboundTag: 'proxy-stream' },
		{ ruleTag: 'DEFAULT', type: 'field', network: 'tcp,udp', balancerTag: 'failover' }
	] } });
const mapping = model.overview(mappingRaw);
assert.deepEqual(mapping.rules.map(r => [r.order, r.name, r.target, r.balancer]),
	[[1, 'DIRECT-FIRST', 'direct', false], [2, 'STREAMING', 'proxy-stream', false], [3, 'DEFAULT', 'failover', true]]);
assert.deepEqual(mapping.rules[0].conditions, ['domain: domain:local.example']);
assert.equal(mapping.rules[1].disabled, true);
assert.deepEqual(mapping.balancers[0], { tag: 'failover', strategy: 'leastPing', members: ['proxy-main'], fallback: 'proxy-backup' });
assert.deepEqual(mapping.outbounds.map(o => o.endpoint), ['192.168.80.1:50777', 'backup.example:443', 'stream.example:1080', 'Direct connection']);
assert.equal(mapping.outbounds[2].via, 'proxy-main');
assert(!JSON.stringify(mapping).includes('private-'));

function E(tag, attrs, children) {
	if (typeof attrs === 'string' || Array.isArray(attrs)) { children = attrs; attrs = {}; }
	return { tag, ...(attrs || {}), children: children || [], value: attrs && attrs.value || '', textContent: '',
		replaceChildren(...next) { this.children = next; },
		setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; } };
}
function flatten(node) {
	if (!node || typeof node !== 'object') return [];
	return [node, ...(Array.isArray(node.children) ? node.children : [node.children]).flatMap(flatten)];
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const baseOutbound = JSON.parse(model.template('socks'));
const initialLibrary = { version: 1, nodes: { 'node-main': { alias: 'host-socks', outbound: baseOutbound } },
    bindings: { 'proxy-main': 'node-main', 'proxy-backup': '', 'proxy-stream': '' } };
const configured = structuredClone(original);
configured.outbounds[0] = { ...baseOutbound, tag: 'proxy-main' };
const configuredRaw = JSON.stringify(configured);
assert.deepEqual(JSON.parse(model.build(configuredRaw, model.read(configuredRaw), initialLibrary)), configured,
    'opening and saving the imported library must preserve the runtime config');
const twoNodes = structuredClone(initialLibrary);
twoNodes.nodes['node-jp'] = model.node('jp-vps', model.template('vless', 'discard-me'), twoNodes);
assert.equal(twoNodes.nodes['node-jp'].outbound.tag, undefined);
assert.throws(() => model.node('HOST-SOCKS', model.template('socks'), twoNodes), /unique/);
assert.throws(() => model.node('bad', '[]', twoNodes), /valid/);
assert.throws(() => model.node('bad', '{"protocol":1}', twoNodes), /valid/);
twoNodes.bindings['proxy-backup'] = twoNodes.bindings['proxy-stream'] = 'node-jp';
const mapped = JSON.parse(model.build(configuredRaw, model.read(configuredRaw), twoNodes));
assert.deepEqual(mapped.routing, configured.routing);
assert.deepEqual(mapped.dns, configured.dns);
assert.deepEqual(mapped.outbounds.slice(1, 3).map(o => o.tag), ['proxy-backup', 'proxy-stream']);
assert.equal(mapped.outbounds[1].protocol, 'vless');
assert.equal(mapped.outbounds[2].streamSettings.realitySettings.password, 'REPLACE_WITH_PUBLIC_KEY');
assert.deepEqual(model.assigned(twoNodes, 'node-jp'), ['proxy-backup', 'proxy-stream']);
assert.equal(twoNodes.nodes['node-jp'].outbound.tag, undefined, 'binding must not mutate library objects');

async function testView(writable) {
    let poller, calls = [], job = { busy: false }, serial = 0, modal, inspectorLoads = 0, inspectorContext;
    const state = { config: configuredRaw, nodes: JSON.stringify(initialLibrary), settings: { LAN_INTERFACES: 'br-lan', ENABLE_CN_FASTPATH: '1', IPV6_MODE: 'block' }, revision: 'old', rollback_available: false };
    const rpc = { declare: spec => (...args) => {
        calls.push([spec.method, args]);
        return Promise.resolve(spec.method === 'get' ? state : spec.method === 'job' ? job :
            spec.method === 'start' ? (job = { busy: true, id: 'job-' + ++serial }) : { running: false, enabled: false });
    } };
    const inspector = { load() { inspectorLoads++; return Promise.resolve([]); },
        render(data, context) { inspectorContext = context; return E('div', { id: 'inspector-stub' }); } };
    const view = new Function('view', 'rpc', 'ui', 'poll', 'model', 'inspector', 'E', '_', 'L',
        fs.readFileSync(path.join(resources, 'view/xray-router.js'), 'utf8'))(
        { extend: x => x }, rpc, { addNotification() {}, showModal(title, content) { modal = content; }, hideModal() {} }, { add: (cb, interval) => { assert.equal(interval, 1); poller = cb; } }, model, inspector, E, x => x,
        { hasViewPermission: () => writable, url: path => '/cgi-bin/luci/' + path, resource: path => '/luci-static/resources/' + path });
    const tree = view.render(await view.load());
    await poller();
    const idleCalls = calls.length;
    await poller();
    assert.equal(calls.length, idleCalls, 'idle status polling is throttled');
    const nodes = () => flatten(tree);
    const button = label => nodes().find(n => n.tag === 'button' && n.children === label);
    const field = id => nodes().find(n => n.id === id);
    const panel = key => field('xray-panel-' + key);
    const modalField = id => modal.flatMap(flatten).find(n => n.id === id);
    const modalButton = label => modal.flatMap(flatten).find(n => n.tag === 'button' && n.children === label);
    const choose = (tag, id) => { const select = field('xray-bind-' + tag); select.value = id; select.change(); };
    assert.deepEqual(nodes().filter(n => n.role === 'tab').map(n => n.children), ['Routing', 'Proxy Nodes', 'Inspector']);
    assert.equal(panel('routing').hidden, false);
    assert.equal(panel('nodes').hidden, true);
    assert.equal(field('xray-bind-proxy-main').value, 'node-main');
    assert.equal(field('xray-bind-proxy-backup').value, '');
    assert.equal(button('Delete').disabled, true, 'assigned nodes cannot be deleted');
    const callsBeforeTabs = calls.length;
    button('Proxy Nodes').click();
    assert.equal(panel('nodes').hidden, false);
    button('Inspector').click(); await tick();
    assert.equal(inspectorLoads, 1);
    button('Routing').click(); button('Inspector').click();
    assert.equal(inspectorLoads, 1);
    assert.equal(calls.length, callsBeforeTabs, 'tabs must not submit configuration');
    button('Inspector').keydown({ key: 'Home', preventDefault() {} });
    assert.equal(button('Routing').focused, true);
    assert.equal(inspectorContext.isActive(), false);
    const topControls = nodes().filter(n => n.tag === 'button').map(n => n.children);
    assert(topControls.includes('Update CN IP list'));
    assert.equal(field('xray-boot').disabled, !writable);
    assert.equal(field('xray-boot').checked, false);
    assert.equal(field('xray-diagnostics').open, undefined, 'diagnostics starts collapsed');
    for (const label of ['Save & Apply', 'Start', 'Add node', 'Edit', 'Duplicate', 'Test', 'Add streaming service presets', 'Update CN IP list'])
        assert.equal(button(label).disabled, !writable, label);
    assert.equal(field('xray-bind-proxy-main').disabled, !writable);
    assert.equal(button('Logs').disabled, false);
    if (!writable) return;
    button('Add node').click(); await tick();
    modalField('xray-node-alias').value = 'jp-vps';
    modalButton('Insert VLESS REALITY template').click();
    modalButton('Use node').click();
    const jp = field('xray-bind-proxy-stream').children.find(o => o.children === 'jp-vps').value;
    choose('proxy-stream', jp); choose('proxy-backup', jp);
    assert.equal(field('xray-bind-proxy-stream').value, jp);
    const streamEnabled = field('xray-stream_enabled'), streamDomains = field('xray-stream_domains');
    streamDomains.value = 'full:custom.example'; streamDomains.input();
    button('Add streaming service presets').click(); await tick();
    streamEnabled.value = '1'; streamEnabled.input();
    const lan = field('xray-LAN_INTERFACES'); lan.value = 'br-guest'; lan.input();
    button('Proxy Nodes').click(); button('Inspector').click(); button('Routing').click();
    assert.equal(lan.value, 'br-guest');
    assert.equal(field('xray-bind-proxy-stream').value, jp);
    assert.equal(inspectorContext.isDirty(), true);
    button('Save & Apply').click(); await tick();
    const request = calls.find(c => c[0] === 'start');
    assert.equal(request[1][0], 'save');
    assert.equal(request[1][3].LAN_INTERFACES, 'br-guest');
    const saved = JSON.parse(request[1][1]), savedLibrary = JSON.parse(request[1][4]);
    assert.equal(savedLibrary.bindings['proxy-stream'], jp);
    assert.equal(savedLibrary.nodes[jp].alias, 'jp-vps');
    assert.equal(saved.outbounds.find(o => o.tag === 'proxy-stream').protocol, 'vless');
    assert.deepEqual(saved.routing.rules.find(r => r.ruleTag === 'STREAMING-PROXY').domain, streamDomains.value.split('\n'));
    assert.deepEqual(saved.dns, original.dns);
    assert.equal(button('Add node').disabled, true);
    assert.equal(field('xray-bind-proxy-main').disabled, true);
    job = { id: job.id, busy: false, code: 1, output: '<script>not executable</script>' }; await poller();
    assert.equal(lan.value, 'br-guest', 'failed save retains form edits');
    assert.equal(field('xray-bind-proxy-stream').value, jp, 'failed save retains node assignments');
    assert.equal(nodes().find(n => n.tag === 'pre').textContent, job.output);
    button('Save & Apply').click(); await tick();
    state.config = JSON.stringify(saved); state.nodes = JSON.stringify(savedLibrary);
    job = { id: job.id, busy: false, code: 0, action: 'save', output: 'saved' }; await poller();
    assert.equal(inspectorContext.isDirty(), false);
    assert.equal(field('xray-bind-proxy-stream').value, jp);
    state.settings.LAN_INTERFACES = 'br-refreshed';
    await inspectorContext.onConfigChanged();
    assert.equal(lan.value, 'br-refreshed');
    lan.value = 'br-draft'; lan.input(); await inspectorContext.onConfigChanged();
    assert.equal(lan.value, 'br-draft');
    // Rename a node without changing its stable ID or assignment.
    button('Edit').click(); await tick();
    modalField('xray-node-alias').value = 'us-vps'; modalButton('Use node').click();
    assert.equal(field('xray-bind-proxy-main').value, 'node-main');
    assert(field('xray-bind-proxy-main').children.some(o => o.children === 'us-vps'));
    // Duplicate creates a separate, unassigned node; deleting it is only a draft edit.
    button('Duplicate').click(); await tick(); modalButton('Use node').click();
    const removable = nodes().find(n => n.tag === 'button' && n.children === 'Delete' && !n.disabled);
    assert(removable); removable.click(); await tick(); modalButton('Delete node').click();
    assert(!field('xray-bind-proxy-main').children.some(o => o.children === 'us-vps-copy'));
    button('Update CN IP list').click(); await tick();
    assert.deepEqual(calls.filter(c => c[0] === 'start').at(-1)[1], ['update-cn', '', 'old', {}, '']);
    assert.equal(button('Update CN IP list').disabled, true);
    job = { id: job.id, busy: false, code: 0, action: 'update-cn', output: 'installed 8000 CN IPv4 prefixes' };
    await poller();
    assert.equal(button('Update CN IP list').disabled, false);
    assert.equal(nodes().find(n => n.tag === 'pre').textContent, job.output);
    assert.equal(lan.value, 'br-draft', 'CN update must retain unsaved settings');
    assert(field('xray-bind-proxy-main').children.some(o => o.children === 'us-vps'), 'CN update must retain unsaved node edits');
    button('Test').click(); await tick();
    const testRequest = calls.filter(c => c[0] === 'start').at(-1)[1];
    assert.equal(testRequest[0], 'test-node');
    assert.deepEqual(JSON.parse(testRequest[1]), baseOutbound);
    assert.equal(field('xray-node-test-node-main').children, 'Testing…');
    assert.equal(button('Test').disabled, true);
    const currentTestId = job.id;
    job = { busy: false, id: 'previous-test', code: 1, action: 'test-node', output: 'stale failure' };
    await poller();
    assert.equal(button('Test').disabled, true, 'stale results cannot complete the current test');
    assert.equal(field('xray-node-test-node-main').children, 'Testing…');
    job = { id: currentTestId, busy: false, code: 0, action: 'test-node', output: 'Connected · 123 ms (HTTPS 204)',
        node_test: { success: true, message: 'Connected · 123 ms (HTTPS 204)', latency_ms: 123 } };
    await poller();
    assert.equal(field('xray-node-test-node-main').children, 'Connected · 123 ms');
    assert.equal(field('xray-node-test-node-main').title, job.node_test.message);
    assert.equal(field('xray-diagnostics').open, true, 'operation output opens diagnostics');
    assert.equal(button('Test').disabled, false);
    assert.equal(lan.value, 'br-draft', 'node test retains unsaved settings');
    button('Edit').click(); await tick();
    const editedOutbound = structuredClone(baseOutbound);
    editedOutbound.settings = { address: '192.0.2.99', port: 9999 };
    modalField('xray-node-json').value = JSON.stringify(editedOutbound); modalButton('Use node').click();
    assert.equal(field('xray-node-test-node-main').children, 'Not tested', 'edited node must not show stale success');
    button('Test').click(); await tick();
    assert.deepEqual(JSON.parse(calls.filter(c => c[0] === 'start').at(-1)[1][1]), editedOutbound, 'test sends unsaved node');
    job = { id: job.id, busy: false, code: 1, action: 'test-node', output: 'Connection refused', node_test: { success: false, message: 'Connection refused' } };
    await poller();
    assert.equal(field('xray-node-test-node-main').children, 'Failed');
    assert.equal(field('xray-node-test-node-main').title, 'Failed: Connection refused');
    assert.equal(lan.value, 'br-draft');
    field('xray-boot').checked = true; field('xray-boot').change(); await tick();
    assert.equal(calls.filter(c => c[0] === 'start').at(-1)[1][0], 'enable');
    assert.equal(field('xray-boot').disabled, true);
    job = { id: job.id, busy: false, code: 0, action: 'enable', output: 'enabled' }; await poller();
    field('xray-boot').checked = false; field('xray-boot').change(); await tick();
    assert.equal(calls.filter(c => c[0] === 'start').at(-1)[1][0], 'disable');
}
Promise.all([testView(true), testView(false)]).then(() => console.log('LuCI model, node library, assignments, drafts, RPC flow and permissions tests passed'))
    .catch(err => { console.error(err); process.exitCode = 1; });
