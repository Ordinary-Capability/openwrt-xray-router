'use strict';
'require baseclass';

function find(items, key, value) {
	var matches = (items || []).filter(function(item) { return item[key] === value; });
	if (matches.length !== 1)
		throw new Error('Expected one ' + value + '. Merge the current project configuration first.');
	return matches[0];
}

return baseclass.extend({
	read: function(raw) {
		var config = JSON.parse(raw);
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
			probe_url: config.observatory.probeUrl,
			probe_interval: seconds,
			direct: find(config.routing.rules, 'ruleTag', 'FORCE-DIRECT').domain.join('\n'),
			proxy: find(config.routing.rules, 'ruleTag', 'FORCE-PROXY').domain.join('\n')
		};
	},
	build: function(raw, values) {
		var config = JSON.parse(raw);
		['primary', 'backup'].forEach(function(name) {
			var tag = name === 'primary' ? 'proxy-main' : 'proxy-backup';
			var outbound = JSON.parse(values[name]);
			if (!outbound || Array.isArray(outbound) || typeof outbound !== 'object' ||
				typeof outbound.protocol !== 'string' || !outbound.protocol)
				throw new Error('Enter a valid ' + name + ' outbound object.');
			outbound.tag = tag;
			var previous = find(config.outbounds, 'tag', tag);
			config.outbounds[config.outbounds.indexOf(previous)] = outbound;
		});
		var interval = Number(values.probe_interval);
		if (!Number.isInteger(interval) || interval < 1 || interval > 3600)
			throw new Error('Probe interval must be 1–3600 seconds.');
		if (!/^https?:\/\/\S+$/.test(values.probe_url))
			throw new Error('Enter an HTTP(S) probe URL.');
		config.observatory.probeUrl = values.probe_url;
		config.observatory.probeInterval = interval + 's';
		[['direct', 'FORCE-DIRECT'], ['proxy', 'FORCE-PROXY']].forEach(function(pair) {
			var domains = values[pair[0]].split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
			// An empty domain condition would make a field rule match unrelated traffic.
			if (!domains.length) domains = ['domain:example-' + pair[0] + '.invalid'];
			domains = domains.map(function(s) { return s.indexOf(':') < 0 ? 'domain:' + s : s; });
			if (domains.some(function(s) { return /\s/.test(s); })) throw new Error('Use one domain rule per line.');
			find(config.routing.rules, 'ruleTag', pair[1]).domain = domains;
		});
		return JSON.stringify(config, null, 2) + '\n';
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
