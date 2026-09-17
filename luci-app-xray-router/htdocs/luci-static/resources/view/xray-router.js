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
		var nextPollAt = 0;
		var nodeTests = {}, activeTest = null;
		var canWrite = L.hasViewPermission();
		var buttons = [];
		var output = E('pre', { 'style': 'white-space:pre-wrap;max-height:28em;overflow:auto', 'aria-live': 'polite' }, _('Ready.'));
		var status = E('span', { 'class': 'xr-badge xr-status', 'aria-live': 'polite' });
		var bootEnabled = false, diagnostics;
		var boot = E('input', { 'id': 'xray-boot', 'type': 'checkbox', 'role': 'switch',
			'change': function() {
				if (busy || !canWrite) { boot.checked = bootEnabled; return; }
				launch(boot.checked ? 'enable' : 'disable').catch(function(err) { boot.checked = bootEnabled; error(err); });
			} });
		var notice = E('p', { 'class': 'alert-message warning', 'hidden': state.recovery_required ? null : '' },
			_('An earlier apply was interrupted. Restore the previous configuration before making further changes.'));
		var pending = E('p', { 'id': 'xray-operation-status', 'aria-live': 'polite' });
		function showOutput(text) { output.textContent = text; if (diagnostics) diagnostics.open = true; }
		function error(err) { showOutput(err.message || String(err)); ui.addNotification(null, E('p', {}, [output.textContent]), 'error'); }
		function help(title, text) { return E('details', { 'class': 'xr-help' }, [E('summary', {}, title), E('p', {}, text)]); }
		function updateButtons() {
			buttons.forEach(function(item) { item.node.disabled = busy || (item.write && !canWrite) || !!item.blocked; });
			Object.keys(fields).forEach(function(key) { fields[key].disabled = busy || !canWrite; });
			Object.keys(selectors).forEach(function(key) { selectors[key].disabled = busy || !canWrite; });
			boot.disabled = busy || !canWrite;
			pending.textContent = busy ? _('Working…') : dirty ? _('Unsaved changes') : '';
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
			status.textContent = next.running ? _('Running') : _('Stopped');
			status.setAttribute('class', 'xr-badge xr-status ' + (next.running ? 'is-success' : ''));
			bootEnabled = !!next.enabled; boot.checked = bootEnabled;
		}
		function launch(action, config, settings, nodes) {
			ownAction = action;
			activeJob = null; submitting = true;
			nextPollAt = 0;
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
		var libraryBody = E('div', { 'id': 'xray-node-library', 'class': 'xr-node-table' });
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
				return [E('div', {}, [E('strong', { 'class': 'xr-node-name' }, node.alias),
					E('span', { 'class': 'xr-muted' }, summary.protocol + ' · ' + _(summary.endpoint))]),
					used.length ? E('div', {}, used.map(function(tag) { return E('span', { 'class': 'xr-badge' }, tag); })) : E('span', { 'class': 'xr-muted' }, _('Unassigned')),
					E('span', { 'id': 'xray-node-test-' + id, 'aria-live': 'polite',
						'title': test ? test.message : '',
						'class': 'xr-badge ' + (test ? (test.pending ? 'is-pending' : test.success ? 'is-success' : 'is-error') : '') },
						test ? (test.pending ? _('Testing…') : test.success ? test.message.replace(/\s*\(HTTPS 204\)$/, '') : _('Failed')) : _('Not tested')),
					E('div', { 'class': 'xr-actions' }, [button(_('Test'), function() { return testNode(id); }, true, 'library'),
						button(_('Edit'), function() { editNode(id, false); }, true, 'library'), ' ',
						E('details', { 'class': 'xr-menu' }, [E('summary', { 'aria-label': _('More actions for ') + node.alias }, _('More ▾')), E('div', { 'class': 'xr-menu-panel' }, [
						button(_('Duplicate'), function() { editNode(id, true); }, true, 'library'), ' ',
						button(_('Delete'), function() {
							ui.showModal(_('Delete proxy node'), [E('p', {}, _('Remove this node from the draft? Save & Apply saves the deletion.')),
								E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
								E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() {
									if (busy || !canWrite || model.assigned(library, id).length) return;
									delete library.nodes[id]; dirty = true; refreshLibrary(); refreshOverview(); updateButtons(); ui.hideModal();
								} }, _('Delete node'))]);
						}, true, 'library', used.length > 0)])])])];
			});
			libraryBody.replaceChildren(rows.length ? table([_('Node'), _('Assigned to'), _('Connectivity'), _('Actions')], rows) :
				E('p', {}, _('No proxy nodes yet. Add a node, then assign it in Routing.')));
			updateButtons();
		}

		var activeTab = 'routing', inspectorReady = false, inspectorLoading = false;
		var builtinsOpen = false;
		var overview = E('div', { 'id': 'xray-route-map' });
		function entries() {
			var result = {}; Object.keys(fields).forEach(function(key) { result[key] = fields[key].value; });
			return result;
		}
		function table(headers, rows) {
			return E('div', { 'class': 'xr-table-wrap' }, E('table', { 'class': 'table' }, [
				E('thead', {}, E('tr', { 'class': 'tr table-titles' }, headers.map(function(label) { return E('th', { 'class': 'th', 'scope': 'col' }, label); }))),
				E('tbody', {}, rows.map(function(cells) { return E('tr', { 'class': 'tr' }, cells.map(function(cell) {
					return E('td', { 'class': 'td' }, cell);
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
				return E('div', { 'class': 'xr-assignment' }, [E('label', { 'for': 'xray-bind-' + tag }, tag), selector,
					E('span', { 'class': 'xr-muted' }, node ? model.overview(JSON.stringify({ outbounds: [node.outbound], routing: {} })).outbounds[0].endpoint : _('Blocked / unconfigured'))]);
			});
			var content = [E('section', { 'class': 'xr-card' }, [
				E('div', { 'class': 'xr-section-head' }, E('div', {}, [E('h3', {}, _('Outbound assignments')),
					E('p', { 'class': 'xr-muted' }, _('Choose which node each outbound tag uses.'))])),
				state.nodes_notice ? E('p', { 'class': 'alert-message warning' }, state.nodes_notice) : '',
				E('div', { 'class': 'xr-assignments' }, assignments),
				help(_('How assignments work'), _('One node can serve several tags. Save & Apply activates changes. Global DNS uses proxy-main; backup selection applies to the client-traffic balancer.'))]),
				E('section', { 'class': 'xr-card' }, [E('div', { 'class': 'xr-section-head' }, E('div', {}, [E('h3', {}, _('Routing rules')), E('p', { 'class': 'xr-muted' }, message)])),
				table([_('Order / rule'), _('Match conditions'), _('Outbound / proxy node')], mapping.rules.map(function(rule) {
					var balancer = mapping.balancers.filter(function(item) { return item.tag === rule.target; })[0];
					var route = rule.balancer && balancer ? [rule.target + ' (' + balancer.strategy + ')']
						.concat(balancer.members.map(target)).concat(balancer.fallback ? [_('Fallback: ') + target(balancer.fallback)] : []).join('\n') : target(rule.target);
					return [rule.order + '. ' + rule.name + (rule.disabled ? ' · ' + _('Disabled') : ''),
						E('div', { 'style': 'white-space:pre-wrap' }, rule.conditions.join('\n') || _('Any traffic')),
						E('div', { 'style': 'white-space:pre-wrap' }, route)];
				})),
				help(_('About rule priority'), _('Rules run from top to bottom; the first match wins. Kernel bypass for local, reserved, proxy-server and enabled CN IPv4 destinations happens before these Xray rules.')),
				E('details', { 'class': 'xr-help', 'open': builtinsOpen ? '' : null, 'toggle': function(event) { builtinsOpen = event.target.open; } }, [E('summary', {}, _('Built-in outbound details')),
				table([_('Built-in outbound'), _('Protocol'), _('Server / behavior'), _('Chained through')], mapping.outbounds.filter(function(node) { return model.proxyTags.indexOf(node.tag) < 0; }).map(function(node) {
					return [node.tag, node.protocol, _(node.endpoint), node.via || '—'];
				}))])])];
			overview.replaceChildren.apply(overview, content);
			updateButtons();
		}
		var routingPanel = E('div', { 'id': 'xray-panel-routing', 'role': 'tabpanel', 'aria-labelledby': 'xray-tab-routing' }, [
			overview,
			E('section', { 'class': 'xr-card' }, [E('h3', {}, _('Domain overrides')), E('div', { 'class': 'xr-form-grid' }, [
				field('direct', _('Force-direct domains'), values.direct, _('One domain per line; domain: and full: are supported.'), 'textarea'),
				field('proxy', _('Force-proxy domains'), values.proxy, _('Leave blank if no override is needed.'), 'textarea')])]),
			E('details', { 'class': 'xr-card xr-disclosure' }, [E('summary', {}, _('Advanced routing')),
				field('LAN_INTERFACES', _('LAN interfaces'), state.settings.LAN_INTERFACES, _('Space-separated device names, for example br-lan br-guest.')),
				field('ENABLE_CN_FASTPATH', _('CN IPv4 fast path'), state.settings.ENABLE_CN_FASTPATH, _('When enabled, CN IPs bypass Xray before force-proxy domain rules.'), [['1', _('Enabled')], ['0', _('Disabled')]]),
				field('IPV6_MODE', _('Global IPv6'), state.settings.IPV6_MODE, '', [['block', _('Block')], ['bypass', _('Bypass proxy')]])]),
			E('details', { 'class': 'xr-card xr-disclosure' }, [E('summary', {}, _('Streaming routes')), E('div', {}, [
				field('stream_enabled', _('Streaming routing'), values.stream_enabled,
					_('Disabling keeps the node and domain list for later use.'), [['0', _('Disabled')], ['1', _('Enabled')]]),
				field('stream_domains', _('Streaming domains'), values.stream_domains,
					_('One domain per line. Supports domain:, full:, and geosite: groups. Bare domains include subdomains.'), 'textarea'),
				button(_('Add streaming service presets'), function() {
					fields.stream_domains.value = model.streamingPreset(fields.stream_domains.value);
					dirty = true; updateButtons(); refreshOverview();
				}),
				help(_('Streaming routing help'), _('Presets add Netflix, Prime Video, HBO/Max and Disney+ while keeping custom entries. The installed GeoSite database must include these groups. Streaming uses proxy-stream without fallback; force-direct and CN IPv4 bypass take priority. Global DNS still uses the primary node.'))
			])]),
			E('details', { 'class': 'xr-card xr-disclosure' }, [E('summary', {}, _('Health checks')),
				field('probe_url', _('Probe URL'), values.probe_url, _('Use a reliable HTTP(S) endpoint reachable through the primary.')),
				field('probe_interval', _('Probe interval (seconds)'), values.probe_interval, _('1–3600 seconds. Switching affects new connections after a health check completes.'), 'number'),
				help(_('About failover'), _('Client traffic uses the backup while the primary is unhealthy and returns when it recovers. Global DNS continues to use the primary.'))])
		]);
		var nodesPanel = E('div', { 'id': 'xray-panel-nodes', 'role': 'tabpanel', 'aria-labelledby': 'xray-tab-nodes' }, [
			E('section', { 'class': 'xr-card' }, [E('div', { 'class': 'xr-section-head' }, [E('div', {}, [E('h3', {}, _('Your proxy nodes')),
				E('p', { 'class': 'xr-muted' }, _('Manage nodes here. Assign them to outbound tags in Routing.'))]),
				button(_('Add node'), function() { editNode(null, false); })]), libraryBody,
				help(_('Testing and editing nodes'), _('Test checks HTTPS access to www.gstatic.com/generate_204 using the current node draft. Time includes connection setup and TLS; it is not ping or download speed. Testing never saves or restarts Xray. Unassign a node before deleting it. Assigned edits take effect for all its tags on Save & Apply; alias-only and unused-node changes do not restart Xray.'))])
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
					onJobStarted: function(job) { busy = true; activeJob = job.id; nextPollAt = 0; updateButtons(); },
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
			E('div', { 'class': 'xr-savebar' }, [
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
				})]), E('p', { 'class': 'xr-muted' }, _('Applies both tabs. Runtime changes restart Xray; a rollback copy is kept.'))
		]);
		diagnostics = E('details', { 'id': 'xray-diagnostics', 'class': 'xr-card xr-disclosure xr-diagnostics' }, [E('summary', {}, _('Diagnostics')),
			E('div', { 'class': 'xr-actions' }, [
				button(_('Validate saved configuration'), function() { return launch('validate'); }), ' ',
				button(_('Doctor'), function() { return launch('doctor'); }), ' ',
				button(_('Reload firewall'), function() { return launch('firewall-reload'); }), ' ',
				button(_('Status details'), function() { return getDiagnostics('status').then(function(r) { showOutput(checked(r).output); }); }, false), ' ',
				button(_('Logs'), function() { return getDiagnostics('logs').then(function(r) { showOutput(checked(r).output); }); }, false)]), output
		]);
		var root = E('div', { 'class': 'cbi-map xr-app' }, [
			E('link', { 'rel': 'stylesheet', 'href': L.resource('xray-router/style.css') + '?v=3' }),
			E('div', { 'class': 'xr-header' }, [E('div', { 'class': 'xr-title' }, [E('h2', {}, _('Xray Router')), status]), pending]), notice,
			E('div', { 'class': 'xr-toolbar' }, [E('div', { 'class': 'xr-toolbar-group' }, [
				button(_('Start'), function() { return launch('start'); }), ' ',
				button(_('Stop'), function() { confirmAction(_('Stop service'), _('Restore the saved dnsmasq configuration and disable transparent interception?'), 'stop'); }), ' ',
				button(_('Restart'), function() { return launch('restart'); })]),
				E('div', { 'class': 'xr-toolbar-group' }, [E('label', { 'class': 'xr-boot', 'for': 'xray-boot' }, [boot, _('Start on boot')]),
					button(_('Update CN IP list'), function() { return launch('update-cn'); })])]),
			tabBar, routingPanel, nodesPanel, inspectorPanel, configurationActions, diagnostics
		]);
		refreshLibrary(); selectTab('routing');
		showStatus(data[1]); updateButtons();
		poll.add(function() {
			if (!busy && Date.now() < nextPollAt) return Promise.resolve();
			nextPollAt = Date.now() + 5000;
			return Promise.all([getStatus(), getJob()]).then(function(responses) {
				showStatus(responses[0]);
				var job = checked(responses[1]);
				// A poll sent before start may return the previous operation's result.
				if (submitting || (activeJob && job.id !== activeJob)) return;
				if (busy && !job.busy) {
					busy = false; showOutput(job.output || _('Operation finished.'));
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
		}, 1);
		return root;
	}
});
