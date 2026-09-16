'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'luci-app-xray-router/htdocs/luci-static/resources/view/xray-router-inspector.js'), 'utf8');
function E(tag, attrs, children) {
	if (typeof attrs === 'string' || Array.isArray(attrs)) { children = attrs; attrs = {}; }
	return { tag, ...(attrs || {}), children: children || [], value: '', textContent: '',
		replaceChildren(...next) { this.children = next; } };
}
function flatten(node) {
	if (!node || typeof node !== 'object') return [];
	return [node, ...(Array.isArray(node.children) ? node.children : [node.children]).flatMap(flatten)];
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function test(writable) {
	let current = { rows: {} }, job = { busy: false }, poller, modal;
	const calls = [], notices = [];
	const rpc = { declare: spec => (...args) => {
		calls.push({ ...spec, args });
		if (spec.object === 'luci.xray-inspector') {
			if (spec.method === 'options') return Promise.resolve({ devices: [{ ip: '192.168.1.100', name: 'TV' }], loglevel: 'warning', notices: [], capture: current });
			if (spec.method === 'capture') current = { id: '42-1', active: true, device: args[0], duration: args[1], expected: args[2], started: 100, expires: 160, rows: [] };
			if (spec.method === 'stop') current = { ...current, active: false, finished: 120 };
			return Promise.resolve(current);
		}
		if (spec.method === 'get') return Promise.resolve({ revision: 'revision1' });
		if (spec.method === 'start') job = { busy: true };
		return Promise.resolve(job);
	} };
	const view = new Function('view', 'rpc', 'ui', 'poll', 'E', '_', 'L', source)(
		{ extend: value => value }, rpc,
		{ showModal(title, content) { modal = { title, content }; }, hideModal() {}, addNotification(_, node) { notices.push(node); } },
		{ add: callback => { poller = callback; } }, E, text => text,
		{ hasViewPermission: () => writable, url: path => '/cgi-bin/luci/' + path });
	const tree = view.render(await view.load());
	const nodes = () => flatten(tree);
	const button = text => nodes().find(node => node.tag === 'button' && node.children === text);
	const field = id => nodes().find(node => node.id === id);
	assert.equal(button('Start capture').disabled, !writable);
	assert.equal(button('Enable info logging…').disabled, !writable);
	assert.equal(field('inspect-device').disabled, !writable);
	assert.equal(button('Download report').disabled, true);
	if (!writable) return;
	field('inspect-device').value = '192.168.1.100';
	field('inspect-expected').value = 'proxy-stream';
	button('Start capture').click(); await tick();
	const call = calls.find(call => call.method === 'capture');
	assert.deepEqual(call.args, ['192.168.1.100', 60, 'proxy-stream']);
	assert.equal(button('Start capture').disabled, true);
	assert.equal(button('Enable info logging…').disabled, true);
	assert.equal(button('Stop / clean up').disabled, false);
	current.rows = [{ id: 1, source: '192.168.1.100', source_port: 50000, destination: '8.8.8.8', port: 443,
		network: 'tcp', domain: '<script>unsafe</script>', domain_evidence: 'sniffed', path: 'proxy-main',
		rule: 'DEFAULT-PROXY', mismatch: true, outcome: 'Selected; outcome unknown', last: 101, evidence: [] },
		{ id: 2, source_port: 50001, destination: '1.1.1.1', port: 443, network: 'udp', path: 'unknown', outcome: 'Not established' }];
	await poller();
	assert.equal(nodes().filter(node => node.tag === 'button' && node.children === 'Details').length, 2);
	assert(nodes().some(node => node.tag === 'td' && String(node.children).includes('<script>unsafe</script>')));
	assert(!nodes().some(node => node.tag === 'script'), 'untrusted evidence must remain text');
	field('inspect-problems').checked = true; field('inspect-problems').change();
	assert.equal(nodes().filter(node => node.tag === 'button' && node.children === 'Details').length, 1);
	button('Stop / clean up').click(); await tick();
	assert.equal(button('Start capture').disabled, false);
	assert(!calls.some(call => call.object === 'luci.xray-router' && call.method === 'start'), 'capture/stop must never restart Xray');
	button('Enable info logging…').click(); await tick();
	assert.equal(modal.title, 'Change logging and restart Xray');
	assert(!calls.some(call => call.object === 'luci.xray-router' && call.method === 'start'), 'opening confirmation must not change logging');
	modal.content.flatMap(flatten).find(node => node.children === 'Apply log level and restart').click(); await tick();
	assert.equal(calls.find(call => call.object === 'luci.xray-router' && call.method === 'start').args[0], 'logging-info');
	assert.equal(button('Start capture').disabled, true);
	job = { busy: false, code: 0, output: 'Logging changed and service restarted.' };
	await poller();
	assert.equal(button('Start capture').disabled, false);
	assert.equal(notices.length, 1);
}
Promise.all([test(true), test(false)]).then(() => console.log('Inspector UI capture, filtering, permissions and restart-confirmation tests passed'))
	.catch(error => { console.error(error); process.exitCode = 1; });
