// SPDX-License-Identifier: MIT
// Runtime status for the UI/RPC. Combines UCI config, netifd (ubus) interface
// state and the WireGuard handshake age. Never returns any secret.

'use strict';

import { connect } from 'ubus';
const _common = require('nordvpn.common');
const routing_confirmation = require('nordvpn.routing_transaction').confirmation;
const load_settings = _common.load_settings,
      validate_wg_key = _common.validate_wg_key,
      validate_interface = _common.validate_interface,
      validate_ipv4 = _common.validate_ipv4,
      PROBE_TIMEOUT = _common.PROBE_TIMEOUT,
      run = _common.run;

// Parse only complete, nonnegative integer observations. In particular, int()
// alone accepts a numeric prefix from malformed output and can fake health.
function counter(raw) {
	if (type(raw) != 'string' || !_common.full_match(raw, /^[0-9]+$/)) return null;
	let value = int(raw);
	return type(value) == 'int' && value >= 0 && value <= 9223372036854775807 ? value : null;
}

// Per-device transfer parser retained for callers/tests. One bad peer makes
// the whole total unavailable: a partial sum would under-report traffic.
function parse_transfer(out) {
	let rx = 0, tx = 0, seen = {};
	for (let line in split(out || '', '\n')) {
		if (line == '') continue;
		let parts = split(line, '\t');
		let r = counter(parts[1]), t = counter(parts[2]);
		if (length(parts) != 3 || !parts[0] || seen[parts[0]] || r == null || t == null) return null;
		if (r > 9223372036854775807 - rx || t > 9223372036854775807 - tx) return null;
		rx += r; tx += t; seen[parts[0]] = true;
	}
	return length(seen) ? { rx_bytes: rx, tx_bytes: tx } : null;
}

// `wg show all <field>` prepends the device name. Filter immediately to the
// netifd L3 devices of managed interfaces; never retain unrelated peers.
function parse_all(out, devices, transfer) {
	let rows = {}, invalid = {}, result = {}, peers = {};
	for (let line in split(out || '', '\n')) {
		let parts = split(line, '\t'), dev = parts[0];
		if (!devices[dev]) continue;
		if (!peers[dev]) peers[dev] = {};
		if (length(parts) != (transfer ? 4 : 3) || !parts[1] || peers[dev][parts[1]] ||
		    counter(parts[2]) == null || (transfer && counter(parts[3]) == null)) {
			invalid[dev] = true;
			continue;
		}
		peers[dev][parts[1]] = true;
		if (transfer) {
			if (!rows[dev]) rows[dev] = [];
			push(rows[dev], join('\t', slice(parts, 1)));
		} else if (counter(parts[2]) > (result[dev] || 0)) {
			result[dev] = counter(parts[2]);
		}
	}
	if (transfer)
		for (let dev, lines in rows) result[dev] = parse_transfer(join('\n', lines));
	for (let dev in keys(invalid)) result[dev] = null;
	return result;
}

// One short-lived collection per RPC request or scheduler tick. The optional
// timestamp lets the scheduler share its tick clock. No private-key-bearing
// WireGuard dump format is used. Failed sources stay independently unknown.
function collect_runtime(settings, at) {
	let snapshot = { at: at == null ? time() : at, interfaces: {}, netifd: null,
		handshakes: {}, transfers: {} };
	let managed = {}, devices = {}, ub = null;
	for (let s in (settings || [])) managed[s.interface] = true;
	try {
		ub = connect();
		let data = ub ? ub.call('network.interface', 'dump', {}) : null;
		if (type(data?.interface) == 'array') snapshot.netifd = data.interface;
	} catch (e) {
		// A missing/restarting netifd must not abort the other instances.
	}
	if (ub) {
		try { ub.disconnect(); } catch (e) { /* Already unavailable. */ }
	}
	for (let st in (snapshot.netifd || [])) {
		if (type(st) != 'object' || !managed[st.interface]) continue;
		// Linux device names may contain dots/hyphens, unlike our UCI names.
		let dev = st.l3_device == null || st.l3_device === '' ? st.interface : st.l3_device;
		if (!_common.full_match(dev, /^[A-Za-z0-9._-]{1,15}$/) || dev == '.' || dev == '..') continue;
		snapshot.interfaces[st.interface] = { up: st.up === true, device: dev,
			uptime: type(st.uptime) == 'int' && st.uptime >= 0 ? st.uptime : null };
		devices[dev] = true;
	}
	// No managed device observed (e.g. all disappeared): there is nothing to
	// filter, and shelling out cannot make the unknown netifd state healthy.
	if (!length(devices)) return snapshot;
	for (let field in [ 'latest-handshakes', 'transfer' ]) {
		try {
			let res = _common.run([ 'wg', 'show', 'all', field ], true);
			if (res?.code == 0 && type(res.stdout) == 'string')
				snapshot[field == 'transfer' ? 'transfers' : 'handshakes'] = parse_all(res.stdout, devices, field == 'transfer');
		} catch (e) {
			// Keep other observations even if one command cannot be executed.
		}
	}
	return snapshot;
}

