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
multiInbound.inbounds.push({ tag: 'socks-in', protocol: 'socks', port: 10808 },
	{ tag: 'http-in', protocol: 'http', port: 10809 });
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

function E(tag, attrs, children) {
	if (typeof attrs === 'string' || Array.isArray(attrs)) { children = attrs; attrs = {}; }
	return { tag, ...(attrs || {}), children: children || [], value: '', textContent: '' };
}
function flatten(node) {
	if (!node || typeof node !== 'object') return [];
	return [node, ...(Array.isArray(node.children) ? node.children.flatMap(flatten) : [])];
}
async function testView(writable) {
	let poller, calls = [], job = { busy: false }, modal;
	const state = { config: raw, settings: { LAN_INTERFACES: 'br-lan', ENABLE_CN_FASTPATH: '1', IPV6_MODE: 'block' }, revision: 'old', rollback_available: false };
	const rpc = { declare: spec => (...args) => {
		calls.push([spec.method, args]);
		return Promise.resolve(spec.method === 'get' ? state : spec.method === 'job' ? job :
			spec.method === 'start' ? (job = { busy: true }) : { running: false, enabled: false });
	} };
	const view = new Function('view', 'rpc', 'ui', 'poll', 'model', 'E', '_', 'L',
		fs.readFileSync(path.join(resources, 'view/xray-router.js'), 'utf8'))(
		{ extend: x => x }, rpc, { addNotification() {}, showModal(title, content) { modal = content; }, hideModal() {} }, { add: cb => { poller = cb; } }, model, E, x => x,
		{ hasViewPermission: () => writable });
	const tree = view.render(await view.load());
	const nodes = flatten(tree);
	const button = label => nodes.find(n => n.tag === 'button' && n.children === label);
	const lan = nodes.find(n => n.id === 'xray-LAN_INTERFACES');
	const streamNode = nodes.find(n => n.id === 'xray-stream');
	const streamEnabled = nodes.find(n => n.id === 'xray-stream_enabled');
	const streamDomains = nodes.find(n => n.id === 'xray-stream_domains');
	assert.equal(button('Save & Apply').disabled, !writable);
	assert.equal(button('Start').disabled, !writable);
	assert.equal(button('Logs').disabled, false);
	assert.equal(button('Add streaming service presets').disabled, !writable);
	for (const field of [streamNode, streamEnabled, streamDomains]) assert.equal(field.disabled, !writable);
	if (!writable) return;
	// Apply the VLESS template in the streaming section, without touching primary/backup.
	const streamSection = nodes.find(n => n.tag === 'section' && flatten(n).includes(streamNode));
	flatten(streamSection).find(n => n.children === 'VLESS REALITY template').click();
	await new Promise(resolve => setImmediate(resolve));
	modal.flatMap(flatten).find(n => n.children === 'Use template').click();
	assert.equal(JSON.parse(streamNode.value).tag, 'proxy-stream');
	assert.equal(JSON.parse(streamNode.value).streamSettings.security, 'reality');
	streamDomains.value = 'full:custom.example'; streamDomains.input();
	button('Add streaming service presets').click();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(streamDomains.value, model.streamingPreset('full:custom.example'));
	streamEnabled.value = '1'; streamEnabled.input();
	lan.value = 'br-guest'; lan.input();
	button('Save & Apply').click();
	await new Promise(resolve => setImmediate(resolve));
	const request = calls.find(c => c[0] === 'start');
	assert.equal(request[1][0], 'save');
	assert.equal(request[1][3].LAN_INTERFACES, 'br-guest');
	const saved = JSON.parse(request[1][1]);
	assert.equal(saved.outbounds.find(o => o.tag === 'proxy-stream').protocol, 'vless');
	assert.deepEqual(saved.routing.rules.find(r => r.ruleTag === 'STREAMING-PROXY').domain,
		streamDomains.value.split('\n'));
	assert.deepEqual(saved.dns, original.dns);
	assert.equal(button('Start').disabled, true);
	assert.equal(button('Add streaming service presets').disabled, true);
	assert.equal(streamNode.disabled, true);
	job = { busy: false, code: 1, output: '<script>not executable</script>' };
	await poller();
	assert.equal(lan.value, 'br-guest', 'failed save must retain user edits');
	assert.equal(streamEnabled.value, '1');
	assert.equal(JSON.parse(streamNode.value).protocol, 'vless');
	assert.equal(streamDomains.value, model.streamingPreset('full:custom.example'));
	assert.equal(button('Start').disabled, false);
	assert.equal(nodes.find(n => n.tag === 'pre').textContent, job.output);
	// Successful save refreshes all streaming fields from the saved configuration.
	button('Save & Apply').click();
	await new Promise(resolve => setImmediate(resolve));
	state.config = saved && JSON.stringify(saved);
	job = { busy: false, code: 0, action: 'save', output: 'saved' };
	await poller();
	assert.equal(streamEnabled.value, '1');
	assert.equal(streamNode.disabled, false);
}
Promise.all([testView(true), testView(false)]).then(() => console.log('LuCI model, RPC flow and read-only UI tests passed'))
	.catch(err => { console.error(err); process.exitCode = 1; });
