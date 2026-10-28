// SPDX-License-Identifier: MIT
// Credential storage and transactional WireGuard apply. Shared by the rpcd
// `apply`/`set_credentials` methods and the procd reload path.

'use strict';

import { srand } from 'math';
import { readfile } from 'fs';
import { cursor } from 'uci';
const _common = require('nordvpn.common');
const FIXED_ADDRESS = _common.FIXED_ADDRESS,
      DEFAULT_PORT = _common.DEFAULT_PORT,
      DEFAULT_KEEPALIVE = _common.DEFAULT_KEEPALIVE,
      APPLY_STATUS_FILE = _common.APPLY_STATUS_FILE,
      APPLY_MAX_RUNTIME = _common.APPLY_MAX_RUNTIME,
      load_settings = _common.load_settings,
      cache_file_path = _common.cache_file_path,
      validate_interface = _common.validate_interface,
      validate_instance = _common.validate_instance,
      validate_wg_key = _common.validate_wg_key,
      validate_nordvpn_host = _common.validate_nordvpn_host,
      validate_port = _common.validate_port,
      managed_interface = _common.managed_interface,
      iso_ts = _common.iso_ts,
      run = _common.run;
const _cache = require('nordvpn.cache');
const read_cache = _cache.read_cache;
const _select = require('nordvpn.select');
const selection_candidates = _select.selection_candidates,
      by_hostname = _select.by_hostname,
      pick = _select.pick,
      order_candidates = _select.order_candidates;
const _routing = require('nordvpn.routing');
const enforce_routing = _routing.enforce;
const _transaction = require('nordvpn.routing_transaction');
const routing_adapters = _transaction.adapters;
function routing_plan(uci, s, edit) {
	return _transaction.plan(uci, function(desired, tables) {
		if (edit) edit(desired);
		let result = enforce_routing(desired, s, { rt_tables: tables });
		for (let note in result.notes)
			if (match(note, /not installed|not locked|DNS is already locked|domain steering needs|excluded domains need/)) die(note);
		return result;
	});
}
const _history = require('nordvpn.history');
const record_event = _history.record_event;
const _creds = require('nordvpn.credentials');
const _mutation = require('nordvpn.mutation');

// Locate the managed peer section (type wireguard_<iface>, interface=<iface>).
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

// Store credentials for `instance` (its bank entry; see nordvpn.credentials)
// and push them to every instance sharing that entry. Kept for scripts that
// set credentials per instance. Returns { ok, credential, name } or { error }.
function set_credentials(uci, token, instance) {
	let iface = validate_interface(load_settings(uci, instance).interface);
	if (!iface)
		return { error: 'invalid interface name' };
	if (!managed_interface(uci, iface))
		return { error: 'interface ' + iface + ' is not managed by nordvpn' };
	return _creds.set(uci, token, null, null, instance);
}

// Snapshot the current peer so a failed rotation can be rolled back.
function current_peer(uci, iface) {
	let peer = find_peer(uci, iface);
	if (!peer)
		return null;
	return {
		public_key: uci.get('network', peer, 'public_key'),
		endpoint_host: uci.get('network', peer, 'endpoint_host'),
		endpoint_port: uci.get('network', peer, 'endpoint_port'),
		gateway: uci.get('network', peer, 'nordvpn_gateway')
	};
}

// Restore a peer snapshot taken by current_peer() (no commit).
function restore_peer(uci, iface, saved) {
	if (!saved)
		return;
	let peer = find_peer(uci, iface);
	if (!peer)
		peer = uci.add('network', 'wireguard_' + iface);
	uci.set('network', peer, 'interface', iface);
	if (saved.public_key)
		uci.set('network', peer, 'public_key', saved.public_key);
	if (saved.endpoint_host)
		uci.set('network', peer, 'endpoint_host', saved.endpoint_host);
	if (saved.endpoint_port)
		uci.set('network', peer, 'endpoint_port', saved.endpoint_port);
	if (saved.gateway)
		uci.set('network', peer, 'nordvpn_gateway', saved.gateway);
}

// Exclusion key for the currently connected server. The stamped nordvpn_gateway
// is the intended key; fall back to endpoint_host so a peer written without the
// stamp (hand-made, or a restored null-gateway snapshot) is still recognized.
// Pure/testable.
function current_key(saved) {
	return saved ? (saved.gateway || saved.endpoint_host || null) : null;
}