// Egress probe: can traffic actually leave through the tunnel? Pings each
// target bound to the tunnel device (SO_BINDTODEVICE, so policy routing and
// the main table do not matter) and stops at the first reply. A live
// handshake only proves the server answers WireGuard; this proves it
// forwards. Returns { ok, target } — target is the host that answered.
function egress_probe(dev, targets) {
	if (!validate_interface(dev))
		return { ok: false, target: null };
	for (let t in (targets || [])) {
		if (!validate_ipv4(t))
			continue;
		let r = run([ 'ping', '-q', '-c', '1', '-W', '' + PROBE_TIMEOUT, '-I', dev, t ]);
		if (r.code == 0)
			return { ok: true, target: t };
	}
	return { ok: false, target: null };
}

function find_peer(uci, iface) {
	let found = null;
	uci.foreach('network', null, function(sec) {
		if (sec['.type'] && index(sec['.type'], 'wireguard_') == 0 && sec.interface == iface) {
			found = sec['.name'];
			return false;
		}
	});
	return found;
}

// Pure per-interface interpretation of a completed collection. Unknown netifd
// state remains disconnected; an up tunnel without a handshake is connecting.
function runtime_status(observed, iface) {
	let result = { state: 'disconnected', device: iface, uptime: null,
		transfer: null, latest_handshake_seconds: null };
	let net = observed.interfaces[iface];
	let ifup = net ? net.up : false;
	let l3dev = net ? net.device : iface;
	result.device = l3dev;
	if (ifup) {
		result.uptime = net.uptime;
		result.transfer = observed.transfers[l3dev] || null;
	}
	let ts = net ? observed.handshakes[l3dev] : null;
	let hs = ts > 0 ? max(0, observed.at - ts) : null;
	result.latest_handshake_seconds = hs;

	if (!ifup)
		result.state = 'disconnected';
	else if (hs == null)
		result.state = 'connecting';
	else if (hs <= 180)
		result.state = 'connected';
	else
		result.state = 'degraded';

	return result;
}

// Build the runtime status object for one instance ('main' by default).
// `next_run` is filled in by the caller/scheduler. `settings` may pass the
// instance's already-loaded settings. A supplied snapshot makes construction
// free of runtime commands/connections; legacy individual callers collect once.
function status(uci, instance, settings, snapshot) {
	let s = settings || load_settings(uci, instance);
	let iface = s.interface;

	let has_key = validate_wg_key(uci.get('network', iface, 'private_key')) != null;
	let peer = find_peer(uci, iface);
	let endpoint_host = peer ? uci.get('network', peer, 'endpoint_host') : null;
	let endpoint_port = peer ? uci.get('network', peer, 'endpoint_port') : null;

	let result = {
		routing_application: routing_confirmation(uci, s.name),
		instance: s.name,
		configured: has_key,
		// Administrative master switch, distinct from the runtime state: a
		// disabled instance is deliberately down, not merely disconnected. The UI
		// keys button visibility (Enable vs Reconnect/Disable) on this.
		enabled: s.enabled,
		// A pinned server disables rotation, so the UI hides "Rotate now".
		fixed: (s.fixed_server && s.fixed_server != '') ? true : false,
		state: has_key ? 'disconnected' : 'not_configured',
		interface: iface,
		location: {
			country: uci.get('network', iface, 'nordvpn_country_code'),
			// Prefer the connected server's actual location (stored on every
			// apply/rotate) over the configured selection, which is empty when
			// the city is on Automatic.
			city: uci.get('network', iface, 'nordvpn_location') ||
				uci.get('network', iface, 'nordvpn_city_code')
		},
		gateway: peer ? uci.get('network', peer, 'nordvpn_gateway') : null,
		endpoint: endpoint_host ? (endpoint_host + ':' + (endpoint_port || '')) : null,
		latest_handshake_seconds: null,
		// Tunnel device (for the egress probe), seconds since netifd brought
		// the interface up, and bytes through the tunnel since then.
		device: null,
		uptime: null,
		transfer: null,
		rotation: {
			enabled: s.rotation_enabled,
			mode: s.rotation_mode,
			interval: s.rotation_interval,
			time: s.rotation_time,
			next_run: null
		}
	};

	if (!has_key)
		return result;

	return { ...result, ...runtime_status(snapshot || collect_runtime([ s ]), iface) };
}

return { status, runtime_status, collect_runtime, parse_transfer, egress_probe };
