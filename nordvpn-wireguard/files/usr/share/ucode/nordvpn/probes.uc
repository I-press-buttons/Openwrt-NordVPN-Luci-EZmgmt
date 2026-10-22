// SPDX-License-Identifier: MIT
// IP insights: RPC handlers only read local state or launch a detached worker.
'use strict';
import { cursor } from 'uci';
import { readfile } from 'fs';
const c = require('nordvpn.common');
const state = require('nordvpn.probe_state');
const jobs = require('nordvpn.jobs');
const parse = require('nordvpn.api').parse_insights;
const detect = require('nordvpn.routing').detect;
const TTL = 120;
const MAX_BODY = 16384;
const MAX_RUNTIME = 25;

function uptime() { return int(split(readfile('/proc/uptime') || '0', ' ')[0]); }

function device_generation(iface) {
	let base = '/sys/class/net/' + iface + '/';
	let index = trim(readfile(base + 'ifindex') || '');
	let flags = trim(readfile(base + 'flags') || '');
	// IFF_UP is bit 0. WireGuard normally reports operstate=unknown, so use
	// the administrative flags instead. Linux never reuses ifindex on normal
	// device recreation within a boot; boot identity covers router restarts.
	return { up: index != '' && !!match(flags, /[13579bdf]$/),
		id: [ trim(readfile('/proc/sys/kernel/random/boot_id') || ''), index, flags ] };
}

// Deliberately excludes private/public keys and credentials. Ordinary WG
// handshakes do not change this context. The mutation journal covers reconnects
// even when every configuration field and the gateway remain identical.
function context(uci, name, version) {
	if (!c.validate_instance(name) || uci.get('nordvpn', name) == null) return null;
	let s = c.load_settings(uci, name), iface = s.interface, peer = null;
	uci.foreach('network', 'wireguard_' + iface, function(sec) {
		if (sec.interface == iface) { peer = sec; return false; }
	});
	let gateway = peer ? (peer.nordvpn_gateway || peer.endpoint_host || '') : '';
	let actual = map([ 'proto', 'auto', 'ip4table', 'ip6table', 'mtu', 'addresses' ],
		(key) => uci.get('network', iface, key));
	let routing = {};
	for (let key in [ 'enabled', 'interface', 'routing_table', 'auto_routing', 'killswitch', 'block_ipv6',
		'vpn_masq', 'vpn_dns', 'custom_dns', 'source_networks', 'source_devices', 'source_domains',
		'source_ips', 'bypass_devices', 'bypass_domains', 'bypass_ips', 'mtu' ]) routing[key] = s[key];
	let legacy = s.enabled && (uci.get('network', iface, 'ip4table') || '') == '' &&
		detect(uci, s, false).mode == 'auto';
	let device = device_generation(iface);
	return { instance: name, interface: iface, gateway: gateway, enabled: s.enabled,
		available: device.up, legacy_lan: !!legacy, generation: sprintf('%J', [ version, device.id, routing, actual, gateway,
			peer ? peer.endpoint_host : null, peer ? peer.endpoint_port : null, !!legacy ]) };
}

// Cap reads independently of curl's Content-Length limit (older curl releases
// do not enforce --max-filesize on chunked responses). Closing the pipe and
// curl's total deadline bound an oversized or stalled response as well.
function insights(iface) {
	let args = [ 'curl', '-s', '--fail', '--connect-timeout', '3', '--max-time', '8',
		'--max-filesize', '' + MAX_BODY, '-H', 'Accept: application/json' ];
	if (iface) push(args, '--interface', iface);
	push(args, c.IP_INSIGHTS_URL);
	let proc = c.open_cmd(args, 'r', true);
	if (!proc) return null;
	let body = '';
	while (length(body) <= MAX_BODY) {
		let chunk = proc.read(min(4096, MAX_BODY + 1 - length(body)));
		if (!chunk) break;
		body += chunk;
	}
	let code = proc.close();
	return code == 0 && length(body) <= MAX_BODY ? parse(body) : null;
}