// Write the interface + peer for the chosen relay (no commit). The relay comes
// from the cache file, so its endpoint and key are re-validated here before
// they reach /etc/config/network; the endpoint must be a NordVPN host. Returns
// false (nothing written) if invalid. `opts.keep_iface` leaves the routing
// table and MTU as they are: a rotation only changes the server, and must not
// apply table or MTU edits that were saved but never applied — a table that
// enforce() has not set up yet would leave the LAN's traffic unrouted.
function write_relay(uci, iface, relay, s, opts) {
	if (!relay || !validate_nordvpn_host(relay.hostname) || !validate_wg_key(relay.public_key) ||
	    (relay.port != null && !validate_port(relay.port)))
		return false;

	uci.set('network', iface, 'proto', 'wireguard');
	uci.set('network', iface, 'vpn_type', 'nordvpn');
	uci.set('network', iface, 'auto', '1');
	uci.set('network', iface, 'addresses', [ FIXED_ADDRESS ]);

	if (!(opts && opts.keep_iface)) {
		if (s.routing_table && s.routing_table != '') {
			uci.set('network', iface, 'ip4table', s.routing_table);
			uci.set('network', iface, 'ip6table', s.routing_table);
		} else {
			uci.delete('network', iface, 'ip4table');
			uci.delete('network', iface, 'ip6table');
		}

		// Optional MTU override; empty falls back to netifd's WireGuard default.
		if (s.mtu)
			uci.set('network', iface, 'mtu', '' + s.mtu);
		else
			uci.delete('network', iface, 'mtu');
	}

	uci.set('network', iface, 'nordvpn_location', relay.location);
	// Stamp the ACTUAL server's country/city: with a location set the
	// connected relay may sit in any of the set's countries, and the status
	// must reflect where the tunnel really exits (exit country for multihop).
	uci.set('network', iface, 'nordvpn_country_code', relay.exit_country_code || s.country_code);
	uci.set('network', iface, 'nordvpn_city_code', relay.location || s.city_code);
	uci.set('network', iface, 'nordvpn_last_applied', iso_ts());

	let peer = find_peer(uci, iface);
	if (!peer)
		peer = uci.add('network', 'wireguard_' + iface);
	uci.set('network', peer, 'interface', iface);
	// Managed routing stamps the interface; the peer's allowed-IPs routes
	// (netifd-installed, into ip4table when set) follow it.
	if (uci.get('network', iface, 'nordvpn_managed_routing') == '1')
		uci.set('network', peer, 'route_allowed_ips', '1');
	uci.set('network', peer, 'public_key', relay.public_key);
	uci.set('network', peer, 'endpoint_host', relay.hostname);
	uci.set('network', peer, 'endpoint_port', '' + (relay.port || DEFAULT_PORT));
	uci.set('network', peer, 'persistent_keepalive', '' + DEFAULT_KEEPALIVE);
	uci.set('network', peer, 'allowed_ips', [ '0.0.0.0/0', '::/0' ]);
	uci.set('network', peer, 'nordvpn_gateway', relay.hostname);
	return true;
}

// Bring the managed interface up. iface is whitelist-validated, so the argv is
// injection-safe (no shell).
function bring_up(iface) {
	return routing_adapters.run([ 'timeout', '15', 'ifup', iface ]).code == 0;
}

// Newest WireGuard handshake age, or null for missing tools/device/handshake.
function handshake_age(iface) {
	let res = routing_adapters.run([ 'timeout', '5', 'wg', 'show', iface, 'latest-handshakes' ], true);
	if (res.code != 0)
		return null;
	let best = 0;
	for (let line in split(trim(res.stdout || ''), '\n')) {
		let parts = split(line, '\t');
		if (length(parts) >= 2) {
			let t = int(parts[1]);
			if (t > best)
				best = t;
		}
	}
	if (best == 0)
		return null;
	let age = time() - best;
	return age < 0 ? 0 : age;
}

// Wait up to `seconds` for a fresh handshake. Missing wg is a failure.
// Sleeps in-process: spawning `sleep` through a shell every second only adds
// two process starts per second of waiting.
function verify_handshake(iface, seconds) {
	for (let i = 0; i < seconds; i++) {
		sleep(1000);
		let age = handshake_age(iface);
		if (age != null && age < 180)
			return true;
	}
	return false;
}

// Why netifd could not create the tunnel device, as a user-facing hint, or
// null. `st` is the interface's netifd status object. A WireGuard section
// that netifd reports as proto 'none' means its wireguard protocol handler is
// not loaded: netifd reads handlers only at startup, so installing
// wireguard-tools without restarting it leaves every tunnel down while
// `ifup` still succeeds. Pure.
function netifd_hint(st) {
	if (type(st) != 'object' || st.up)
		return null;
	if (st.proto == 'none')
		return 'netifd has not loaded the WireGuard protocol handler; run /etc/init.d/network restart (or reboot) after installing the packages';
	for (let e in (st.errors || []))
		if (e && e.code == 'NO_DEVICE')
			return 'netifd could not create the WireGuard device; check that kmod-wireguard matches the running kernel (lsmod | grep wireguard)';
	return null;
}

// netifd_hint() for the live interface, or null when it cannot be read.
function tunnel_hint(iface) {
	let r = run([ 'ubus', 'call', 'network.interface.' + iface, 'status' ]);
	if (r.code != 0)
		return null;
	try {
		return netifd_hint(json(r.stdout));
	} catch (e) {
		return null;
	}
}

// The IPv4 elements in `nft list set` output (plain output: no dependency on
// nft's JSON support), all these sets hold. Pure/testable.
function parse_nft_elements(text) {
	let m = match(text || '', /elements = \{([^}]*)\}/s);
	let ips = [];
	for (let t in (m ? split(m[1], /[ ,\t\n]+/) : []))
		if (_common.validate_ipv4(t) && index(ips, t) < 0)
			push(ips, t);
	return ips;
}

