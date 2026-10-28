// SPDX-License-Identifier: MIT
'use strict';
import { readfile } from 'fs';
import { cursor } from 'uci';
const p = require('nordvpn.probes');
const state = require('nordvpn.probe_state');
const jobs = require('nordvpn.jobs');
const c = require('nordvpn.common');
const mutations = require('nordvpn.mutation');
let fails = 0;
function ok(label, condition) {
	printf('%s %s\n', condition ? 'ok' : 'FAIL', label);
	if (!condition) fails++;
}
function copy(value) { return value ? json(sprintf('%J', value)) : null; }
let cache = {}, job = null, locks = {}, seq = 0, epoch = 1000, up = 10;
let storage_ok = true, owner_busy = false, alive = true, remote = 0, spawns = 0;
let owner_held = false, config = 'first', device = 'ifindex-1', available = true, legacy = false;
let injected = null, fail_http = false;
function lock(path) {
	if (locks[path]) return null;
	locks[path] = true;
	return { path: path };
}
function unlock(token) { delete locks[token.path]; }
let store = state.create({
	read: function() { return copy(cache); },
	write: function(value) { if (!storage_ok) return false; cache = copy(value); return true; },
	lock: function() { return lock('cache'); }, unlock: unlock,
	id: function() { return 'generation-' + (++seq); }
});
let slot = jobs.create('/probe', {
	read: function() { return copy(job); },
	write: function(value) { job = copy(value); return true; },
	lock: lock, unlock: unlock, clock: function() { return epoch; }, uptime: function() { return up; },
	pid: function() { return 42; }, identity: function() { return alive ? 'worker' : null; },
	id: function() { return 'job-' + (++seq); }
});
let bindings = [];
let probe = p.create({ store: store, slot: slot,
	clock: function() { return epoch; }, uptime: function() { return up; },
	context: function(name, data) {
		return { instance: name, interface: 'nordvpn', gateway: 'same.nordvpn.com', enabled: true, available: available,
			legacy_lan: legacy, generation: store.version(data, name) + '|' + config + '|' + device };
	},
	lock: function() { if (owner_busy || owner_held) return null; owner_held = true; return {}; },
	unlock: function() { owner_held = false; },
	spawn: function() { spawns++; return { pid: 42 }; },
	insights: function(iface) {
		remote++; push(bindings, iface);
		ok('HTTP holds no instance/cache/metadata locks', !owner_held && !locks.cache && !locks['/probe.metadata.lock']);
		if (injected) { let fn = injected; injected = null; fn(); }
		return fail_http ? null : { ip: '1.2.3.4', protected: true };
	}
});
let first = probe.start('main');
ok('start is HTTP-free and publishes pending exact ID', first.state == 'pending' && first.id && remote == 0);
let duplicate = probe.start('main');
ok('multiple tabs deduplicate one job', duplicate.id == first.id && duplicate.already_running && spawns == 1);
let before = sprintf('%J', [ cache, job ]);
ok('status reads queued probe without HTTP', probe.status('main', first.id).state == 'pending' && remote == 0);
ok('status leaves both stores untouched', before == sprintf('%J', [ cache, job ]));
ok('unknown exact ID never falls back to latest', probe.status('main', 'missing').state == 'missing');
probe.run('main', first.id);
let fresh = probe.status('main', first.id);
ok('worker publishes a fresh bound observation', fresh.state == 'fresh' && fresh.result.protected && bindings[0] == 'nordvpn');
ok('fresh cache deduplicates subsequent launches', probe.start('main').state == 'fresh' && spawns == 1);
ok('job history contains no insights payload', job.result.ok && !job.result.ip && !job.result.protected && !job.context.result);
up += p.TTL;
ok('expired success is stale with no protected payload', probe.status('main').state == 'stale' && !probe.status('main').result);
let second = probe.start('main');
injected = function() {
	store.bump([ 'main' ]);
	ok('unrelated local status remains available while request is outstanding', probe.status('other').state == 'stale');
};
let superseded = probe.run('main', second.id);
ok('same-gateway reconnect rejects in-flight success', superseded.error == 'probe generation superseded' && probe.status('main', second.id).state == 'stale');
ok('superseded worker cannot replace previous observation', cache.records[0].id == first.id);
let third = probe.start('main');
injected = function() { config = 'routing-changed'; };
ok('routing change rejects in-flight success', probe.run('main', third.id).error == 'probe generation superseded');
let fourth = probe.start('main');
injected = function() { device = 'ifindex-2'; };
ok('external device recreation rejects in-flight success', probe.run('main', fourth.id).error == 'probe generation superseded');
let fifth = probe.start('main');
injected = function() { owner_busy = true; };
ok('mutation in progress prevents terminal publication', probe.run('main', fifth.id).busy && cache.records[0].id == first.id);
ok('probe cannot start inside a reconnect', probe.start('main').busy);
owner_busy = false;
store.bump([ 'main' ]);
let sixth = probe.start('main');
probe.run('main', sixth.id);
available = false;
ok('down or absent interface never reuses healthy styling', probe.status('main').state == 'stale' && !probe.status('main').result);
ok('down interface cannot start HTTP', !!probe.start('main').error);
available = true;
device = 'ifindex-3';
fail_http = true;
let failing = probe.start('main');
probe.run('main', failing.id);
let failure = probe.status('main', failing.id);
ok('HTTP failure is explicit with bounded initial backoff', failure.state == 'failed' && failure.retry_after_seconds == 30 && !failure.result);
let launches = spawns;
for (let n = 0; n < 5; n++) probe.start('main');
ok('repeated starts during backoff spawn no workers', spawns == launches);
up += 30;
let retry = probe.start('main');
probe.run('main', retry.id);
ok('successive failure doubles retry backoff', probe.status('main').retry_after_seconds == 60);
// Negative wall-clock changes cannot manufacture freshness or bypass backoff.
epoch -= 100000;
ok('backoff uses monotonic time', probe.start('main').backoff);
up += 60;
let dead = probe.start('main');
slot.run(dead.id, 'main', 'probe', function() { return { error: 'worker killed' }; });
let job_before = sprintf('%J', job);
probe.status('main', dead.id);
ok('failed-job status is read-only', job_before == sprintf('%J', job));
ok('worker failure acquires backoff on write-side retry', probe.start('main').backoff);
fail_http = false;
legacy = true;
config = 'legacy';
bindings = [];
let lan = probe.start('main');
probe.run('main', lan.id);
ok('eligible legacy routing probes bound tunnel then unbound LAN', length(bindings) == 2 && bindings[0] == 'nordvpn' && bindings[1] == null && probe.status('main').result.lan_path.protected);
legacy = false;
config = 'dedicated-table';
bindings = [];
let dedicated = probe.start('main');
probe.run('main', dedicated.id);
ok('dedicated-table routing avoids LAN-path request', length(bindings) == 1 && !probe.status('main').result.lan_path);
up += p.TTL;
let publish_failure = probe.start('main');
storage_ok = false;
ok('cache publication failure never reports probe success', !!probe.run('main', publish_failure.id).error && probe.status('main', publish_failure.id).state == 'failed');
storage_ok = true;
// The two bounded stores retain no more than their documented limits.
for (let n = 0; n < state.LIMIT + 3; n++) {
	let name = 'instance' + n;
	let started = probe.start(name);
	probe.run(name, started.id);
}
ok('per-instance result records are bounded', length(cache.records) == state.LIMIT);
let old_version = store.version(cache, 'instance0');
for (let n = 0; n < state.LIMIT * 2 + 1; n++) store.bump([ 'eviction' + n ]);
ok('generation journal is bounded', length(cache.versions) == state.LIMIT * 2);
let restarted = probe.start('instance0');
ok('evicted generations receive unique identity before publication', store.version(cache, 'instance0') != 'uninitialized' && store.version(cache, 'instance0') != old_version);
slot.fail(restarted.id, 'cleanup');

