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
	let poller, calls = [], job = { busy: false };
	const state = { config: raw, settings: { LAN_INTERFACES: 'br-lan', ENABLE_CN_FASTPATH: '1', IPV6_MODE: 'block' }, revision: 'old', rollback_available: false };
	const rpc = { declare: spec => (...args) => {
		calls.push([spec.method, args]);
		return Promise.resolve(spec.method === 'get' ? state : spec.method === 'job' ? job :
			spec.method === 'start' ? (job = { busy: true }) : { running: false, enabled: false });
	} };
	const view = new Function('view', 'rpc', 'ui', 'poll', 'model', 'E', '_', 'L',
		fs.readFileSync(path.join(resources, 'view/xray-router.js'), 'utf8'))(
		{ extend: x => x }, rpc, { addNotification() {} }, { add: cb => { poller = cb; } }, model, E, x => x,
		{ hasViewPermission: () => writable });
	const tree = view.render(await view.load());
	const nodes = flatten(tree);
	const button = label => nodes.find(n => n.tag === 'button' && n.children === label);
	const lan = nodes.find(n => n.id === 'xray-LAN_INTERFACES');
	assert.equal(button('Save & Apply').disabled, !writable);
	assert.equal(button('Start').disabled, !writable);
	assert.equal(button('Logs').disabled, false);
	if (!writable) return;
	lan.value = 'br-guest'; lan.input();
	button('Save & Apply').click();
	await new Promise(resolve => setImmediate(resolve));
	const request = calls.find(c => c[0] === 'start');
	assert.equal(request[1][0], 'save');
	assert.equal(request[1][3].LAN_INTERFACES, 'br-guest');
	assert.equal(button('Start').disabled, true);
	job = { busy: false, code: 1, output: '<script>not executable</script>' };
	await poller();
	assert.equal(lan.value, 'br-guest', 'failed save must retain user edits');
	assert.equal(button('Start').disabled, false);
	assert.equal(nodes.find(n => n.tag === 'pre').textContent, job.output);
}
Promise.all([testView(true), testView(false)]).then(() => console.log('LuCI model, RPC flow and read-only UI tests passed'))
	.catch(err => { console.error(err); process.exitCode = 1; });