// Elements of the fw4 nft sets `names`, as { name: [ IPv4 ] }. Empty
// off-device.
function nft_set_elements(names) {
	let out = {};
	for (let name in names) {
		if (!_common.full_match(name, /^nv_[A-Za-z0-9_]+_(dom|byp)$/))
			continue;
		let r = run([ 'nft', 'list', 'set', 'inet', 'fw4', name ], true);
		let ips = (r.code == 0) ? parse_nft_elements(r.stdout) : [];
		if (length(ips))
			out[name] = ips;
	}
	return out;
}

// Execute a detached plan under mutation.configuration(); returns structured
// outcome, including the original failure and any scoped restoration failures.
function commit_routing(uci, routing) {
	return _transaction.execute(uci, routing);
}

const TUNNEL_LOCK_WAIT = 60;

function activation(iface, up) {
	let st = _transaction.interface_state(iface);
	if (!st) die('could not snapshot runtime state for ' + iface);
	return { stage: (up ? 'ifup:' : 'ifdown:') + iface, up: !!up, previous_up: !!st.up,
		argv: [ up ? 'ifup' : 'ifdown', iface ], restore_argv: [ st.up ? 'ifup' : 'ifdown', iface ] };
}
function connection_plan(uci, iface, edit, up) {
	let p = _transaction.plan(uci, function(desired) { edit(desired); return { interface: iface }; });
	p.reloads = []; // ifup/ifdown applies this interface; no global netifd reload.
	p.activation = activation(iface, up);
	return p;
}
function connect_one_result(uci, iface, relay, s, opts) {
	let result = _mutation.configuration(function(fresh) {
		let p = connection_plan(fresh, iface, function(desired) {
			if (!write_relay(desired, iface, relay, s, opts)) die('invalid relay');
		}, true);
		return commit_routing(fresh, p);
	}, s.mutation_wait || 0);
	return result;
}
// Compatibility for local scripts; application/rotation consume full outcomes.
function connect_one(uci, iface, relay, s, opts) { return connect_one_result(uci, iface, relay, s, opts).ok; }
function restore_connection(iface, saved, wait) {
	return _mutation.configuration(function(fresh) {
		return commit_routing(fresh, connection_plan(fresh, iface,
			function(desired) { restore_peer(desired, iface, saved); }, true));
	}, wait || 0);
}

// What the running tunnel is built from: the interface and peer options
// netifd and wireguard use (stamps such as the location are left out). Equal
// fingerprints before and after writing a relay mean the tunnel would come
// back exactly as it is, so restarting it would only drop connections.
const IFACE_KEYS = [ 'proto', 'private_key', 'addresses', 'ip4table', 'ip6table', 'mtu' ];
const PEER_KEYS = [ 'public_key', 'endpoint_host', 'endpoint_port', 'persistent_keepalive',
	'allowed_ips', 'route_allowed_ips' ];

function tunnel_fingerprint(uci, iface) {
	let peer = find_peer(uci, iface);
	let fp = {};
	for (let k in IFACE_KEYS)
		fp['i.' + k] = uci.get('network', iface, k);
	for (let k in PEER_KEYS)
		fp['p.' + k] = peer ? uci.get('network', peer, k) : null;
	return sprintf('%J', fp);
}

// Can a managed tunnel put routes into the main table? A peer with
// route_allowed_ips and no ip4table adds 0.0.0.0/0 there, and netifd adds
// routes with NLM_F_REPLACE, so it replaces the WAN's default route (same
// metric 0) while netifd still lists the WAN's as installed. That is how the
// WAN default goes missing; with every tunnel in its own table it cannot.
function wan_default_at_risk(uci) {
	for (let n in _common.list_instances(uci)) {
		let iface = validate_interface(load_settings(uci, n).interface);
		if (!iface || !managed_interface(uci, iface))
			continue;
		let peer = find_peer(uci, iface);
		if (!peer || uci.get('network', peer, 'route_allowed_ips') != '1')
			continue;
		let t = uci.get('network', iface, 'ip4table') || '';
		if (t == '' || t == 'main' || t == '254')
			return true;
	}
	return false;
}

// Take the instance's tunnel lock (see nordvpn.common.tunnel_lock_path),
// waiting up to `wait` seconds for an operation that holds it to finish.
// Ownership is descriptor-based and never expires while its holder is live.
function acquire_tunnel_lock(instance, s, wait) {
	return _mutation.acquire([ validate_instance(instance) || 'main' ], wait);
}

// How long an apply waits for a running rotation of the same instance. Well
// inside APPLY_MAX_RUNTIME: four candidates at MAX_VERIFY_TIMEOUT plus this
// still fit.

