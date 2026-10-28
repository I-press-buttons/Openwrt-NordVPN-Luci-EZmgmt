// SPDX-License-Identifier: MIT
// Conflicting public mutators must leave config and runtime untouched.
'use strict';
import { cursor } from 'uci';
const c = require('nordvpn.common');
const m = require('nordvpn.mutation');
const a = require('nordvpn.apply');
require('routing_adapter').install(a.routing_adapters);
const r = require('nordvpn.rotate');
const creds = require('nordvpn.credentials');
const api = require('nordvpn.api');
let failures = 0;
function ok(label, value) {
	printf('%s %s\n', value ? 'ok' : 'FAIL', label);
	if (!value) failures++;
}
function seed() {
	global.MOCK_UCI = { nordvpn: {
		main: { '.type': 'instance', interface: 'nordvpn', enabled: '1' },
		second: { '.type': 'instance', interface: 'nv_second', enabled: '1' }
	}, network: {
		nordvpn: { '.type': 'interface', vpn_type: 'nordvpn', private_key: KEY },
		nv_second: { '.type': 'interface', vpn_type: 'nordvpn', private_key: KEY }
	}, nordvpn_credentials: {
		_state: { '.type': 'state', migrated: '1' },
		default: { '.type': 'credential', private_key: KEY }
	} };
}
let real_api = api.get_private_key;
let expect_http_free = true;
api.get_private_key = function() {
	// HTTP/key exchange must run without holding shared configuration.
	let lock = c.acquire_advisory(m.CONFIG_LOCK);
	if (expect_http_free)
		ok('HTTP runs outside shared configuration lock', lock != null);
	c.release_advisory(lock);
	return { private_key: KEY };
};
seed();
let owner = m.acquire([ 'main' ]);
let before = sprintf('%J', global.MOCK_UCI);
let calls = {
	apply: () => a.apply(cursor(), 'main', 'save', 0),
	rotation: () => r.rotate(cursor(), 'main', 'manual', 0),
	routing: () => a.apply_routing(cursor(), 'main'),
	disable: () => a.disconnect(cursor(), 'main'),
	delete: () => a.delete_instance(cursor(), 'main'),
	create: () => a.create_instance(cursor(), 'main'),
	set_credentials: () => a.set_credentials(cursor(), 'token', 'main'),
	clear_credentials: () => a.clear_credentials(cursor(), 'main'),
	remove_credentials: () => creds.remove(cursor(), 'default'),
	sync_users: () => creds.sync_users(cursor(), 'default')
};
for (let label in calls) {
	let result = calls[label]();
	ok(label + ' reports busy ownership', result.busy == true);
	ok(label + ' makes no configuration mutations', sprintf('%J', global.MOCK_UCI) == before);
}
// Reverse-input fanout is sorted and a partial acquisition is released.
let fanout = m.acquire([ 'second', 'main' ]);
ok('fanout reports exact busy instance', fanout.busy && fanout.instance == 'main');
let other = m.acquire([ 'second' ]);
ok('failed fanout released partial ownership', !other.busy);
m.release(other.locks);
m.release(owner.locks);

// Migration is a mutator too; it cannot rewrite credential associations while
// a tunnel uses them. Then a successful retry releases all ownership.
seed();
delete global.MOCK_UCI.nordvpn_credentials._state;
owner = m.acquire([ 'second' ]);
before = sprintf('%J', global.MOCK_UCI);
ok('migration reports busy', creds.migrate(cursor()).busy == true);
ok('busy migration writes nothing', sprintf('%J', global.MOCK_UCI) == before);
m.release(owner.locks);
creds.migrate(cursor());
owner = m.acquire([ 'main', 'second' ]);
ok('migration released every owner', !owner.busy);
m.release(owner.locks);

// Short RPC paths fail immediately on shared contention and clean ownership.
seed();
expect_http_free = false;
let shared = c.acquire_advisory(m.CONFIG_LOCK);
before = sprintf('%J', global.MOCK_UCI);
for (let label in calls) {
	let result = calls[label]();
	ok(label + ' reports shared busy', result.busy == true);
	ok(label + ' leaves config unchanged on shared busy', sprintf('%J', global.MOCK_UCI) == before);
	owner = m.acquire([ 'main' ]);
	ok(label + ' releases owner on shared busy', !owner.busy);
	m.release(owner.locks);
}
c.release_advisory(shared);
expect_http_free = true;
try { m.configuration(function() { die('injected configuration error'); }); } catch (e) {}
shared = c.acquire_advisory(m.CONFIG_LOCK);
ok('throw releases shared ownership', shared != null);
c.release_advisory(shared);

// Saved stale cursors and foreign/aliased interfaces are revalidated.
seed();
let old = cursor();
global.MOCK_UCI.network.nordvpn.vpn_type = 'foreign';
before = sprintf('%J', global.MOCK_UCI);
ok('credentials reject a freshly foreign interface', a.set_credentials(old, 'token', 'main').error != null);
ok('foreign credential rejection changes nothing', sprintf('%J', global.MOCK_UCI) == before);
seed();
global.MOCK_UCI.nordvpn.second.interface = 'nordvpn';
before = sprintf('%J', global.MOCK_UCI);
ok('aliased interfaces cannot mutate independently', a.disconnect(cursor(), 'main').error != null);
ok('alias rejection changes nothing', sprintf('%J', global.MOCK_UCI) == before);
seed();
let result = creds.clear_key(cursor(), 'default');
ok('credential fanout reports every success', result.ok && length(result.succeeded) == 2 && length(result.errors) == 0);
owner = m.acquire([ 'second', 'main' ]);
ok('fanout cleanup releases every owner', !owner.busy);
m.release(owner.locks);
seed();
global.MOCK_UCI_COMMIT_HOOK = function(config) {
	if (config == 'network' && global.MOCK_UCI.network.nv_second.private_key == null)
		die('injected second-instance sync error');
	return true;
};
result = creds.clear_key(cursor(), 'default');
ok('fanout reports successful instances before an exception', !result.ok && result.succeeded[0] == 'main');
ok('fanout identifies the failed instance', result.errors[0].instance == 'second');
global.MOCK_UCI_COMMIT_HOOK = null;
owner = m.acquire([ 'main', 'second' ]);
ok('fanout exception releases every owner', !owner.busy);
m.release(owner.locks);
api.get_private_key = real_api;
exit(failures ? 1 : 0);
