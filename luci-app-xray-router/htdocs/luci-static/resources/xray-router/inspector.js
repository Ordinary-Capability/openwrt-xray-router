'use strict';
'require baseclass';
'require rpc';
'require ui';
'require poll';

var options = rpc.declare({ object: 'luci.xray-inspector', method: 'options' });
var getCapture = rpc.declare({ object: 'luci.xray-inspector', method: 'get' });
var capture = rpc.declare({ object: 'luci.xray-inspector', method: 'capture', params: ['device', 'duration', 'expected'] });
var stop = rpc.declare({ object: 'luci.xray-inspector', method: 'stop', params: ['id'] });
var getConfig = rpc.declare({ object: 'luci.xray-router', method: 'get' });
var getJob = rpc.declare({ object: 'luci.xray-router', method: 'job' });
var startJob = rpc.declare({ object: 'luci.xray-router', method: 'start', params: ['action', 'config', 'revision', 'settings'] });
function checked(value) {
	if (!value || value.error) throw new Error(value && value.error || _('Empty response from inspector'));
	return value;
}
function list(value) { return Array.isArray(value) ? value : []; }
function time(value) { return value ? new Date(value * 1000).toLocaleTimeString() : ''; }

return baseclass.extend({
	load: function() { return Promise.all([options(), getJob()]); },
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
	render: function(data, context) {
		context = context || {};
		var info = checked(data[0]);
		var current = info.capture || {};
		var jobBusy = !!checked(data[1]).busy;
		var pending = false, ownLogging = false;
		var nextPollAt = 0, activeLogJob = null, submittingLog = false;
		var writable = L.hasViewPermission();
		var status = E('p', { 'class': 'xr-capture-status', 'aria-live': 'polite' });
		var warnings = E('div', { 'aria-live': 'polite' });
		var logStatus = E('p', { 'class': 'xr-muted' });
		var logNotices = E('div', { 'class': 'xr-muted' });
		var resultBody = E('tbody');
		var count = E('p', { 'class': 'xr-connection-count', 'aria-live': 'polite' });
		var controls = [];
		function error(err) { ui.addNotification(null, E('p', {}, err.message || String(err)), 'error'); }
		function button(label, fn, kind) {
			var node = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-action' + (kind === 'start' ? ' xr-primary' : ''),
				'click': function() { Promise.resolve().then(fn).catch(error); } }, label);
			controls.push({ node: node, kind: kind });
			return node;
		}
		var device = E('input', { 'id': 'inspect-device', 'type': 'text', 'placeholder': '192.168.1.100',
			'list': 'inspect-devices', 'autocomplete': 'off', 'class': 'cbi-input-text' });
		device.value = current.device || '';
		var deviceList = E('datalist', { 'id': 'inspect-devices' }, list(info.devices).map(function(entry) {
			return E('option', { 'value': entry.ip }, entry.name + ' (' + entry.ip + ')');
		}));
		var duration = E('select', { 'id': 'inspect-duration', 'class': 'cbi-input-select' }, [30, 60, 120].map(function(n) {
			return E('option', { 'value': String(n) }, n + ' ' + _('seconds'));
		}));
		duration.value = String(current.duration || 60);
		var expected = E('select', { 'id': 'inspect-expected', 'class': 'cbi-input-select' }, [
			['any', _('Any path')], ['direct', _('Direct')], ['proxy', _('Normal proxy (primary or backup)')],
			['proxy-stream', _('Streaming')], ['proxy-main', _('Primary only')], ['proxy-backup', _('Backup only')]
		].map(function(item) { return E('option', { 'value': item[0] }, item[1]); }));
		expected.value = current.expected || 'any';
		var search = E('input', { 'id': 'inspect-filter', 'type': 'search', 'placeholder': _('Filter domain, IP, path or rule'),
			'class': 'cbi-input-text', 'input': function() { drawRows(); } });
		var problems = E('input', { 'id': 'inspect-problems', 'type': 'checkbox', 'change': function() { drawRows(); } });
		function details(row) {
			var content = [E('p', {}, _('A selected route does not prove the connection succeeded. DNS associations are candidates; encrypted or cached DNS may leave names unknown.')),
				E('pre', { 'style': 'white-space:pre-wrap;max-height:55vh;overflow:auto' }, JSON.stringify(row, null, 2))];
			if (row.domain && /^[a-zA-Z0-9_.-]+$/.test(row.domain)) {
				content.push(E('p', {}, _('To adjust this hostname, copy the exact-domain entry into the desired routing list, review its priority, then Save & Apply:')),
					E('input', { 'type': 'text', 'readonly': '', 'value': 'full:' + row.domain, 'class': 'cbi-input-text' }));
			}
			content.push(E('div', { 'class': 'right' }, E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Close'))));
			ui.showModal(_('Connection evidence'), content);
		}
		function drawRows() {
			var all = list(current.rows);
			var query = (search.value || '').toLowerCase();
			var rows = all.filter(function(row) {
				return (!problems.checked || row.mismatch || row.error || row.outcome === 'Rejected') &&
					(!query || [row.domain, row.destination, row.path, row.rule, row.kernel, row.error].concat(list(row.dns_candidates)).join(' ').toLowerCase().indexOf(query) >= 0);
			});
			var nodes = rows.map(function(row) {
				var names = row.domain ? row.domain + ' (' + row.domain_evidence + ')' :
					list(row.dns_candidates).length ? list(row.dns_candidates).join(', ') + ' (' + _('DNS association') + ')' : _('Unknown');
				return E('tr', { 'class': row.mismatch || row.error ? 'alert-message warning' : '' }, [
					E('td', {}, time(row.last)), E('td', {}, row.network + ' / ' + row.source_port),
					E('td', {}, row.destination + ':' + row.port), E('td', {}, names),
					E('td', {}, row.path + (row.mismatch ? ' — ' + _('Unexpected') : '')),
					E('td', {}, [row.rule, row.kernel].filter(Boolean).join(' / ') || _('Unknown')),
					E('td', {}, row.outcome),
					E('td', {}, E('button', { 'type': 'button', 'class': 'cbi-button', 'click': function() { details(row); } }, _('Details')))
				]);
			});
			if (!nodes.length) nodes.push(E('tr', {}, E('td', { 'colspan': '8' }, _('No matching connections. Reopen the app to create new connections.'))));
			resultBody.replaceChildren.apply(resultBody, nodes);
			count.textContent = rows.length + ' / ' + all.length + ' ' + _('connections') +
				' · ' + all.filter(function(row) { return row.mismatch; }).length + ' ' + _('unexpected paths') +
				' · ' + list(current.dns_queries).length + ' ' + _('observed DNS queries') +
				(current.dropped ? ' · ' + _('Capture limit reached; some records omitted') : '');
		}
		function update() {
			var active = !!current.active;
			device.disabled = duration.disabled = expected.disabled = !writable || active || pending || jobBusy;
			controls.forEach(function(item) {
				item.node.disabled = item.kind === 'download' ? !current.id :
					!writable || pending || jobBusy || (item.kind === 'stop' ? !current.id : active);
			});
			status.textContent = current.id ? (active ? _('Capturing') : current.interrupted ? _('Capture interrupted') : _('Capture finished')) +
				' · ' + current.device + ' · ' + _('Expected: ') + current.expected + ' · ' + time(current.started) +
				(active ? ' – ' + time(current.expires) : ' – ' + time(current.finished)) : _('Ready. Starting a capture does not restart Xray.');
			warnings.replaceChildren.apply(warnings, list(current.warnings).map(function(text) { return E('p', { 'class': 'alert-message warning' }, text); }));
			logStatus.textContent = _('Saved log level: ') + info.loglevel + (jobBusy ? ' · ' + _('Management operation in progress') : '');
			logNotices.replaceChildren.apply(logNotices, list(info.notices).map(function(text) { return E('p', {}, text); }));
			drawRows();
		}
		function run(action) {
			pending = true; update();
			return action().then(checked).then(function(next) { current = next; })
				.finally(function() { pending = false; update(); });
		}
		function logging(level) {
			if (context.isDirty && context.isDirty()) throw new Error(_('Save or reload your Routing and Proxy Nodes edits before changing logging.'));
			ui.showModal(_('Change logging and restart Xray'), [
				E('p', {}, _('This changes the saved log level and restarts Xray if it is running. Active proxied connections will be interrupted. A stopped service stays stopped.')),
				E('p', {}, level === 'info' ? _('Info logging stays enabled until you explicitly restore warning logging. Capture never switches levels automatically.') : _('Restore warning logging and reduce ongoing log volume.')),
				E('div', { 'class': 'right' }, [E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
					E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() {
						ui.hideModal();
						if (context.isDirty && context.isDirty()) { error(new Error(_('Save or reload your Routing and Proxy Nodes edits before changing logging.'))); return; }
						jobBusy = true; ownLogging = true; submittingLog = true; activeLogJob = null; nextPollAt = 0; update();
						getConfig().then(checked).then(function(config) { return startJob('logging-' + level, '', config.revision, {}); }).then(checked)
							.then(function(job) {
								activeLogJob = job.id; submittingLog = false;
								if (context.onJobStarted) context.onJobStarted(job);
							})
							.catch(function(err) { jobBusy = false; ownLogging = false; submittingLog = false; update(); error(err); });
					} }, _('Apply log level and restart'))])
			]);
		}
		var root = E('div', { 'class': context.embedded ? 'xr-inspector' : 'cbi-map xr-app xr-inspector' }, [
			context.embedded ? '' : E('link', { 'rel': 'stylesheet', 'href': L.resource('xray-router/style.css') + '?v=3' }),
			context.embedded ? '' : E('h2', {}, _('Xray Traffic Inspector')),
			E('section', { 'class': 'xr-card' }, [E('div', { 'class': 'xr-section-head' }, E('div', {}, [E('h3', {}, _('Capture traffic')),
				E('p', { 'class': 'xr-muted' }, _('Choose a device, start capture, then reopen the affected app.'))])),
				E('div', { 'class': 'xr-capture-controls' }, [
				E('div', { 'class': 'xr-control' }, [E('label', { 'for': 'inspect-device' }, _('LAN device IPv4')), device, deviceList]),
				E('div', { 'class': 'xr-control' }, [E('label', { 'for': 'inspect-duration' }, _('Duration')), duration]),
				E('div', { 'class': 'xr-control' }, [E('label', { 'for': 'inspect-expected' }, _('Expected path')), expected]),
				E('div', { 'class': 'xr-actions' }, [button(_('Start capture'), function() {
					return run(function() { return capture(device.value.trim(), Number(duration.value), expected.value); });
				}, 'start'), ' ', button(_('Stop / clean up'), function() { return run(function() { return stop(current.id); }); }, 'stop'), ' ',
				button(_('Download report'), function() {
					var url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
					var link = document.createElement('a'); link.href = url; link.download = 'xray-capture-' + current.device + '.json';
					link.click(); setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
				}, 'download')])]), status, warnings,
				E('details', { 'class': 'xr-help' }, [E('summary', {}, _('Capture limitations')), E('p', {}, _('Capture does not restart Xray or change routing. It samples new IPv4 TCP/UDP packets; existing or offloaded sessions may not appear.'))])]),
			E('section', { 'class': 'xr-card' }, [E('h3', {}, _('Connections')),
				E('div', { 'class': 'xr-filterbar' }, [search, E('label', {}, [problems, ' ', _('Only unexpected paths or errors')])]), count,
				E('div', { 'class': 'xr-table-wrap' }, E('table', { 'class': 'table' }, [
					E('thead', {}, E('tr', {}, [_('Time'), _('Protocol / source port'), _('Destination'), _('Hostname evidence'), _('Actual path'), _('Rule / kernel decision'), _('Result'), ''].map(function(label) { return E('th', {}, label); }))), resultBody
				]))]),
			E('section', { 'class': 'xr-card' }, [E('h3', {}, _('Logging settings (may restart Xray)')), logStatus, logNotices,
				E('div', { 'class': 'xr-actions xr-log-actions' }, [
				button(_('Enable info logging…'), function() { logging('info'); }, 'logging'), ' ',
				button(_('Restore warning logging…'), function() { logging('warning'); }, 'logging')]),
				E('details', { 'class': 'xr-help' }, [E('summary', {}, _('About logging')), E('p', {}, _('Logs use the existing destinations. The default system log is a bounded RAM ring. DNS associations require dnsmasq query logging to already be enabled; the inspector does not enable it.'))])]),
			context.embedded ? '' : E('p', {}, E('a', { 'href': L.url('admin/services/xray-router') }, _('Open Xray Router settings')))
		]);
		update();
		poll.add(function() {
			if (context.isActive && !context.isActive() && !current.active && !ownLogging && !pending) return Promise.resolve();
			if (!current.active && !jobBusy && !pending && Date.now() < nextPollAt) return Promise.resolve();
			nextPollAt = Date.now() + 5000;
			return Promise.all([getCapture(), getJob()]).then(function(values) {
				current = checked(values[0]); var job = checked(values[1]);
				if (submittingLog || (activeLogJob && job.id !== activeLogJob)) return;
				jobBusy = !!job.busy;
				if (ownLogging && !jobBusy) {
					ownLogging = false; activeLogJob = null;
					ui.addNotification(null, E('p', {}, job.output || _('Logging operation finished')), job.code ? 'error' : 'info');
					return options().then(checked).then(function(next) {
						info = next; update();
						if (context.onConfigChanged) return context.onConfigChanged();
					});
				}
				update();
			}).catch(function(err) { status.textContent = _('Inspector unavailable: ') + (err.message || err); });
		}, 1);
		return root;
	}
});