// A global netifd reload has been observed (OpenWrt 24.10) to remove the
// kernel's main IPv4 default route while netifd still reports it as
// installed, cutting WAN connectivity. Self-heal: when the kernel lost the
// default but netifd claims a gateway route on an up interface, re-add it.
function restore_wan_default() {
	// The reload applies asynchronously; the route can disappear a moment
	// after an immediate check passes, so probe a few times.
	for (let attempt = 0; attempt < 3; attempt++) {
		sleep(2000);
		let r = run([ 'ip', '-4', 'route', 'show', 'default' ]);
		if (r.code != 0)
			return false;
		if (length(trim(r.stdout || '')) > 0)
			continue;
		let d = run([ 'ubus', 'call', 'network.interface', 'dump' ]);
		if (d.code != 0)
			return false;
		let data;
		try {
			data = json(d.stdout);
		} catch (e) {
			return false;
		}
		for (let ifc in ((data ? data.interface : null) || [])) {
			if (!ifc.up || !ifc.l3_device)
				continue;
			for (let rt in (ifc.route || [])) {
				if (rt.target == '0.0.0.0' && rt.mask == 0 && rt.nexthop && rt.nexthop != '0.0.0.0') {
					let res;
					try {
						res = _mutation.configuration(function(fresh) {
							let now = run([ 'ip', '-4', 'route', 'show', 'default' ]);
							if (now.code != 0 || trim(now.stdout || '') != '')
								return now;
							return run([ 'ip', 'route', 'add', 'default', 'via', rt.nexthop, 'dev', ifc.l3_device ]);
						}, TUNNEL_LOCK_WAIT);
					} catch (e) {
						return false;
					}
					if (res.code != 0)
						return false;
					// Only claim success once the route really went in.
					_common.log('restored missing WAN default route via ' + rt.nexthop +
						' on ' + ifc.l3_device);
				}
			}
		}
	}
	return true;
}

// The candidate list with the server `keep` moved to the front, when it is
// in the list at all; the rest keep their order. Pure/testable.
function prefer_current(list, keep) {
	if (!keep || type(list) != 'array')
		return list;
	let cur = filter(list, (r) => r.hostname == keep);
	return length(cur) ? [ cur[0], ...filter(list, (r) => r.hostname != keep) ] : list;
}

// restore_wan_default() without blocking the caller: rpcd serves one call at
// a time and the probe sleeps for six seconds, so the synchronous paths
// (routing-only apply, disable, delete) hand it to a detached worker.
function restore_wan_default_async() {
	run([ 'sh', '-c', '/usr/bin/nordvpn-apply --restore-wan >/dev/null 2>&1 &' ]);
}

// The success result for `relay`, when the tunnel can stay exactly as it is:
// it is the server already connected, writing it changed nothing the tunnel
// is built from (`before` is tunnel_fingerprint() from the start of the
// apply), and its handshake is fresh. The stamps write_relay() refreshed are
// committed; there is no ifup, so no connection through the tunnel drops.
// null when the tunnel has to be (re)started.
function keep_running_inner(uci, iface, relay, s, before) {
	let compatible = false;
	let p = _transaction.plan(uci, function(desired) {
		compatible = write_relay(desired, iface, relay, s) && tunnel_fingerprint(desired, iface) == before;
		return { interface: iface };
	});
	if (!compatible) return null;
	let age = handshake_age(iface);
	if (age == null || age >= 180) return null;
	p.reloads = []; // only metadata stamps changed; keep the established tunnel.
	let result = commit_routing(uci, p);
	if (!result.ok) return { ...result, state: 'failure' };
	return { ...result, state: 'success', interface: iface, gateway: relay.hostname,
		endpoint: relay.hostname + ':' + (relay.port || DEFAULT_PORT), restarted: false };
}

function keep_running(uci, iface, relay, s, before) {
	return _mutation.configuration(function(fresh) {
		return keep_running_inner(fresh, iface, relay, s, before);
	}, s.mutation_wait || 0);
}