function create(adapters) {
	let a = adapters || {}, store = a.store || state.store;
	let slot = a.slot || jobs.create('/tmp/nordvpn_probe_job.json');
	let clock = a.clock || time, mono = a.uptime || uptime;
	let snapshot = a.context || function(name, data) { return context(cursor(), name, store.version(data, name)); };
	let request = a.insights || insights;
	let lock = a.lock || function(name) { return c.acquire_advisory(c.tunnel_lock_path(name)); };
	let unlock = a.unlock || c.release_advisory;
	let spawn = a.spawn || function(st) {
		let r = c.run([ 'sh', '-c', '/usr/bin/nordvpn-probe ' + st.instance + ' --job-id ' + st.id + ' >/dev/null 2>&1 & echo $!' ]);
		let out = trim(r.stdout || '');
		return r.code == 0 && c.full_match(out, /^[0-9]+$/) && int(out) > 0
			? { pid: int(out) } : { error: 'could not start probe worker' };
	};
	function owned(name, work, wait) {
		let token = lock(name);
		for (let n = 0; wait && !token && n < 100; n++) { sleep(10); token = lock(name); }
		if (!token) return { busy: true, state: 'stale', error: 'instance is changing; protection check will retry' };
		let result;
		try { result = work(); } catch (e) { result = { error: 'probe storage failed' }; }
		unlock(token);
		return result;
	}
	function record(data, name) {
		for (let r in data.records) if (r.instance == name) return r;
		return null;
	}
	function observation(ctx, rec) {
		if (!ctx) return { state: 'missing', error: 'no such instance' };
		if (!rec) return { state: 'stale', generation: ctx.generation };
		let out = { id: rec.id, generation: ctx.generation, gateway: rec.gateway, interface: rec.interface,
			checked_at: rec.checked_at, checked_at_epoch: rec.checked_at_epoch, expires_at_epoch: rec.expires_at_epoch,
			retry_at_epoch: rec.retry_at_epoch, state: rec.state, error: rec.error };
		let age = mono() - rec.checked_at_uptime;
		if (rec.generation != ctx.generation || !ctx.enabled || !ctx.available || age < 0 ||
			(rec.state == 'fresh' && age >= TTL)) out.state = 'stale';
		out.retry_after_seconds = out.state == 'failed' ? max(0, rec.retry_at_uptime - mono()) : 0;
		if (out.state == 'fresh') { out.result = rec.result; out.ttl_seconds = TTL - age; }
		return out;
	}
	function status(name, id) {
		// Intentionally no locks that write files, recovery, HTTP or publication.
		let data = store.load(), ctx = snapshot(name, data), rec = record(data, name);
		let job = slot.peek(id);
		if (id && (!job || job.state == 'missing' || job.instance != name))
			return { id: id, state: 'missing', error: 'probe status is unavailable or expired' };
		if (job && job.instance == name && (!id || job.id == id) && (job.context || {}).generation == (ctx && ctx.generation)) {
			if (job.state == 'running') return { id: job.id, state: 'pending', generation: ctx.generation };
			if (job.state == 'failed' && (!rec || rec.id != job.id))
				return { id: job.id, state: 'failed', generation: ctx.generation, error: job.error };
		}
		if (id && (!rec || rec.id != id)) return { id: id, state: 'stale', generation: ctx && ctx.generation };
		return observation(ctx, rec);
	}
	function put(data, rec) {
		data.records = filter(data.records, (r) => r.instance != rec.instance);
		push(data.records, rec);
		while (length(data.records) > state.LIMIT) shift(data.records);
	}
	function failed_record(ctx, id, previous, error) {
		let failures = previous && previous.generation == ctx.generation ? min(5, (previous.failures || 0) + 1) : 1;
		let delay = 30;
		for (let n = 1; n < failures; n++) delay = min(300, delay * 2);
		let now = clock(), up = mono();
		return { ...ctx, id: id, state: 'failed', error: error || 'could not determine the external IP', failures: failures,
			checked_at: c.iso_ts(now), checked_at_epoch: now, checked_at_uptime: up,
			retry_at_epoch: now + delay, retry_at_uptime: up + delay };
	}
	function start(name) {
		if (!c.validate_instance(name)) return { error: 'invalid instance name' };
		return owned(name, function() {
			return store.transaction(function(data, save) {
				// Never publish a cache entry for the missing-version sentinel:
				// eviction and later reuse must obtain a new unique generation.
				if (store.version(data, name) == 'uninitialized') {
					if (!store.initialize(data, name) || !save(data)) return { error: 'could not initialize probe generation' };
				}
				let ctx = snapshot(name, data);
				if (!ctx || !ctx.enabled || !ctx.available || !ctx.gateway || !c.validate_interface(ctx.interface))
					return { state: 'stale', error: 'enabled tunnel with a gateway is required' };
				let rec = record(data, name), current = observation(ctx, rec);
				if (current.state == 'fresh') return current;
				let job = slot.peek();
				if (job && job.state == 'running') {
					if (job.instance == name && (job.context || {}).generation == ctx.generation)
						return { id: job.id, state: 'pending', generation: ctx.generation, already_running: true };
					return { busy: true, state: 'stale', error: 'another protection check is running; retry' };
				}
				// Recover worker-death/spawn/publication failures into the same
				// bounded retry policy as HTTP failures, on this write path only.
				if (job && job.state == 'failed' && job.instance == name && (job.context || {}).generation == ctx.generation &&
					(!rec || rec.id != job.id)) {
					rec = failed_record(ctx, job.id, rec, job.error);
					put(data, rec);
					if (!save(data)) return { error: 'could not publish probe failure' };
					current = observation(ctx, rec);
				}
				if (current.state == 'failed' && mono() < rec.retry_at_uptime && mono() >= rec.checked_at_uptime)
					return { ...current, backoff: true };
				let launched = slot.start(name, 'probe', ctx, MAX_RUNTIME, spawn);
				return launched.apply ? { id: launched.apply.id, state: launched.error ? 'failed' : 'pending',
					generation: ctx.generation, error: launched.error } : launched;
			});
		});
	}
	function run(name, id) {
		return slot.run(id, name, 'probe', function(instance, expected) {
			let initial = owned(instance, function() {
				let ctx = snapshot(instance, store.load());
				return ctx && ctx.enabled && ctx.available && ctx.generation == expected.generation ? { ok: true } : { error: 'probe generation superseded' };
			}, true);
			if (!initial.ok) return { error: initial.error };
			// No instance/configuration/metadata ownership spans remote requests.
			let result = request(expected.interface), lan = null;
			if (result && expected.legacy_lan) lan = request(null);
			if (result) {
				result.interface = expected.interface;
				if (expected.legacy_lan) result.lan_path = lan ? { protected: lan.protected, ip: lan.ip, isp: lan.isp } : null;
			}
			return owned(instance, function() {
				return store.transaction(function(data, save) {
					let ctx = snapshot(instance, data);
					if (!ctx || !ctx.enabled || !ctx.available || ctx.generation != expected.generation) return { error: 'probe generation superseded' };
					let rec;
					if (!result || (expected.legacy_lan && !lan))
						rec = failed_record(ctx, id, record(data, instance), 'could not determine the external IP or LAN path');
					else {
						let now = clock();
						rec = { ...ctx, id: id, state: 'fresh', result: result, failures: 0,
							checked_at: c.iso_ts(now), checked_at_epoch: now, checked_at_uptime: mono(), expires_at_epoch: now + TTL };
					}
					put(data, rec);
					if (!save(data)) return { error: 'could not publish probe result' };
					// Job history contains only completion metadata, never the
					// provider payload or credentials. Cache owns observations.
					return rec.state == 'fresh' ? { ok: true } : { error: rec.error };
				});
			});
		});
	}
	return { start, status, run };
}
const service = create();
return { create, context, insights, service, TTL, MAX_BODY, MAX_RUNTIME };
