'use strict';
'require baseclass';

var streamDisabledTag = 'xray-router-stream-disabled';
var streamPlaceholder = 'domain:example-stream.invalid';
var proxyTags = ['proxy-main', 'proxy-backup', 'proxy-stream'];
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function optional(items, key, value) {
	var matches = (items || []).filter(function(item) { return item[key] === value; });
	if (matches.length > 1) throw new Error('Duplicate ' + value + '.');
	return matches[0];
}
function find(items, key, value) {
	var match = optional(items, key, value);
	if (!match)
		throw new Error('Expected one ' + value + '. Merge the current project configuration first.');
	return match;
}
function streamingInbounds(config) {
	return ['tproxy-in'].concat((config.inbounds || []).filter(function(inbound) {
		return inbound.tag && inbound.tag !== 'tproxy-in' && inbound.tag !== streamDisabledTag &&
			(inbound.protocol === 'socks' || inbound.protocol === 'http');
	}).map(function(inbound) { return inbound.tag; }));
}
function streamingScope(config, tags) {
	var allowed = streamingInbounds(config);
	return Array.isArray(tags) && tags.indexOf('tproxy-in') >= 0 && tags.every(function(tag, index) {
		return allowed.indexOf(tag) >= 0 && tags.indexOf(tag) === index;
	});
}
function ensureStreaming(config) {
	if (!optional(config.outbounds, 'tag', 'proxy-stream'))
		config.outbounds.push({ tag: 'proxy-stream', protocol: 'blackhole', settings: { response: { type: 'none' } } });
	if (!optional(config.routing.rules, 'ruleTag', 'STREAMING-PROXY')) {
		var direct = find(config.routing.rules, 'ruleTag', 'FORCE-DIRECT');
		config.routing.rules.splice(config.routing.rules.indexOf(direct) + 1, 0, {
			type: 'field', inboundTag: ['tproxy-in'], domain: [streamPlaceholder],
			outboundTag: 'proxy-stream', ruleTag: 'STREAMING-PROXY'
		});
	}
}
function domains(text, placeholder) {
	var entries = text.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
	entries = entries.map(function(s) { return s.indexOf(':') < 0 ? 'domain:' + s : s; });
	if (entries.some(function(s) { return /\s/.test(s); })) throw new Error('Use one domain rule per line.');
	return entries.length ? entries : [placeholder];
}