// Apply the persisted configuration. A fixed server is applied once; an
// automatic selection tries several candidates until one completes a handshake
// (NordVPN publishes dead endpoints), rolling back to the previous working peer
// if none do. Bounded so the rpc call stays within timeout. Unless `source` is
// 'reconnect' (the user asked for a fresh connection), the server the tunnel
// is on is tried first while it still matches the selection, so saving
// anything but the location keeps the exit IP and the connections on it.
function apply_inner(uci, instance, source, lock_wait) {
	let cache = read_cache(cache_file_path(load_settings(cursor(), instance)));
	let prepared = _mutation.configuration(function(uci) {
		let invalid = _mutation.validate_owner(uci, instance);
		if (invalid)
			return { state: 'failure', error: invalid };
		let s = load_settings(uci, instance);
		s.mutation_wait = lock_wait;
		let iface = validate_interface(s.interface);
		if (!iface)
			return { state: 'failure', error: 'invalid interface name' };
		if (!managed_interface(uci, iface))
			return { state: 'failure', error: 'interface ' + iface + ' is not managed by nordvpn' };
		// Saving settings must not implicitly turn a deliberately disabled tunnel
		// back on. Explicit Enable/Reconnect and external apply calls retain their
		// historical behavior.
		if (source == 'save' && !s.enabled)
			return { state: 'disabled', interface: iface, restarted: false };
		// What the running tunnel is built from, before anything below changes it.
		let before = tunnel_fingerprint(uci, iface);
		// The instance's credentials may have changed in the bank or been switched
		// to another entry since the last apply: bring the interface key in line.

		if (!validate_wg_key(uci.get(_creds.PKG, _creds.instance_credential(uci, instance), 'private_key')))
			return { state: 'failure', error: 'no credentials configured' };
		if (!cache)
			return { state: 'failure', error: 'server list not available; refresh the cache first' };

		let enable = !s.enabled;
		s.enabled = true;
		let routing = routing_plan(uci, s, function(desired) {
			let key = validate_wg_key(uci.get(_creds.PKG, _creds.instance_credential(uci, instance), 'private_key'));
			if (!key) die('no credentials configured');
			if (desired.get('network', iface, 'private_key') != key) {
				desired.set('network', iface, 'private_key', key);
				desired.set('network', iface, 'addresses', [ FIXED_ADDRESS ]);
				desired.delete('network', iface, 'nordvpn_token');
			}
			if (enable) desired.set('nordvpn', s.name, 'enabled', '1');
		});
		let applied = commit_routing(uci, routing);
		if (!applied.ok) return { ...applied, state: 'failure' };

		for (let note in routing.notes)
			_common.log('routing: ' + note);

		return { settings: s, before: before, cache: cache };
	}, lock_wait);
	if (!prepared.settings)
		return prepared;
	let s = prepared.settings, before = prepared.before;
	let iface = s.interface;
	uci = cursor();

	srand(time());
	let saved = current_peer(uci, iface);
	let keep = (source != 'reconnect') ? current_key(saved) : null;

	if (s.fixed_server && s.fixed_server != '') {
		let relay = by_hostname(cache, s.fixed_server);
		if (!relay)
			return { state: 'failure', error: 'configured server not found in cache' };
		if (keep && relay.hostname == keep) {
			let kept = keep_running(uci, iface, relay, s, before);
			if (kept)
				return kept;
		}
		let connection = connect_one_result(uci, iface, relay, s);
		if (!connection.ok) return { ...connection, state: 'failure', interface: iface };
		let up = true;
		let ok = up && verify_handshake(iface, s.verify_timeout);
		return {
			state: ok ? 'success' : (up ? 'partial_failure' : 'failure'),
			interface: iface, gateway: relay.hostname,
			endpoint: relay.hostname + ':' + (relay.port || DEFAULT_PORT),
			restarted: up,
			error: ok ? null : (tunnel_hint(iface) || 'the selected server did not respond')
		};
	}

	let list = selection_candidates(cache, s);
	if (length(list) == 0)
		return { state: 'failure', error: 'no matching server found for the current selection' };
	list = prefer_current(order_candidates(list, s.selection), keep);
	if (keep && list[0].hostname == keep) {
		let kept = keep_running(uci, iface, list[0], s, before);
		if (kept)
			return kept;
	}

	let tries = length(list);
	if (tries > 4)
		tries = 4;
	for (let i = 0; i < tries; i++) {
		let relay = list[i];
		let connection = connect_one_result(uci, iface, relay, s);
		if (!connection.ok) return { ...connection, state: 'failure', interface: iface };
		if (verify_handshake(iface, s.verify_timeout))
			return {
				state: 'success', interface: iface, gateway: relay.hostname,
				endpoint: relay.hostname + ':' + (relay.port || DEFAULT_PORT),
				restarted: true
			};
	}

	let hint = tunnel_hint(iface);
	let restored = saved ? restore_connection(iface, saved, lock_wait) : null;
	return { state: 'failure', restored: !!restored?.ok, rollback: restored,
		error: (hint || 'could not reach any server for the current selection') +
			(restored ? (restored.ok ? '; restored the previous connection' : '; restoration failed: ' + restored.error) : '') };
}

// What started an apply, recorded as the history entry's `reason`: the UI's
// Reconnect and Enable buttons, a Save that needs a reconnect, or anything
// else (a script, the CLI, a bare ubus call), which counts as 'external'.
const APPLY_SOURCES = [ 'reconnect', 'enable', 'save', 'external' ];

function apply_source(source) {
	return (index(APPLY_SOURCES, source) >= 0) ? source : 'external';
}

// History entry for an apply outcome. Pure/testable.
function apply_event(res, source) {
	let reason = apply_source(source);
	if (res && res.state == 'disabled')
		return { type: 'disabled' };
	if (res && res.state == 'success')
		return { type: 'connect', fields: { server: res.gateway, reason } };
	return { type: 'connect_failed', fields: {
		server: res ? res.gateway : null,
		reason,
		error: (res && res.error) ? res.error : 'unknown error',
		detail: (res && res.restored) ? 'restored the previous server' : null
	} };
}

// The tunnel lock keeps a scheduled or watchdog rotation from rewriting the
// peer and restarting the tunnel halfway through this apply (or the other
// way round); a rotation in progress is waited for, up to `lock_wait`
// seconds (default TUNNEL_LOCK_WAIT).
function apply(uci, instance, source, lock_wait) {
	instance = validate_instance(instance) || 'main';
	let migration = _creds.migrate(cursor());
	if (type(migration) == 'object' && migration.error)
		return { ...migration, state: 'failure' };
	let owner = acquire_tunnel_lock(instance, null,
		(type(lock_wait) == 'int') ? lock_wait : TUNNEL_LOCK_WAIT);
	if (owner.busy)
		return { ...owner, state: 'failure' };
	let res, at_risk = false;
	try {
		uci = cursor();
		if (uci.get('nordvpn', instance) == null)
			res = { state: 'failure', error: 'no such instance' };
		else {
			at_risk = wan_default_at_risk(uci);
			res = apply_inner(uci, instance, source, (type(lock_wait) == 'int') ? lock_wait : TUNNEL_LOCK_WAIT);
		}
	} catch (e) {
		res = { state: 'failure', busy: index('' + e, 'busy') >= 0, error: 'apply error: ' + e };
	}
	_mutation.release(owner.locks);
	if (res.busy)
		return res;
	if (at_risk || wan_default_at_risk(cursor()))
		restore_wan_default();
	let ev = apply_event(res, source);
	record_event(instance, ev.type, ev.fields);
	return res;
}

