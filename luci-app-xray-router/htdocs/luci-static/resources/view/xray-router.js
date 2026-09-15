'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require xray-router.model as model';

var getConfig = rpc.declare({ object: 'luci.xray-router', method: 'get' });
var getStatus = rpc.declare({ object: 'luci.xray-router', method: 'status' });
var getJob = rpc.declare({ object: 'luci.xray-router', method: 'job' });
var getDiagnostics = rpc.declare({ object: 'luci.xray-router', method: 'diagnostics', params: ['action'] });
var startJob = rpc.declare({ object: 'luci.xray-router', method: 'start', params: ['action', 'config', 'revision', 'settings'] });
function checked(response) {
	if (!response || response.error) throw new Error(response && response.error || _('Empty response from service'));
	return response;
}

return view.extend({
	load: function() { return Promise.all([getConfig(), getStatus(), getJob()]); },
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
	render: function(data) {
		var state = checked(data[0]);
		var fields = {};
		var dirty = false;
		var busy = !!checked(data[2]).busy;
		var ownAction = null;
		var canWrite = L.hasViewPermission();
		var buttons = [];
		var output = E('pre', { 'style': 'white-space:pre-wrap;max-height:28em;overflow:auto', 'aria-live': 'polite' }, _('Ready.'));
		var status = E('p', { 'aria-live': 'polite' });
		var notice = E('p', { 'class': 'alert-message warning', 'hidden': state.recovery_required ? null : '' },
			_('An earlier apply was interrupted. Restore the previous configuration before making further changes.'));
		var pending = E('p', { 'aria-live': 'polite' });
		function error(err) { output.textContent = err.message || String(err); ui.addNotification(null, E('p', {}, [output.textContent]), 'error'); }
		function updateButtons() {
			buttons.forEach(function(item) { item.node.disabled = busy || (item.write && !canWrite); });
			Object.keys(fields).forEach(function(key) { fields[key].disabled = busy || !canWrite; });
			pending.textContent = busy ? _('Operation in progress…') : dirty ? _('Unsaved changes') : '';
		}
		function button(label, callback, write) {
			var node = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button',
				'click': function() { Promise.resolve().then(callback).catch(error); } }, label);
			buttons.push({ node: node, write: write !== false });
			return node;
		}
		function field(key, label, value, help, kind) {
			var attrs = { 'id': 'xray-' + key, 'class': 'cbi-input-text', 'style': 'width:100%',
				'input': function() { dirty = true; updateButtons(); }, 'autocomplete': 'off', 'spellcheck': 'false' };
			var node;
			if (Array.isArray(kind)) {
				node = E('select', attrs, kind.map(function(pair) { return E('option', { 'value': pair[0] }, pair[1]); }));
			} else if (kind === 'textarea') {
				attrs.rows = key === 'primary' || key === 'backup' || key === 'stream' ? 16 : 5;
				node = E('textarea', attrs);
			} else { attrs.type = kind || 'text'; node = E('input', attrs); }
			node.value = value == null ? '' : value;
			fields[key] = node;
			return E('div', { 'class': 'cbi-value' }, [E('label', { 'class': 'cbi-value-title', 'for': attrs.id }, label),
				E('div', { 'class': 'cbi-value-field' }, [node, E('div', { 'class': 'cbi-value-description' }, help || '')])]);
		}
		function populate(next) {
			state = checked(next);
			var values = model.read(state.config);
			Object.keys(values).forEach(function(key) { fields[key].value = values[key]; });
			Object.keys(state.settings).forEach(function(key) { if (fields[key]) fields[key].value = state.settings[key]; });
			dirty = false;
			notice.hidden = !state.recovery_required;
			updateButtons();
		}
		function showStatus(next) {
			next = checked(next);
			status.textContent = (next.running ? _('Service: running') : _('Service: stopped')) + ' · ' +
				(next.enabled ? _('Boot startup: enabled') : _('Boot startup: disabled'));
		}
		function launch(action, config, settings) {
			ownAction = action;
			busy = true; updateButtons(); output.textContent = _('Starting operation…');
			return startJob(action, config || '', state.revision, settings || {}).then(checked).catch(function(err) {
				busy = false; ownAction = null; updateButtons(); throw err;
			});
		}
		function confirmAction(title, message, action) {
			ui.showModal(title, [E('p', {}, message), E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() { ui.hideModal(); launch(action).catch(error); } }, title)
			])]);
		}
		var values = model.read(state.config);
		function outbound(key, title, tag, extra) {
			return E('section', { 'class': 'cbi-section' }, [E('h3', {}, title),
				extra || '',
				E('p', {}, _('Paste an Xray outbound object or start from a template. Replace example addresses and credentials. Advanced transport fields are preserved.')),
				field(key, _('Outbound JSON'), values[key], _('The outbound tag is kept automatically. Credentials are visible to users with access to this page.'), 'textarea'),
				E('div', { 'class': 'cbi-page-actions' }, ['socks', 'vless', 'blackhole'].map(function(protocol) {
					return button(protocol === 'socks' ? _('SOCKS5 template') : protocol === 'vless' ? _('VLESS REALITY template') : _('Blackhole placeholder'), function() {
						ui.showModal(_('Replace outbound'), [E('p', {}, _('Replace this editor with a template? This only changes the unsaved form.')),
							E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
							E('button', { 'class': 'cbi-button cbi-button-positive', 'click': function() {
								fields[key].value = model.template(protocol, tag); dirty = true; updateButtons(); ui.hideModal();
							} }, _('Use template'))]);
					});
				}))]);
		}
		var root = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Xray Router')), notice, status,
			E('div', { 'class': 'cbi-section' }, [
				button(_('Start'), function() { return launch('start'); }), ' ',
				button(_('Stop'), function() { confirmAction(_('Stop service'), _('Restore the saved dnsmasq configuration and disable transparent interception?'), 'stop'); }), ' ',
				button(_('Restart'), function() { return launch('restart'); }), ' ',
				button(_('Enable at boot'), function() { return launch('enable'); }), ' ',
				button(_('Disable at boot'), function() { return launch('disable'); }),
				E('p', {}, _('Service controls use the saved configuration. Unsaved form edits are applied only by Save & Apply.'))]),
			outbound('primary', _('Primary outbound'), 'proxy-main'),
			outbound('backup', _('Backup outbound'), 'proxy-backup'),
			outbound('stream', _('Streaming outbound'), 'proxy-stream', E('div', {}, [
				field('stream_enabled', _('Streaming routing'), values.stream_enabled,
					_('Disabling keeps the node and domain list for later use.'), [['0', _('Disabled')], ['1', _('Enabled')]]),
				field('stream_domains', _('Streaming domains'), values.stream_domains,
					_('One domain per line. Supports domain:, full:, and geosite: groups. Bare domains include subdomains.'), 'textarea'),
				button(_('Add streaming service presets'), function() {
					fields.stream_domains.value = model.streamingPreset(fields.stream_domains.value);
					dirty = true; updateButtons();
				}),
				E('p', {}, _('Adds Netflix, Prime Video, HBO/Max, and Disney+ while keeping custom entries. Remove a group to exclude that service. The installed GeoSite database must contain the selected groups.')),
				E('p', {}, _('Matching connections use this node without fallback. Force-direct rules take priority. Disable CN IPv4 fast path below if CN destinations must use this node too.')),
				E('p', {}, _('Global DNS still uses the primary node. A streaming node in a different region may need matching DNS routing.'))
			])),
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Health checks')),
				field('probe_url', _('Probe URL'), values.probe_url, _('Use a reliable HTTP(S) endpoint reachable through the primary.')),
				field('probe_interval', _('Probe interval (seconds)'), values.probe_interval, _('1–3600 seconds. Switching affects new connections after a health check completes.'), 'number'),
				E('p', {}, _('Client traffic uses the backup while the primary is unhealthy and returns when it recovers. Global DNS continues to use the primary.'))]),
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Routing')),
				field('LAN_INTERFACES', _('LAN interfaces'), state.settings.LAN_INTERFACES, _('Space-separated device names, for example br-lan br-guest.')),
				field('ENABLE_CN_FASTPATH', _('CN IPv4 fast path'), state.settings.ENABLE_CN_FASTPATH, _('When enabled, CN IPs bypass Xray before force-proxy domain rules.'), [['1', _('Enabled')], ['0', _('Disabled')]]),
				field('IPV6_MODE', _('Global IPv6'), state.settings.IPV6_MODE, '', [['block', _('Block')], ['bypass', _('Bypass proxy')]]),
				field('direct', _('Force-direct domains'), values.direct, _('One domain per line. Xray prefixes such as domain: and full: are accepted.'), 'textarea'),
				field('proxy', _('Force-proxy domains'), values.proxy, _('Leave blank to use an inert .invalid placeholder.'), 'textarea')]),
			E('div', { 'class': 'cbi-page-actions' }, [pending,
				button(_('Save & Apply'), function() {
					var entries = {}; Object.keys(fields).forEach(function(key) { entries[key] = fields[key].value; });
					var config = model.build(state.config, entries);
					return launch('save', config, { LAN_INTERFACES: entries.LAN_INTERFACES,
						ENABLE_CN_FASTPATH: entries.ENABLE_CN_FASTPATH, IPV6_MODE: entries.IPV6_MODE });
				}), ' ', button(_('Reload saved configuration'), function() {
					if (!dirty) return getConfig().then(populate);
					ui.showModal(_('Discard unsaved changes'), [E('p', {}, _('Reload the saved configuration and discard form edits?')),
						E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
						E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() { ui.hideModal(); getConfig().then(populate).catch(error); } }, _('Reload'))]);
				}, false), ' ', button(_('Restore previous configuration'), function() {
					if (!state.rollback_available) throw new Error(_('No LuCI rollback copy exists yet.'));
					confirmAction(_('Restore previous configuration'), _('Validate and restore the configuration saved before the last apply? A running service will restart.'), 'rollback');
				}), E('p', {}, _('Save & Apply validates first and keeps a rollback copy. A running service restarts; a stopped service remains stopped.'))]),
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Diagnostics')),
				button(_('Validate saved configuration'), function() { return launch('validate'); }), ' ',
				button(_('Doctor'), function() { return launch('doctor'); }), ' ',
				button(_('Reload firewall'), function() { return launch('firewall-reload'); }), ' ',
				button(_('Status details'), function() { return getDiagnostics('status').then(function(r) { output.textContent = checked(r).output; }); }, false), ' ',
				button(_('Logs'), function() { return getDiagnostics('logs').then(function(r) { output.textContent = checked(r).output; }); }, false), output])
		]);
		showStatus(data[1]); updateButtons();
		poll.add(function() {
			return Promise.all([getStatus(), getJob()]).then(function(responses) {
				showStatus(responses[0]);
				var job = checked(responses[1]);
				if (busy && !job.busy) {
					busy = false; output.textContent = job.output || _('Operation finished.');
					if (job.code) ui.addNotification(null, E('p', {}, _('Operation failed. See diagnostics below.')), 'error');
					// Preserve unsaved edits after service actions and failed saves.
					return getConfig().then(function(next) {
						if (!dirty || (job.code === 0 && job.action === ownAction && (ownAction === 'save' || ownAction === 'rollback'))) populate(next);
						else { notice.hidden = !checked(next).recovery_required; state.rollback_available = next.rollback_available; }
						ownAction = null;
						updateButtons();
					});
				}
				busy = !!job.busy; updateButtons();
			}).catch(function(err) { status.textContent = _('Status unavailable: ') + (err.message || err); });
		}, 2);
		return root;
	}
});