return baseclass.extend({
	proxyTags: proxyTags,
	library: function(raw) {
		var library = JSON.parse(raw);
		if (!library || library.version !== 1 || !library.nodes || !library.bindings)
			throw new Error('Invalid proxy node library.');
		// Older Lua JSON libraries encode an empty table as an array.
		if (Array.isArray(library.nodes) && !library.nodes.length) library.nodes = {};
		return library;
	},
	node: function(alias, raw, library, id) {
		alias = alias.trim();
		if (!alias || new TextEncoder().encode(alias).length > 64 || /[\x00-\x1f\x7f]/.test(alias))
			throw new Error('Enter a node alias of 1–64 bytes without control characters.');
		if (Object.keys(library.nodes).some(function(key) { return key !== id && library.nodes[key].alias.toLowerCase() === alias.toLowerCase(); }))
			throw new Error('Node aliases must be unique.');
		if (!id && Object.keys(library.nodes).length >= 64) throw new Error('At most 64 proxy nodes are supported.');
		var outbound = JSON.parse(raw);
		if (!outbound || Array.isArray(outbound) || typeof outbound !== 'object' || typeof outbound.protocol !== 'string' || !/^[a-zA-Z0-9-]+$/.test(outbound.protocol))
			throw new Error('Enter a valid Xray outbound object with a protocol.');
		delete outbound.tag;
		return { alias: alias, outbound: outbound };
	},
	assigned: function(library, id) {
		return proxyTags.filter(function(tag) { return library.bindings[tag] === id; });
	},
	bind: function(raw, library) {
		var config = JSON.parse(raw), values = {};
		proxyTags.forEach(function(tag, index) {
			var id = library.bindings[tag], outbound;
			if (id) {
				if (!Object.prototype.hasOwnProperty.call(library.nodes, id)) throw new Error('Missing node for ' + tag + '.');
				outbound = clone(library.nodes[id].outbound);
			} else {
				var previous = optional(config.outbounds, 'tag', tag);
				outbound = previous && previous.protocol === 'blackhole' ? clone(previous) : { protocol: 'blackhole', settings: { response: { type: 'none' } } };
			}
			outbound.tag = tag;
			values[['primary', 'backup', 'stream'][index]] = JSON.stringify(outbound);
		});
		return values;
	},
	overview: function(raw) {
		var config = JSON.parse(raw);
		var outbounds = (config.outbounds || []).map(function(outbound) {
			var settings = outbound.settings || {};
			var servers = settings.servers || settings.vnext || [];
			var endpoint = settings.address ? [{ address: settings.address, port: settings.port }] : servers;
			return { tag: outbound.tag, protocol: outbound.protocol,
				endpoint: endpoint.map(function(server) {
					return String(server.address || '') + (server.port ? ':' + server.port : '');
				}).join(', ') || (outbound.protocol === 'freedom' ? 'Direct connection' :
					outbound.protocol === 'blackhole' ? 'Blocked / unconfigured' :
					outbound.protocol === 'dns' ? 'DNS handler' : 'No server address'),
				via: outbound.streamSettings && outbound.streamSettings.sockopt && outbound.streamSettings.sockopt.dialerProxy ||
					outbound.proxySettings && outbound.proxySettings.tag || '' };
		});
		var balancers = (config.routing.balancers || []).map(function(balancer) {
			return { tag: balancer.tag, strategy: balancer.strategy && balancer.strategy.type || '',
				members: outbounds.filter(function(outbound) {
					return (balancer.selector || []).some(function(prefix) { return (outbound.tag || '').indexOf(prefix) === 0; });
				}).map(function(outbound) { return outbound.tag; }), fallback: balancer.fallbackTag || '' };
		});
		return { outbounds: outbounds, balancers: balancers,
			rules: (config.routing.rules || []).map(function(rule, index) {
				var conditions = Object.keys(rule).filter(function(key) {
					return ['type', 'ruleTag', 'outboundTag', 'balancerTag'].indexOf(key) < 0;
				}).map(function(key) {
					return key + ': ' + (Array.isArray(rule[key]) ? rule[key].join(', ') :
						typeof rule[key] === 'object' ? JSON.stringify(rule[key]) : String(rule[key]));
				});
				return { order: index + 1, name: rule.ruleTag || 'Rule ' + (index + 1),
					conditions: conditions, target: rule.outboundTag || rule.balancerTag || '',
					balancer: !!rule.balancerTag,
					disabled: (rule.inboundTag || []).indexOf(streamDisabledTag) >= 0 };
			}) };
	},
	read: function(raw) {
		var config = JSON.parse(raw);
		ensureStreaming(config);
		var stream = find(config.routing.rules, 'ruleTag', 'STREAMING-PROXY');
		var empty = stream.domain.length === 1 && stream.domain[0] === streamPlaceholder;
		var duration = config.observatory.probeInterval;
		if (!/^(?:\d+(?:\.\d+)?[hms])+$/.test(duration))
			throw new Error('Use a probe interval expressed in hours, minutes or seconds.');
		var seconds = 0;
		duration.replace(/(\d+(?:\.\d+)?)([hms])/g, function(_, amount, unit) {
			seconds += Number(amount) * { h: 3600, m: 60, s: 1 }[unit];
		});
		return {
			primary: JSON.stringify(find(config.outbounds, 'tag', 'proxy-main'), null, 2),
			backup: JSON.stringify(find(config.outbounds, 'tag', 'proxy-backup'), null, 2),
			stream: JSON.stringify(find(config.outbounds, 'tag', 'proxy-stream'), null, 2),
			stream_enabled: !empty && streamingScope(config, stream.inboundTag) ? '1' : '0',
			stream_domains: empty ? '' : stream.domain.join('\n'),
			probe_url: config.observatory.probeUrl,
			probe_interval: seconds,
			direct: find(config.routing.rules, 'ruleTag', 'FORCE-DIRECT').domain.join('\n'),
			proxy: find(config.routing.rules, 'ruleTag', 'FORCE-PROXY').domain.join('\n')
		};
	},
	build: function(raw, values, library) {
		if (library) values = Object.assign({}, values, this.bind(raw, library));
		var savedValues = this.read(raw);
		var config = JSON.parse(raw);
		var hadStreamRule = optional(config.routing.rules, 'ruleTag', 'STREAMING-PROXY');
		ensureStreaming(config);
		['primary', 'backup', 'stream'].forEach(function(name) {
			var tag = { primary: 'proxy-main', backup: 'proxy-backup', stream: 'proxy-stream' }[name];
			var outbound = JSON.parse(values[name]);
			if (!outbound || Array.isArray(outbound) || typeof outbound !== 'object' ||
				typeof outbound.protocol !== 'string' || !outbound.protocol)
				throw new Error('Enter a valid ' + name + ' outbound object.');
			outbound.tag = tag;
			var previous = find(config.outbounds, 'tag', tag);
			config.outbounds[config.outbounds.indexOf(previous)] = outbound;
		});
		var streamRule = find(config.routing.rules, 'ruleTag', 'STREAMING-PROXY');
		if (values.stream_enabled !== '0' && values.stream_enabled !== '1')
			throw new Error('Choose whether streaming routing is enabled.');
		streamRule.domain = domains(values.stream_domains, streamPlaceholder);
		if (values.stream_enabled === '1') {
			if (find(config.outbounds, 'tag', 'proxy-stream').protocol === 'blackhole')
				throw new Error('Configure the streaming node before enabling streaming routing.');
			if (streamRule.domain.length === 1 && streamRule.domain[0] === streamPlaceholder)
				throw new Error('Add at least one streaming domain or service preset.');
		}
		if (optional(config.inbounds, 'tag', streamDisabledTag))
			throw new Error('The reserved streaming disable tag is already used by an inbound.');
		// Preserve an active scope on ordinary saves; re-enable all configured proxy listeners.
		if (!hadStreamRule || values.stream_enabled !== savedValues.stream_enabled || values.stream_domains !== savedValues.stream_domains)
			streamRule.inboundTag = values.stream_enabled === '0' ? [streamDisabledTag] :
				streamingScope(config, streamRule.inboundTag) ? streamRule.inboundTag : streamingInbounds(config);
		var interval = Number(values.probe_interval);
		if (!Number.isInteger(interval) || interval < 1 || interval > 3600)
			throw new Error('Probe interval must be 1–3600 seconds.');
		if (!/^https?:\/\/\S+$/.test(values.probe_url))
			throw new Error('Enter an HTTP(S) probe URL.');
		config.observatory.probeUrl = values.probe_url;
		config.observatory.probeInterval = interval + 's';
		[['direct', 'FORCE-DIRECT'], ['proxy', 'FORCE-PROXY']].forEach(function(pair) {
			// An empty domain condition would make a field rule match unrelated traffic.
			find(config.routing.rules, 'ruleTag', pair[1]).domain = domains(values[pair[0]], 'domain:example-' + pair[0] + '.invalid');
		});
		return JSON.stringify(config, null, 2) + '\n';
	},
	streamingPreset: function(text) {
		var entries = (text || '').split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
		['geosite:netflix', 'geosite:primevideo', 'geosite:hbo', 'geosite:disney'].forEach(function(entry) {
			if (entries.indexOf(entry) < 0) entries.push(entry);
		});
		return entries.join('\n');
	},

	template: function(protocol, tag) {
		var outbound = { tag: tag, protocol: protocol, settings: {} };
		if (protocol === 'socks') outbound.settings = { address: '127.0.0.1', port: 1080 };
		if (protocol === 'vless') {
			outbound.settings = { address: '198.51.100.10', port: 443,
				id: '00000000-0000-0000-0000-000000000001', encryption: 'none', flow: 'xtls-rprx-vision' };
			outbound.streamSettings = { method: 'raw', security: 'reality', realitySettings: {
				serverName: 'www.example.com', fingerprint: 'chrome', password: 'REPLACE_WITH_PUBLIC_KEY', shortId: '0123456789abcdef' } };
		}
		if (protocol !== 'blackhole') {
			outbound.streamSettings = outbound.streamSettings || {};
			outbound.streamSettings.sockopt = { mark: 2 };
		}
		return JSON.stringify(outbound, null, 2);
	}
});
