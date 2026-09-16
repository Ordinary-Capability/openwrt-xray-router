'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require xray-router.model as model';
'require xray-router.inspector as inspector';

var getConfig = rpc.declare({ object: 'luci.xray-router', method: 'get' });
var getStatus = rpc.declare({ object: 'luci.xray-router', method: 'status' });
var getJob = rpc.declare({ object: 'luci.xray-router', method: 'job' });
var getDiagnostics = rpc.declare({ object: 'luci.xray-router', method: 'diagnostics', params: ['action'] });
var startJob = rpc.declare({ object: 'luci.xray-router', method: 'start', params: ['action', 'config', 'revision', 'settings', 'nodes'] });
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
		var library = model.library(state.nodes);
		var fields = {};
		var selectors = {};
		var dirty = false;
		var busy = !!checked(data[2]).busy;
		var ownAction = null;
		var activeJob = null, submitting = false;
		var nodeTests = {}, activeTest = null;
		var canWrite = L.hasViewPermission();
		var buttons = [];
		var output = E('pre', { 'style': 'white-space:pre-wrap;max-height:28em;overflow:auto', 'aria-live': 'polite' }, _('Ready.'));
		var status = E('p', { 'aria-live': 'polite' });
		var notice = E('p', { 'class': 'alert-message warning', 'hidden': state.recovery_required ? null : '' },
			_('An earlier apply was interrupted. Restore the previous configuration before making further changes.'));
		var pending = E('p', { 'id': 'xray-operation-status', 'aria-live': 'polite',
			'style': 'min-height:1.5em;line-height:1.5em' });
		function error(err) { output.textContent = err.message || String(err); ui.addNotification(null, E('p', {}, [output.textContent]), 'error'); }
		function updateButtons() {
			buttons.forEach(function(item) { item.node.disabled = busy || (item.write && !canWrite) || !!item.blocked; });
			Object.keys(fields).forEach(function(key) { fields[key].disabled = busy || !canWrite; });
			Object.keys(selectors).forEach(function(key) { selectors[key].disabled = busy || !canWrite; });
			pending.textContent = busy ? _('Operation in progress…') : dirty ? _('Unsaved changes') : '';
		}
		function button(label, callback, write, group, blocked) {
			var node = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button',
				'click': function() { if (!node.disabled) Promise.resolve().then(callback).catch(error); } }, label);
			buttons.push({ node: node, write: write !== false, group: group, blocked: blocked });
			return node;
		}
		function field(key, label, value, help, kind) {
			var attrs = { 'id': 'xray-' + key, 'class': 'cbi-input-text', 'style': 'width:100%',
				'input': function() { dirty = true; updateButtons(); refreshOverview(); }, 'autocomplete': 'off', 'spellcheck': 'false' };
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
			library = model.library(state.nodes);
			var values = model.read(state.config);
			Object.keys(values).forEach(function(key) { if (fields[key]) fields[key].value = values[key]; });
			Object.keys(state.settings).forEach(function(key) { if (fields[key]) fields[key].value = state.settings[key]; });
			dirty = false;
			notice.hidden = !state.recovery_required;
			refreshLibrary(); refreshOverview(); updateButtons();
		}
		function showStatus(next) {
			next = checked(next);
			status.textContent = (next.running ? _('Service: running') : _('Service: stopped')) + ' · ' +
				(next.enabled ? _('Boot startup: enabled') : _('Boot startup: disabled'));
		}
		function launch(action, config, settings, nodes) {
			ownAction = action;
			activeJob = null; submitting = true;
			busy = true; updateButtons(); output.textContent = _('Starting operation…');
			return startJob(action, config || '', state.revision, settings || {}, nodes || '').then(checked).then(function(job) {
				activeJob = job.id; submitting = false;
			}).catch(function(err) {
				busy = false; ownAction = null; activeJob = null; submitting = false; updateButtons(); throw err;
			});
		}
		function confirmAction(title, message, action) {
			ui.showModal(title, [E('p', {}, message), E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() { ui.hideModal(); launch(action).catch(error); } }, title)
			])]);
		}
		var values = model.read(state.config);
		var libraryBody = E('div', { 'id': 'xray-node-library' });
		function testNode(id) {
			var fingerprint = JSON.stringify(library.nodes[id].outbound);
			activeTest = { id: id, fingerprint: fingerprint };
			nodeTests[id] = { fingerprint: fingerprint, pending: true, message: _('Testing…') };
			refreshLibrary();
			return launch('test-node', fingerprint).catch(function(err) {
				nodeTests[id] = { fingerprint: fingerprint, message: _('Failed: ') + (err.message || String(err)) };
				activeTest = null; refreshLibrary(); throw err;
			});
		}
		function editNode(id, duplicate) {
			var current = id && library.nodes[id];
			var alias = E('input', { 'id': 'xray-node-alias', 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%', 'autocomplete': 'off' });
			alias.value = current ? current.alias + (duplicate ? '-copy' : '') : '';
			var json = E('textarea', { 'id': 'xray-node-json', 'rows': 18, 'style': 'width:100%;font-family:monospace', 'spellcheck': 'false' });
			json.value = current ? JSON.stringify(current.outbound, null, 2) : model.template('socks');
			var validation = E('p', { 'class': 'alert-message warning', 'hidden': '', 'aria-live': 'polite' });
			ui.showModal(duplicate ? _('Duplicate proxy node') : current ? _('Edit proxy node') : _('Add proxy node'), [
				E('label', { 'for': 'xray-node-alias' }, _('Alias')), alias,
				E('p', {}, _('Use a name such as us-vps or jp-vps. Assign this node to outbound tags in Routing.')),
				E('label', { 'for': 'xray-node-json' }, _('Outbound JSON')), json,
				E('p', {}, _('Paste a complete outbound object. Its tag is supplied by each assignment. Credentials are visible here; advanced fields are preserved.')),
				E('div', {}, ['socks', 'vless'].map(function(protocol) {
					return E('button', { 'type': 'button', 'class': 'cbi-button', 'click': function() { json.value = model.template(protocol); } },
						protocol === 'socks' ? _('Insert SOCKS5 template') : _('Insert VLESS REALITY template'));
				})),
				E('p', {}, _('Templates replace the editor contents. Use node updates the draft; Save & Apply saves it. Assigned node changes affect every tag using that node.')),
				validation,
				E('div', { 'class': 'right' }, [E('button', { 'type': 'button', 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
					E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-positive', 'click': function() {
						try {
							if (busy || !canWrite) throw new Error(_('An operation is in progress or write access is unavailable.'));
							var existing = duplicate ? null : id;
							var node = model.node(alias.value, json.value, library, existing);
							var key = existing || 'node-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
							library.nodes[key] = node;
							dirty = true; refreshLibrary(); refreshOverview(); updateButtons(); ui.hideModal();
						} catch (err) { validation.hidden = false; validation.textContent = err.message || String(err); }
					} }, _('Use node'))])
			]);
		}
		function refreshLibrary() {
			buttons = buttons.filter(function(item) { return item.group !== 'library'; });
			var rows = Object.keys(library.nodes).map(function(id) {
				var node = library.nodes[id], used = model.assigned(library, id);
				var test = nodeTests[id];
				if (test && test.fingerprint !== JSON.stringify(node.outbound)) { delete nodeTests[id]; test = null; }
				var summary = model.overview(JSON.stringify({ outbounds: [node.outbound], routing: {} })).outbounds[0];
				return [node.alias, summary.protocol + ' · ' + _(summary.endpoint), used.join(', ') || _('Unassigned'),
					E('span', { 'id': 'xray-node-test-' + id, 'aria-live': 'polite',
						'class': test && !test.pending ? (test.success ? 'success' : 'error') : '' }, test ? test.message : _('Not tested')),
					E('div', {}, [button(_('Test'), function() { return testNode(id); }, true, 'library'), ' ',
						button(_('Edit'), function() { editNode(id, false); }, true, 'library'), ' ',
						button(_('Duplicate'), function() { editNode(id, true); }, true, 'library'), ' ',
						button(_('Delete'), function() {
							ui.showModal(_('Delete proxy node'), [E('p', {}, _('Remove this node from the draft? Save & Apply saves the deletion.')),
								E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
								E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() {
									if (busy || !canWrite || model.assigned(library, id).length) return;
									delete library.nodes[id]; dirty = true; refreshLibrary(); refreshOverview(); updateButtons(); ui.hideModal();
								} }, _('Delete node'))]);
						}, true, 'library', used.length > 0)])];
			});
			libraryBody.replaceChildren(rows.length ? table([_('Alias'), _('Protocol / endpoint'), _('Assigned to'), _('Connectivity'), _('Actions')], rows) :
				E('p', {}, _('No proxy nodes yet. Add a node, then assign it in Routing.')));
			updateButtons();
		}

		var activeTab = 'routing', inspectorReady = false, inspectorLoading = false;
		var overview = E('section', { 'class': 'cbi-section', 'id': 'xray-route-map' });
		function entries() {
			var result = {}; Object.keys(fields).forEach(function(key) { result[key] = fields[key].value; });
			return result;
		}
		function table(headers, rows) {
			return E('div', { 'style': 'overflow:auto' }, E('table', { 'class': 'table', 'style': 'width:100%' }, [
				E('thead', {}, E('tr', { 'class': 'tr table-titles' }, headers.map(function(label) { return E('th', { 'class': 'th', 'scope': 'col' }, label); }))),
				E('tbody', {}, rows.map(function(cells) { return E('tr', { 'class': 'tr' }, cells.map(function(cell) {
					return E('td', { 'class': 'td', 'style': 'text-align:left;vertical-align:top;overflow-wrap:anywhere;max-width:32em;white-space:normal' }, cell);
				})); }))
			]));
		}
		function refreshOverview() {
			if (!overview) return;
			var mapping, message, shownLibrary = library;
			try {
				mapping = model.overview(dirty ? model.build(state.config, entries(), library) : state.config);
				message = dirty ? _('Preview of unsaved changes. Save & Apply updates the running service.') : _('Saved configuration. Rules are evaluated from top to bottom; the first match wins.');
			} catch (err) {
				mapping = model.overview(state.config);
				shownLibrary = model.library(state.nodes);
				message = _('Showing saved configuration. Finish the current edits to preview changes: ') + err.message;
			}
			function target(tag) {
				var node = mapping.outbounds.filter(function(item) { return item.tag === tag; })[0];
				var assigned = shownLibrary.nodes[shownLibrary.bindings[tag]];
				return node ? tag + ' → ' + (assigned ? assigned.alias + ' → ' : '') + node.protocol + ' · ' + _(node.endpoint) : tag + ' (' + _('not found') + ')';
			}
			selectors = {};
			var assignments = model.proxyTags.map(function(tag) {
				var selector = E('select', { 'class': 'cbi-input-select', 'id': 'xray-bind-' + tag, 'aria-label': _('Proxy node for ') + tag,
					'change': function() {
						library.bindings[tag] = selector.value; dirty = true; refreshLibrary(); refreshOverview(); updateButtons();
						selectors[tag].focus();
					} }, [E('option', { 'value': '' }, _('Unconfigured (block)'))].concat(Object.keys(library.nodes).map(function(id) {
						return E('option', { 'value': id }, library.nodes[id].alias);
					})));
				selector.value = library.bindings[tag]; selectors[tag] = selector;
				var node = library.nodes[selector.value];
				return [tag, selector, node ? model.overview(JSON.stringify({ outbounds: [node.outbound], routing: {} })).outbounds[0].endpoint : _('Blocked / unconfigured')];
			});
			var content = [E('h3', {}, _('Routes and outbound mappings')), E('p', {}, message),
				state.nodes_notice ? E('p', { 'class': 'alert-message warning' }, state.nodes_notice) : '',
				E('p', {}, _('LAN traffic first passes the kernel bypass rules for local, reserved and proxy-server addresses. CN IPv4 fast path, when enabled, also runs before these Xray rules.')),
				table([_('Order / rule'), _('Match conditions'), _('Outbound / proxy node')], mapping.rules.map(function(rule) {
					var balancer = mapping.balancers.filter(function(item) { return item.tag === rule.target; })[0];
					var route = rule.balancer && balancer ? [rule.target + ' (' + balancer.strategy + ')']
						.concat(balancer.members.map(target)).concat(balancer.fallback ? [_('Fallback: ') + target(balancer.fallback)] : []).join('\n') : target(rule.target);
					return [rule.order + '. ' + rule.name + (rule.disabled ? ' · ' + _('Disabled') : ''),
						E('div', { 'style': 'white-space:pre-wrap' }, rule.conditions.join('\n') || _('Any traffic')),
						E('div', { 'style': 'white-space:pre-wrap' }, route)];
				})),
				E('h3', {}, _('Outbound tags → configuration')),
				table([_('Outbound tag'), _('Proxy node'), _('Server / behavior')], assignments),
				E('p', {}, _('Choose a named node for each tag. One node can serve several tags. Changes take effect on Save & Apply.')),
				table([_('Built-in outbound'), _('Protocol'), _('Server / behavior'), _('Chained through')], mapping.outbounds.filter(function(node) { return model.proxyTags.indexOf(node.tag) < 0; }).map(function(node) {
					return [node.tag, node.protocol, _(node.endpoint), node.via || '—'];
				})),
				E('p', {}, _('Proxy node credentials are edited in Proxy Nodes. Global DNS uses proxy-main; backup selection applies to the client-traffic balancer.'))];
			overview.replaceChildren.apply(overview, content);
			updateButtons();
		}
		var routingPanel = E('div', { 'id': 'xray-panel-routing', 'role': 'tabpanel', 'aria-labelledby': 'xray-tab-routing' }, [
			overview,
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Routing')),
				field('LAN_INTERFACES', _('LAN interfaces'), state.settings.LAN_INTERFACES, _('Space-separated device names, for example br-lan br-guest.')),
				field('ENABLE_CN_FASTPATH', _('CN IPv4 fast path'), state.settings.ENABLE_CN_FASTPATH, _('When enabled, CN IPs bypass Xray before force-proxy domain rules.'), [['1', _('Enabled')], ['0', _('Disabled')]]),
				field('IPV6_MODE', _('Global IPv6'), state.settings.IPV6_MODE, '', [['block', _('Block')], ['bypass', _('Bypass proxy')]]),
				field('direct', _('Force-direct domains'), values.direct, _('One domain per line. Xray prefixes such as domain: and full: are accepted.'), 'textarea'),
				field('proxy', _('Force-proxy domains'), values.proxy, _('Leave blank to use an inert .invalid placeholder.'), 'textarea')]),
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Streaming routes')), E('div', {}, [
				field('stream_enabled', _('Streaming routing'), values.stream_enabled,
					_('Disabling keeps the node and domain list for later use.'), [['0', _('Disabled')], ['1', _('Enabled')]]),
				field('stream_domains', _('Streaming domains'), values.stream_domains,
					_('One domain per line. Supports domain:, full:, and geosite: groups. Bare domains include subdomains.'), 'textarea'),
				button(_('Add streaming service presets'), function() {
					fields.stream_domains.value = model.streamingPreset(fields.stream_domains.value);
					dirty = true; updateButtons(); refreshOverview();
				}),
				E('p', {}, _('Adds Netflix, Prime Video, HBO/Max, and Disney+ while keeping custom entries. Remove a group to exclude that service. The installed GeoSite database must contain the selected groups.')),
				E('p', {}, _('Matching connections use this node without fallback. Force-direct rules take priority. Disable CN IPv4 fast path if CN destinations must use this node too.')),
				E('p', {}, _('Global DNS still uses the primary node. A streaming node in a different region may need matching DNS routing.'))
			])]),
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Health checks')),
				field('probe_url', _('Probe URL'), values.probe_url, _('Use a reliable HTTP(S) endpoint reachable through the primary.')),
				field('probe_interval', _('Probe interval (seconds)'), values.probe_interval, _('1–3600 seconds. Switching affects new connections after a health check completes.'), 'number'),
				E('p', {}, _('Client traffic uses the backup while the primary is unhealthy and returns when it recovers. Global DNS continues to use the primary.'))])
		]);
		var nodesPanel = E('div', { 'id': 'xray-panel-nodes', 'role': 'tabpanel', 'aria-labelledby': 'xray-tab-nodes' }, [
			E('p', {}, _('Keep your available proxy nodes here with aliases such as us-vps and jp-vps. Choose their outbound assignments in Routing.')),
			button(_('Add node'), function() { editNode(null, false); }), libraryBody,
			E('p', {}, _('Test checks HTTPS access to www.gstatic.com/generate_204 through the selected node, including draft edits. Results show total request time, not ping or download speed. Testing does not save changes or restart the service.')),
			E('p', {}, _('Unassign a node before deleting it. Adding an unused node or renaming an alias does not restart Xray. Assigned node changes apply to every tag using that node.')),
			E('p', {}, _('Unused nodes are saved as JSON and checked by Xray when assigned and applied.'))
		]);
		var inspectorPanel = E('div', { 'id': 'xray-panel-inspector', 'role': 'tabpanel', 'aria-labelledby': 'xray-tab-inspector' });
		var panels = { routing: routingPanel, nodes: nodesPanel, inspector: inspectorPanel };
		var tabs = [], tabItems = [];
		function loadInspector() {
			if (inspectorReady || inspectorLoading) return;
			inspectorLoading = true;
			inspectorPanel.replaceChildren(E('p', {}, _('Loading inspector…')));
			inspector.load().then(function(data) {
				inspectorPanel.replaceChildren(inspector.render(data, {
					embedded: true,
					isActive: function() { return activeTab === 'inspector'; },
					isDirty: function() { return dirty; },
					onConfigChanged: function() { return getConfig().then(function(next) { if (!dirty) populate(next); }); }
				}));
				inspectorReady = true;
			}).catch(function(err) {
				inspectorPanel.replaceChildren(E('p', { 'class': 'alert-message warning' }, err.message || String(err)),
					E('button', { 'type': 'button', 'class': 'cbi-button', 'click': loadInspector }, _('Retry inspector')));
			}).finally(function() { inspectorLoading = false; });
		}
		function selectTab(name) {
			activeTab = name;
			Object.keys(panels).forEach(function(key, index) {
				panels[key].hidden = key !== name;
				tabs[index].setAttribute('aria-selected', key === name ? 'true' : 'false');
				tabs[index].tabIndex = key === name ? 0 : -1;
				tabItems[index].className = key === name ? 'cbi-tab' : 'cbi-tab-disabled';
			});
			configurationActions.hidden = name === 'inspector';
			if (name === 'routing') refreshOverview();
			if (name === 'inspector') loadInspector();
		}
		var tabBar = E('ul', { 'class': 'cbi-tabmenu', 'role': 'tablist', 'aria-label': _('Xray Router sections') },
			[['routing', _('Routing')], ['nodes', _('Proxy Nodes')], ['inspector', _('Inspector')]].map(function(pair, index) {
				var tab = E('button', { 'id': 'xray-tab-' + pair[0], 'type': 'button', 'role': 'tab',
					'aria-controls': 'xray-panel-' + pair[0],
					'style': 'border:0;background:transparent;color:inherit;padding:.7em 1.2em;cursor:pointer;font:inherit',
					'click': function() { selectTab(pair[0]); },
					'keydown': function(event) {
						var next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 :
							event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
						if (next < 0) return;
						event.preventDefault(); selectTab(['routing', 'nodes', 'inspector'][next]); tabs[next].focus();
					} }, pair[1]);
				tabs.push(tab);
				var item = E('li', { 'role': 'presentation' }, [tab]); tabItems.push(item); return item;
			}));
		var configurationActions = E('div', {}, [
			E('div', { 'class': 'cbi-page-actions' }, [
				button(_('Save & Apply'), function() {
					var entries = {}; Object.keys(fields).forEach(function(key) { entries[key] = fields[key].value; });
					var config = model.build(state.config, entries, library);
					return launch('save', config, { LAN_INTERFACES: entries.LAN_INTERFACES,
						ENABLE_CN_FASTPATH: entries.ENABLE_CN_FASTPATH, IPV6_MODE: entries.IPV6_MODE }, JSON.stringify(library));
				}), ' ', button(_('Reload saved configuration'), function() {
					if (!dirty) return getConfig().then(populate);
					ui.showModal(_('Discard unsaved changes'), [E('p', {}, _('Reload the saved configuration and discard form edits?')),
						E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
						E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() { ui.hideModal(); getConfig().then(populate).catch(error); } }, _('Reload'))]);
				}, false), ' ', button(_('Restore previous configuration'), function() {
					if (!state.rollback_available) throw new Error(_('No LuCI rollback copy exists yet.'));
					confirmAction(_('Restore previous configuration'), _('Restore the configuration and node library saved before the last apply? Runtime changes restart a running service.'), 'rollback');
				}), E('p', {}, _('Save & Apply saves both tabs with a rollback copy. Runtime changes are validated and restart a running service; library-only changes do not restart it.'))]),
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Diagnostics')),
				button(_('Validate saved configuration'), function() { return launch('validate'); }), ' ',
				button(_('Doctor'), function() { return launch('doctor'); }), ' ',
				button(_('Reload firewall'), function() { return launch('firewall-reload'); }), ' ',
				button(_('Status details'), function() { return getDiagnostics('status').then(function(r) { output.textContent = checked(r).output; }); }, false), ' ',
				button(_('Logs'), function() { return getDiagnostics('logs').then(function(r) { output.textContent = checked(r).output; }); }, false), output])
		]);
		var root = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Xray Router')), notice, status,
			E('div', { 'class': 'cbi-section' }, [
				button(_('Start'), function() { return launch('start'); }), ' ',
				button(_('Stop'), function() { confirmAction(_('Stop service'), _('Restore the saved dnsmasq configuration and disable transparent interception?'), 'stop'); }), ' ',
				button(_('Restart'), function() { return launch('restart'); }), ' ',
				button(_('Enable at boot'), function() { return launch('enable'); }), ' ',
				button(_('Disable at boot'), function() { return launch('disable'); }), ' ',
				button(_('Update CN IP list'), function() { return launch('update-cn'); }),
				E('p', {}, _('Service controls use the saved configuration. Unsaved form edits are applied only by Save & Apply.'))]),
			tabBar, pending, routingPanel, nodesPanel, inspectorPanel, configurationActions
		]);
		refreshLibrary(); selectTab('routing');
		showStatus(data[1]); updateButtons();
		poll.add(function() {
			return Promise.all([getStatus(), getJob()]).then(function(responses) {
				showStatus(responses[0]);
				var job = checked(responses[1]);
				// A poll sent before start may return the previous operation's result.
				if (submitting || (activeJob && job.id !== activeJob)) return;
				if (busy && !job.busy) {
					busy = false; output.textContent = job.output || _('Operation finished.');
					if (activeTest) {
						var tested = job.action === 'test-node' && job.node_test;
						nodeTests[activeTest.id] = { fingerprint: activeTest.fingerprint, success: !!(tested && tested.success && !job.code),
							message: tested && tested.success && !job.code ? tested.message : _('Failed: ') + (tested && tested.message || job.output || _('Test interrupted.')) };
						activeTest = null; refreshLibrary();
					}
					if (job.code) ui.addNotification(null, E('p', {}, _('Operation failed. See diagnostics below.')), 'error');
					// Preserve unsaved edits after service actions and failed saves.
					return getConfig().then(function(next) {
						if (!dirty || (job.code === 0 && job.action === ownAction && (ownAction === 'save' || ownAction === 'rollback'))) populate(next);
						else { notice.hidden = !checked(next).recovery_required; state.rollback_available = next.rollback_available; }
						ownAction = null;
						activeJob = null;
						updateButtons();
					});
				}
				busy = !!job.busy; updateButtons();
			}).catch(function(err) { status.textContent = _('Status unavailable: ') + (err.message || err); });
		}, 2);
		return root;
	}
});