// Why the running tunnel cannot take the saved settings without a reconnect,
// or null when it can. Routing, firewall and DNS objects are reconciled on
// their own, and so is the routing table (see apply_routing()), but the MTU
// is part of WireGuard's own interface config: netifd restarts the tunnel
// for it, so that needs a full apply, which verifies the handshake after.
function reconnect_reason(uci, iface, s) {
	if (!s.enabled)
		return 'instance is disabled';
	if (!validate_wg_key(uci.get('network', iface, 'private_key')))
		return 'no credentials configured';
	let peer = find_peer(uci, iface);
	if (!peer)
		return 'no server applied yet';
	if (s.fixed_server && s.fixed_server != '' &&
	    (uci.get('network', peer, 'nordvpn_gateway') ||
	     uci.get('network', peer, 'endpoint_host') || '') != s.fixed_server)
		return 'server changed';
	if (uci.get('network', iface, 'auto') == '0')
		return 'interface is disabled';
	if ((uci.get('network', iface, 'mtu') || '') != (s.mtu ? '' + s.mtu : ''))
		return 'MTU changed';
	return null;
}

// Point the interface at the instance's routing table (no commit). netifd
// treats ip4table/ip6table as address-and-route settings, not as part of the
// WireGuard config: on reload it moves the tunnel's addresses and routes into
// the new table without restarting the tunnel. True on change.
function set_iface_table(uci, iface, table) {
	table = table || '';
	if ((uci.get('network', iface, 'ip4table') || '') == table &&
	    (uci.get('network', iface, 'ip6table') || '') == table)
		return false;
	if (table != '') {
		uci.set('network', iface, 'ip4table', table);
		uci.set('network', iface, 'ip6table', table);
	} else {
		uci.delete('network', iface, 'ip4table');
		uci.delete('network', iface, 'ip6table');
	}
	return true;
}

// Apply routing-only changes (steered/excluded devices, networks, domains,
// kill switch, IPv6 block, DNS, the routing table) without touching the
// tunnel: no peer rewrite and no ifup, so connections through the VPN
// survive. The steering rules and MARK rules are plain netifd/fw4 config, and
// a netifd reload leaves the unchanged interface alone. Returns
// { ok, routing_only: true } or { needs_reconnect: true, reason } when only a
// full apply() can do it.
function apply_routing_inner(uci, instance) {
	let s = load_settings(uci, instance);
	let iface = validate_interface(s.interface);
	if (!iface)
		return { error: 'invalid interface name' };
	if (!managed_interface(uci, iface))
		return { error: 'interface ' + iface + ' is not managed by nordvpn' };
	// A save while disabled only changes stored preferences. Keep its routing
	// protections released and report the save as handled without reconnecting.
	if (!s.enabled)
		return { ok: true, routing_only: true, disabled: true, interface: iface };

	let reason = reconnect_reason(uci, iface, s);
	if (reason)
		return { needs_reconnect: true, reason: reason };
	let at_risk = wan_default_at_risk(uci);

	let res;
	try {
		let routing = routing_plan(uci, s, function(desired) { set_iface_table(desired, iface, s.routing_table); });
		let applied = commit_routing(uci, routing);
		if (!applied.ok) return { ...applied, routing_only: true, interface: iface };
		if (applied.changed && index(routing.reloads, 'network') >= 0 &&
		    (at_risk || wan_default_at_risk(cursor())))
			restore_wan_default_async();
		for (let note in routing.notes)
			_common.log('routing: ' + note);
		res = { ...applied, routing_only: true, interface: iface, notes: routing.notes };
	} catch (e) {
		res = { ok: false, changed: false, stage: 'plan', error: 'routing plan failed: ' + e };
	}
	return res;
}

// ── Asynchronous tunnel jobs ─────────────────────────────────────────
// Keep the tunnel slot separate from cache/updater work and future probes.
const _jobs = require('nordvpn.jobs');
const tunnel_jobs = _jobs.create(APPLY_STATUS_FILE);

function write_apply_status(status) { return tunnel_jobs.write(status); }
function read_apply_status() { return tunnel_jobs.read(); }
function apply_running(st, now) { return tunnel_jobs.active(st, now); }
// Optional exact-ID lookup; the one-argument form is the legacy test clock.
function apply_status_report(now, id) { return tunnel_jobs.status(id, now); }

function job_max_runtime(kind, instance) {
	return kind == 'rotate'
		? _common.rotation_max_runtime(load_settings(cursor(), instance)) : APPLY_MAX_RUNTIME;
}

// Detached workers must claim the ID supplied by their launcher. Manual CLI
// invocations reserve their own job, then use exactly the same lifecycle.
function run_job(instance, kind, work, id, context) {
	let name = validate_instance(instance) || 'main';
	if (!id) {
		let reservation = tunnel_jobs.reserve(name, kind, context, job_max_runtime(kind, name));
		if (!reservation.started)
			return reservation.error && !reservation.busy ? { error: reservation.error } :
				{ skipped: true, reason: kind == 'apply' ? 'apply already running' : 'an apply or rotation is already running' };
		id = reservation.apply.id;
	}
	return tunnel_jobs.run(id, name, kind, work);
}