// Exercise actual HTTP read limits without using a remote service.
let original_open = c.open_cmd, args_seen = null, reads = 0;
c.open_cmd = function(argv) {
	args_seen = argv;
	return { read: function(size) { reads++; return substr('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 0, min(32, size)); }, close: function() { return 0; } };
};
ok('oversized chunked response is rejected with bounded reads', p.insights('nordvpn') == null && reads <= int(p.MAX_BODY / 32) + 1);
ok('curl has connect/total/body bounds and interface binding', index(args_seen, '--connect-timeout') >= 0 && index(args_seen, '--max-time') >= 0 && index(args_seen, '--max-filesize') >= 0 && args_seen[index(args_seen, '--interface') + 1] == 'nordvpn');
c.open_cmd = function() { return { read: function() { return ''; }, close: function() { return 28; } }; };
ok('timeout is a failed observation', p.insights(null) == null);
c.open_cmd = original_open;

// Production context uses actual config-only legacy eligibility and sysfs
// lifecycle identity. A harmless loopback device supplies host fixture state.
global.MOCK_UCI = { nordvpn: { main: { '.type': 'instance', enabled: '1', interface: 'lo', auto_routing: '1' } },
	network: { lo: { '.type': 'interface', vpn_type: 'nordvpn', private_key: 'PRIVATE-KEY-MUST-NOT-LEAK' },
		peer: { '.type': 'wireguard_lo', interface: 'lo', endpoint_host: 'same.nordvpn.com', public_key: 'PUBLIC-KEY-MUST-NOT-LEAK' } } };
let legacy_context = p.context(cursor(), 'main', 'test-generation');
ok('production context preserves legacy no-table auto-routing eligibility', legacy_context.legacy_lan && legacy_context.available);
ok('context never persists WireGuard keys', index(legacy_context.generation, 'KEY-MUST-NOT-LEAK') < 0);
global.MOCK_UCI.network.lo.ip4table = 'lo';
let table_context = p.context(cursor(), 'main', 'test-generation');
ok('actual table change invalidates context and disables LAN-path request', !table_context.legacy_lan && table_context.generation != legacy_context.generation);
global.MOCK_UCI.nordvpn.main.interface = 'nv_missing';
ok('absent production device is unavailable', !p.context(cursor(), 'main', 'test-generation').available);

// Real mutation ownership changes the journal before any tunnel operation,
// including same-config CLI/scheduler reconnects and credential fan-out.
let production_store = state.store;
let generation_before = production_store.version(production_store.load(), 'probe_test');
let acquired = mutations.acquire([ 'probe_test' ]);
let generation_after = production_store.version(production_store.load(), 'probe_test');
ok('mutation ownership invalidates unchanged gateway generation', !acquired.busy && generation_before != generation_after);
mutations.release(acquired.locks);
let original_bump = production_store.bump;
production_store.bump = function() { return { error: 'injected storage failure' }; };
ok('generation storage failure refuses mutation', mutations.acquire([ 'probe_test' ]).busy);
let released = c.acquire_advisory(c.tunnel_lock_path('probe_test'));
ok('failed invalidation releases every instance lock', released != null);
c.release_advisory(released);
production_store.bump = original_bump;

// Read ACL retains the compatibility endpoint but only write can start work.
let acl_path = split(RPCD, '/nordvpn-wireguard/')[0] + '/luci-app-nordvpn/root/usr/share/rpcd/acl.d/luci-app-nordvpn.json';
let acl = json(readfile(acl_path))['luci-app-nordvpn'];
ok('cache/status reads granted separately from probe starts', index(acl.read.ubus.nordvpn, 'external_ip_status') >= 0 && index(acl.read.ubus.nordvpn, 'external_ip_start') < 0 && index(acl.write.ubus.nordvpn, 'external_ip_start') >= 0);
let obj = loadfile(RPCD)().nordvpn;
let original_status = p.service.status, original_start = p.service.start;
let local_status = 0, local_start = 0;
p.service.status = function() { local_status++; return { state: 'stale' }; };
p.service.start = function() { local_start++; return { state: 'pending' }; };
global.MOCK_UCI = { nordvpn: { main: { '.type': 'instance' } } };
obj.external_ip_status.call({ args: { instance: 'main' } });
obj.external_ip_start.call({ args: { instance: 'main' } });
ok('asynchronous RPCs delegate only to local status/launch paths', local_status == 1 && local_start == 1);
p.service.status = original_status;
p.service.start = original_start;
exit(fails ? 1 : 0);