function run_apply(instance, source, id) {
	return run_job(instance, 'apply', function(name, context) {
		return apply(cursor(), name, context.source);
	}, id, { source: apply_source(source) });
}

function start_job(instance, kind, arg) {
	let name = validate_instance(instance);
	if (!name) return { error: 'invalid instance name' };
	if (kind != 'apply' && kind != 'rotate') return { error: 'unknown job' };
	let source = kind == 'apply' ? apply_source(arg) : null;
	return tunnel_jobs.start(name, kind, { source: source }, job_max_runtime(kind, name), function(st) {
		// Instance, source and kernel-generated UUID contain no shell syntax.
		let command = kind == 'apply' ? '/usr/bin/nordvpn-apply ' : '/usr/bin/nordvpn-rotate --job ';
		command += name + (source ? ' ' + source : '') + ' --job-id ' + st.id;
		let r = run([ 'sh', '-c', command + ' >/dev/null 2>&1 & echo $!' ]);
		let out = trim(r.stdout || '');
		return r.code == 0 && _common.full_match(out, /^[0-9]+$/) && int(out) > 0
			? { pid: int(out) } : { error: 'could not start the ' + kind + ' worker' };
	});
}

function start_apply(instance, source) {
	return start_job(instance, 'apply', apply_source(source));
}

// Disable the instance: tunnel down and kept down (auto '0'), scheduled
// rotation stopped, and every managed routing/firewall object released so the
// steered networks return to normal networking — IPv6 included. The next
// apply re-enables and recreates everything.
function disconnect_inner(uci, instance) {
	let s = load_settings(uci, instance);
	let iface = validate_interface(s.interface);
	if (!iface)
		return { error: 'invalid interface name' };
	if (!managed_interface(uci, iface))
		return { error: 'interface ' + iface + ' is not managed by nordvpn' };
	let res;
	try {
		let at_risk = wan_default_at_risk(uci);
		s.enabled = false;
		let routing = routing_plan(uci, s, function(desired) {
			desired.set('nordvpn', s.name, 'enabled', '0');
			if (desired.get('network', iface) != null) desired.set('network', iface, 'auto', '0');
		});
		routing.activation = activation(iface, false);
		let applied = commit_routing(uci, routing);
		if (!applied.ok) return { ...applied, interface: iface };

		if (at_risk)
			restore_wan_default_async();
		record_event(instance, 'disabled');
		res = { ...applied, interface: iface };
	} catch (e) {
		res = { error: '' + e };
	}
	return res;
}

// Remove the key of the bank entry `instance` uses. The entry is shared, so
// every instance on it goes down (see nordvpn.credentials.clear_key()).
function clear_credentials(uci, instance) {
	return _creds.clear_instance(uci, instance);
}

// Create a new VPN instance section with its own interface. Committed
// atomically here (not via the UI's staged-apply machinery, whose rollback
// window makes programmatic section creation fragile).
function create_instance_inner(uci, name, credential) {
	let valid = _common.validate_instance(name);
	if (!valid || valid != name)
		return { error: 'invalid instance name' };
	if (name == 'globals')
		return { error: 'this name is reserved' };
	if (uci.get('nordvpn', name) != null)
		return { error: 'an instance with this name already exists' };

	let iface = validate_interface('nv_' + name);
	if (!iface)
		return { error: 'instance name is too long for an interface name' };
	let taken = false;
	for (let other in _common.list_instances(uci))
		if (load_settings(uci, other).interface == iface)
			taken = true;
	if (taken || uci.get('network', iface) != null)
		return { error: 'interface ' + iface + ' already exists' };

	// New instances share the 'default' credentials unless told otherwise.
	let cred = (credential == null || credential == '') ? _creds.DEFAULT_ID : credential;
	if (!_creds.exists(uci, cred))
		return { error: 'no such credentials' };

	let key = validate_wg_key(uci.get(_creds.PKG, cred, 'private_key'));
	let p = _transaction.plan(uci, function(desired) {
		desired.set('nordvpn', name, 'instance');
		desired.set('nordvpn', name, 'interface', iface);
		desired.set('nordvpn', name, 'enabled', '1');
		if (cred != _creds.DEFAULT_ID) desired.set('nordvpn', name, 'credential', cred);
		if (key) {
			desired.set('network', iface, 'interface');
			desired.set('network', iface, 'proto', 'wireguard');
			desired.set('network', iface, 'vpn_type', 'nordvpn');
			desired.set('network', iface, 'private_key', key);
			desired.set('network', iface, 'addresses', [ FIXED_ADDRESS ]);
		}
		return { interface: iface };
	});
	p.reloads = [];
	let applied = commit_routing(uci, p);
	if (!applied.ok) return applied;
	if (key) record_event(name, 'credentials_set');
	return { ...applied, instance: name, interface: iface, credential: cred, configured: !!key };
}

// Tear down a VPN instance: stamped routing/firewall objects, the netifd
// interface + peer, and the config section. 'main' is special — it anchors
// the shared cache options and the UI, so instead of deleting the section its
// options are reset to the shipped defaults (the migration stamp is kept).
function delete_instance_inner(uci, name) {
	if (uci.get('nordvpn', name) == null)
		return { error: 'no such instance' };

	let s = load_settings(uci, name);
	let iface = validate_interface(s.interface);
	if (!iface)
		return { error: 'invalid interface name' };

	let at_risk = wan_default_at_risk(uci);
	// Remove stamped artifacts by enforcing the all-off state.
	s.auto_routing = false;
	s.killswitch = false;
	s.block_ipv6 = false;
	s.vpn_dns = 'off';
	s.use_vpn_dns = false;
	s.source_networks = [];
	s.source_devices = [];
	s.source_domains = [];
	s.source_ips = [];
	s.bypass_devices = [];
	s.bypass_domains = [];
	s.bypass_ips = [];
	let managed = managed_interface(uci, iface);
	let routing = _transaction.plan(uci, function(desired, tables) {
		let result = enforce_routing(desired, s, { rt_tables: tables });
		if (managed) {
			let peer = find_peer(desired, iface);
			if (peer) desired.delete('network', peer);
			desired.delete('network', iface);
		}
		if (name == 'main') {
			for (let k in desired.get_all('nordvpn', name))
				if (substr(k, 0, 1) != '.' && k != 'config_version') desired.delete('nordvpn', name, k);
		} else desired.delete('nordvpn', name);
		return result;
	});
	if (managed) { routing.activation = activation(iface, false); routing.activation.before_configuration = true; }
	let applied = commit_routing(uci, routing);
	if (!applied.ok) return applied;
	if (at_risk) restore_wan_default_async();
	_history.clear_events(name);
	return { ...applied, ...(name == 'main' ? { reset: name } : { deleted: name }), interface: iface };
}

// All short entry points acquire ownership before reading configuration.
function short_mutation(name, work) {
	if (!validate_instance(name))
		return { error: 'invalid instance name' };
	let owner = _mutation.acquire([ name ]);
	if (owner.busy)
		return owner;
	let result;
	try {
		result = _mutation.configuration(function(fresh) { return work(fresh); });
	} catch (e) {
		result = { busy: index('' + e, 'busy') >= 0, error: '' + e };
	}
	_mutation.release(owner.locks);
	return result;
}

function apply_routing(uci, name) {
	name = (name == null || name == '') ? 'main' : name;
	return short_mutation(name, function(fresh) {
		if (fresh.get('nordvpn', name) == null)
			return { error: 'no such instance' };
		let invalid = _mutation.validate_owner(fresh, name);
		if (invalid)
			return { error: invalid };
		return apply_routing_inner(fresh, name);
	});
}

function disconnect(uci, name) {
	name = (name == null || name == '') ? 'main' : name;
	return short_mutation(name, function(fresh) {
		if (fresh.get('nordvpn', name) == null)
			return { error: 'no such instance' };
		let invalid = _mutation.validate_owner(fresh, name);
		if (invalid)
			return { error: invalid };
		return disconnect_inner(fresh, name);
	});
}

function delete_instance(uci, name) {
	name = (name == null || name == '') ? 'main' : name;
	return short_mutation(name, function(fresh) {
		let iface = load_settings(fresh, name).interface;
		if (managed_interface(fresh, iface)) {
			let invalid = _mutation.validate_owner(fresh, name);
			if (invalid)
				return { error: invalid };
		}
		return delete_instance_inner(fresh, name);
	});
}

function create_instance(uci, name, credential) {
	let migration = _creds.migrate(cursor());
	if (type(migration) == 'object' && migration.error)
		return migration;
	return short_mutation(name, function(fresh) { return create_instance_inner(fresh, name, credential); });
}

// Disable every configured instance, attempting all of them even if one has
// a bad interface configuration. `disconnect()` changes only the active
// enabled state and managed routing objects; kill-switch preferences remain
// saved so an explicit later enable restores them.
function disable_all(uci) {
	let disabled = [], errors = [];
	for (let name in _common.list_instances(uci)) {
		let res;
		try {
			// A prior disconnect may have committed deletions, invalidating the
			// cursor's section state; give each instance a fresh view.
			res = disconnect(cursor(), name);
		} catch (e) {
			res = { error: '' + e };
		}
		if (res && res.ok)
			push(disabled, name);
		else
			push(errors, { instance: name,
				error: (res && res.error) ? res.error : 'disable failed' });
	}
	return { ok: length(errors) == 0, disabled, errors };
}

return { routing_adapters, routing_plan, set_credentials, clear_credentials, current_key, current_peer, restore_peer, restore_connection, write_relay, bring_up, verify_handshake, netifd_hint, tunnel_hint, connect_one, connect_one_result, tunnel_fingerprint, wan_default_at_risk, prefer_current, keep_running, parse_nft_elements, nft_set_elements, commit_routing, APPLY_SOURCES, apply_source, apply_event, apply, apply_routing, disconnect, disable_all, create_instance, delete_instance, restore_wan_default, restore_wan_default_async,
	write_apply_status, read_apply_status, apply_running, apply_status_report, run_job, run_apply, start_job, start_apply };
