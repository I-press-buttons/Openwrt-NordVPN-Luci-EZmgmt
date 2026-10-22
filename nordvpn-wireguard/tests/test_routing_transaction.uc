// SPDX-License-Identifier: MIT
// Fault matrix with explicit process/storage/runtime adapters and persisted
// package images. The legacy mock's always-successful commits are insufficient.
'use strict';
import { cursor } from 'uci';
import { writefile, unlink } from 'fs';
const tx = require('nordvpn.routing_transaction');
const apply = require('nordvpn.apply');
let failures = 0;
function ok(label, value) { printf('%s %s\n', value ? 'ok' : 'FAIL', label); if (!value) failures++; }
function copy(v) { return v == null ? null : json(sprintf('%J', v)); }
function equal(a, b) { return sprintf('%J', a) == sprintf('%J', b); }
let events, fail_at, counts, tables, persisted, verify_result, during, store_failure;
function event(name) {
	push(events, name); counts[name] = (counts[name] || 0) + 1;
	return index(fail_at, name + '#' + counts[name]) < 0 && index(fail_at, name + '#*') < 0;
}
function reset() {
	global.MOCK_UCI = { nordvpn: { main: { '.type': 'instance', enabled: '1', interface: 'nv_media' } },
		network: { nv_media: { '.type': 'interface', proto: 'wireguard', vpn_type: 'nordvpn', auto: '1', ip4table: '100' } },
		firewall: { user_first: { '.type': 'rule', name: 'first' },
			managed: { '.type': 'rule', name: 'old', target: 'REJECT', nordvpn_managed: '1', nordvpn_iface: 'nv_media' },
			user_last: { '.type': 'rule', name: 'last' } },
		dhcp: { dns: { '.type': 'dnsmasq', noresolv: '0' } } };
	events = []; fail_at = []; counts = {}; tables = '255 local\n';
	let outcomes = {};
	tx.adapters.read_outcome = function(name) { return outcomes[name]; };
	tx.adapters.write_outcome = function(name, record) { outcomes[name] = copy(record); return true; };
	persisted = copy(global.MOCK_UCI); verify_result = true; during = null; store_failure = false;
	tx.adapters.read_tables = function() { return tables; };
	tx.adapters.write_tables = function(text) { if (!event('tables')) return false; tables = text; return true; };
	tx.adapters.commit = function(uci, pkg) {
		if (during) { let hook = during; during = null; hook(); }
		if (!event('commit:' + pkg) || store_failure) return false;
		persisted[pkg] = copy(global.MOCK_UCI[pkg]); return true;
	};
	tx.adapters.run = function(argv) {
		let a = argv[0] == 'timeout' ? slice(argv, 2) : argv;
		let name = a[0] == '/etc/init.d/firewall' ? 'reload:firewall' : a[0] == '/etc/init.d/dnsmasq' ? 'reload:dhcp' :
			a[0] == 'ubus' && a[2] == 'network' ? 'reload:network' : a[0] == 'nft' ? 'nft:' + a[1] : a[0];
		if (!event(name)) return { code: 1, stdout: 'injected failure' };
		if (a[0] == 'ubus') return { code: 0, stdout: '{"up":true,"l3_device":"nv_media"}' };
		return { code: 0, stdout: '' };
	};
	tx.adapters.verify = function() { return event('verify') && verify_result; };
	tx.adapters.pause = function() {};
}
function multipackage() {
	return tx.plan(cursor(), function(c) {
		c.set('firewall', 'managed', 'name', 'new');
		c.set('network', 'nv_media', 'ip4table', '101');
		c.set('dhcp', 'dns', 'noresolv', '1');
		c.set('nordvpn', 'main', 'enabled', '0');
		return { interface: 'nv_media', routing_policy: true };
	});
}
reset();
let before = tx.snapshot(cursor()), p = multipackage();
ok('planning neither stages configuration nor invokes processes/commits', equal(before, tx.snapshot(cursor())) && !length(events));
ok('plan exposes managed updates, package set and reload dependencies', length(p.changes) == 4 && equal(p.packages, [ 'firewall', 'network', 'dhcp', 'nordvpn' ]) && equal(p.reloads, [ 'firewall', 'network', 'dhcp' ]));
let r = tx.execute(cursor(), p);
ok('all required commits precede dependency-ordered reloads', r.ok && equal(slice(events, 0, 7), [ 'commit:firewall', 'commit:network', 'commit:dhcp', 'commit:nordvpn', 'reload:firewall', 'reload:network', 'reload:dhcp' ]));
events = [];
r = tx.execute(cursor(), multipackage());
ok('repeated desired state changes nothing and reloads nothing', r.ok && !r.changed && equal(events, [ 'verify' ]));
for (let pkg in [ 'firewall', 'network', 'dhcp', 'nordvpn' ]) {
	reset(); before = tx.snapshot(cursor()); let durable = copy(persisted); p = multipackage();
	fail_at = [ 'commit:' + pkg + '#1' ]; r = tx.execute(cursor(), p);
	ok('failed ' + pkg + ' commit is actionable and cannot reload or succeed', !r.ok && r.stage == 'commit:' + pkg && !length(filter(events, (s) => index(s, 'reload:') == 0)));
	ok('failed ' + pkg + ' commit restores staged and persisted touched packages', r.rollback.ok && equal(before, tx.snapshot(cursor())) && equal(durable, persisted));
}
for (let pkg in [ 'firewall', 'network', 'dhcp' ]) {
	reset(); before = tx.snapshot(cursor()); let durable = copy(persisted); p = multipackage();
	fail_at = [ 'reload:' + pkg + '#1' ]; r = tx.execute(cursor(), p);
	ok('failed ' + pkg + ' reload reports original stage', !r.ok && r.stage == 'reload:' + pkg && r.original_error != null);
	ok('failed ' + pkg + ' reload restores all package images and runtime', r.rollback.ok && r.rollback.runtime_attempted && equal(before, tx.snapshot(cursor())) && equal(durable, persisted) && counts.verify == 1);
}
for (let pkg in [ 'firewall', 'network', 'dhcp', 'nordvpn' ]) {
	reset(); p = multipackage(); fail_at = [ 'reload:dhcp#1', 'commit:' + pkg + '#2' ]; r = tx.execute(cursor(), p);
	ok('restoration commit failure for ' + pkg + ' remains separate from original error', !r.ok && r.stage == 'reload:dhcp' && !r.rollback.ok && index(join(';', r.rollback.errors), 'restore commit:' + pkg) >= 0);
}
for (let pkg in [ 'firewall', 'network', 'dhcp' ]) {
	reset(); p = multipackage(); fail_at = [ 'reload:dhcp#1', 'reload:' + pkg + '#2' ]; r = tx.execute(cursor(), p);
	ok('restoration reload failure for ' + pkg + ' is visible', !r.rollback.ok && index(join(';', r.rollback.errors), 'restore reload:' + pkg) >= 0);
}
reset(); p = multipackage(); store_failure = true; r = tx.execute(cursor(), p);
ok('insufficient storage cannot succeed or hide failed restoration', !r.ok && r.stage == 'commit:firewall' && !r.rollback.ok);
reset(); p = multipackage(); fail_at = [ 'verify#*' ]; r = tx.execute(cursor(), p);
ok('reload acknowledgements without runtime confirmation fail and expose failed restoration', !r.ok && r.stage == 'verify:runtime' && !r.rollback.ok);
reset(); p = multipackage(); fail_at = [ 'reload:network#1' ];
during = function() {
	global.MOCK_UCI.firewall.user_first.name = 'edited independently';
	global.MOCK_UCI.firewall.managed.independent_option = 'keep';
	global.MOCK_UCI.network.unrelated = { '.type': 'interface', proto: 'static' };
};
r = tx.execute(cursor(), p);
ok('rollback preserves unrelated sections and unrelated options in touched section', !r.ok && r.rollback.ok && global.MOCK_UCI.firewall.user_first.name == 'edited independently' && global.MOCK_UCI.firewall.managed.independent_option == 'keep' && global.MOCK_UCI.network.unrelated.proto == 'static');
reset(); global.MOCK_UCI.firewall.managed['.anonymous'] = true;
p = tx.plan(cursor(), function(c) { c.delete('firewall', 'managed'); return { interface: 'nv_media' }; });
fail_at = [ 'reload:firewall#1' ]; r = tx.execute(cursor(), p);
let order = map(keys(global.MOCK_UCI.firewall), (n) => global.MOCK_UCI.firewall[n].name);
ok('deleted anonymous firewall section is recreated at prior precedence', !r.ok && r.rollback.ok && equal(order, [ 'first', 'old', 'last' ]));
reset(); global.MOCK_UCI.firewall.managed['.anonymous'] = true;
p = tx.plan(cursor(), function(c) { c.delete('firewall', 'managed'); return { interface: 'nv_media' }; });
let reorder_cursor = cursor(); reorder_cursor.reorder = function() { return false; };
fail_at = [ 'reload:firewall#1' ]; r = tx.execute(reorder_cursor, p);
ok('anonymous precedence restoration failure is reported separately', !r.ok && !r.rollback.ok && index(join(';', r.rollback.errors), 'reorder firewall') >= 0);
for (let fault in [ 'nft:list#1', 'nft:add#1', 'nft:add#2' ]) {
	reset();
	global.MOCK_UCI.firewall.domain = { '.type': 'ipset', name: 'nv_nv_media_dom', nordvpn_managed: '1', nordvpn_iface: 'nv_media' };
	p = multipackage(); p.keep_sets = [ 'nv_nv_media_dom' ];
	let base_run = tx.adapters.run;
	tx.adapters.run = function(argv) {
		let result = base_run(argv), a = argv[0] == 'timeout' ? slice(argv, 2) : argv;
		if (result.code == 0 && a[0] == 'nft' && a[1] == 'list') result.stdout = 'elements = { 1.2.3.4 }';
		return result;
	};
	fail_at = fault == 'nft:add#2' ? [ 'reload:network#1', fault ] : [ fault ];
	r = tx.execute(cursor(), p);
	ok('nft capture/restoration fault ' + fault + ' never succeeds', !r.ok && (fault == 'nft:list#1' ? r.stage == 'capture:elements' : fault == 'nft:add#1' ? r.stage == 'restore:elements' : !r.rollback.ok));
}
reset(); p = multipackage(); p.tables.data += '100 nv_media # nordvpn_managed\n';
tables += '101 other # external\n'; fail_at = [ 'reload:network#1' ]; r = tx.execute(cursor(), p);
ok('rt_tables publication and rollback preserve unrelated registrations', !r.ok && r.rollback.ok && tables == '255 local\n101 other # external\n');
for (let failure in [ 'tables#1', 'tables#2' ]) {
	reset(); p = multipackage(); p.tables.data += '100 nv_media # nordvpn_managed\n';
	fail_at = [ failure, 'reload:network#1' ]; r = tx.execute(cursor(), p);
	ok('routing-table write/restoration fault ' + failure + ' never succeeds', !r.ok && (failure == 'tables#1' ? r.stage == 'write:rt_tables' : !r.rollback.ok));
}
reset();
p = tx.plan(cursor(), function() { return { interface: 'nv_media' }; });
p.activation = { stage: 'ifup:nv_media', argv: [ 'ifup', 'nv_media' ], restore_argv: [ 'ifdown', 'nv_media' ], up: true, previous_up: false };
r = tx.execute(cursor(), p);
ok('same-config reconnect still executes explicit activation without claiming config changed', r.ok && !r.changed && counts.ifup == 1 && !counts['reload:network']);
reset();
p = tx.plan(cursor(), function(c) { c.set('network', 'nv_media', 'auto', '0'); return { interface: 'nv_media' }; });
p.activation = { stage: 'ifdown:nv_media', argv: [ 'ifdown', 'nv_media' ], restore_argv: [ 'ifup', 'nv_media' ], up: false, previous_up: true };
fail_at = [ 'ifdown#1' ]; r = tx.execute(cursor(), p);
ok('failed required ifdown restores configuration and prior activation', !r.ok && r.stage == 'ifdown:nv_media' && r.rollback.ok && counts.ifup == 1 && global.MOCK_UCI.network.nv_media.auto == '1');
// Public boundary regressions: no success/history after commit/activation faults.
reset(); global.MOCK_UCI.network.nv_media.private_key = KEY;
global.MOCK_UCI.nordvpn.main.routing_table = '100';
global.MOCK_UCI.nordvpn.main.source_network = [ 'lan' ]; global.MOCK_UCI.nordvpn.main.auto_routing = '0';
global.MOCK_UCI.network.peer = { '.type': 'wireguard_nv_media', interface: 'nv_media', endpoint_host: 'de1.nordvpn.com' };
global.MOCK_UCI.network.lan = { '.type': 'interface', proto: 'static', ipaddr: '192.168.1.1/24' };
global.MOCK_UCI.firewall.zlan = { '.type': 'zone', name: 'lan', network: [ 'lan' ] };
global.MOCK_UCI.firewall.zwan = { '.type': 'zone', name: 'wan', network: [ 'wan' ], masq: '1' };
fail_at = [ 'commit:network#1' ]; r = apply.apply_routing(cursor(), 'main');
ok('public routing apply preserves legacy error and structured failure', !r.ok && !!r.error && r.stage == 'commit:network' && !!r.rollback);
reset(); fail_at = [ 'commit:nordvpn#1' ]; r = apply.disconnect(cursor(), 'main');
ok('disable cannot succeed after enabled-state commit fails', !r.ok && r.stage == 'commit:nordvpn' && global.MOCK_UCI.nordvpn.main.enabled == '1');
reset(); fail_at = [ 'ifdown#1' ]; r = apply.delete_instance(cursor(), 'main');
ok('delete/reset cannot succeed after teardown fails', !r.ok && r.stage == 'ifdown:nv_media' && global.MOCK_UCI.nordvpn.main.interface == 'nv_media' && global.MOCK_UCI.network.nv_media != null);
// Compact confirmation survives new status cursors and never contains keys.
reset(); p = multipackage(); r = tx.execute(cursor(), p);
ok('successful routing records confirmation for a fresh status cursor', r.ok && tx.confirmation(cursor(), 'main').confirmed);
global.MOCK_UCI.nordvpn.main.killswitch = '1';
ok('changed routing preferences invalidate a previous confirmation', !tx.confirmation(cursor(), 'main').confirmed);
reset(); p = multipackage(); fail_at = [ 'reload:network#1' ]; r = tx.execute(cursor(), p);
ok('failed application remains unconfirmed after status reload even when rollback succeeds', !tx.confirmation(cursor(), 'main').confirmed && tx.confirmation(cursor(), 'main').stage == 'reload:network');
reset(); p = multipackage(); let outcome_writes = 0, outcomes = {};
tx.adapters.read_outcome = function(name) { return outcomes[name]; };
tx.adapters.write_outcome = function(name, record) { outcome_writes++; if (outcome_writes == 2) return false; outcomes[name] = copy(record); return true; };
r = tx.execute(cursor(), p);
ok('terminal confirmation publication failure leaves pending journal unconfirmed', !r.ok && r.stage == 'record:result' && !tx.confirmation(cursor(), 'main').confirmed && outcomes.main.stage == 'applying');
reset(); p = multipackage(); tx.adapters.write_outcome = function() { return false; }; before = tx.snapshot(cursor()); r = tx.execute(cursor(), p);
ok('pending journal storage failure aborts before configuration/process mutations', !r.ok && r.stage == 'record:pending' && equal(before, tx.snapshot(cursor())) && !length(events));
// Installation checks exercise the production verifier with fixture command
// output; they do not replace verify_runtime with an optimistic success.
reset();
let runtime = { interface: 'nv_media', reloads: [ 'network' ], changes: [],
	after: { network: {}, firewall: {}, dhcp: {} }, before: { network: {}, firewall: {}, dhcp: {} } };
let rule = { '.type': 'rule', nordvpn_managed: '1', nordvpn_iface: 'nv_media',
	priority: '20000', 'in': 'lan', lookup: '100' };
runtime.after.network.lookup = rule;
let ip_rules = '20000: from all iif br-lan lookup 100\n';
let nft_rules = '';
tx.adapters.run = function(argv) {
	let a = argv[0] == 'timeout' ? slice(argv, 2) : argv;
	if (a[0] == 'ubus') return { code: 0, stdout: '{"interface":[{"interface":"lan","up":true,"l3_device":"br-lan"}]}' };
	if (a[0] == 'ip') return { code: 0, stdout: a[1] == '-4' ? ip_rules : '' };
	if (a[0] == 'nft') return { code: 0, stdout: nft_rules };
	return { code: 127, stdout: '' };
};
ok('runtime confirms installed netifd policy using logical-to-device mapping', tx.verify_runtime(runtime, runtime.after, tables));
runtime.after.network.prohibit = { ...rule, lookup: null, action: 'prohibit', priority: '21000' };
ok('reload alone cannot confirm an absent kill-switch prohibit rule', !tx.verify_runtime(runtime, runtime.after, tables));
ip_rules += '21000: from all iif br-lan prohibit\n';
ok('runtime confirms installed kill-switch prohibit rule', tx.verify_runtime(runtime, runtime.after, tables));
runtime.changes = [ { package: 'network', before: { ...rule, nordvpn_role: 'old_metadata' }, after: { ...rule, nordvpn_role: 'new_metadata' } } ];
ok('metadata-only changes do not require equivalent installed rule to disappear', tx.verify_runtime(runtime, runtime.after, tables));
runtime.changes = [ { package: 'network', before: { ...rule, nordvpn_iface: 'other' }, after: null } ];
ok('an equivalent desired policy retained by another owner is not treated as stale', tx.verify_runtime(runtime, runtime.after, tables));
runtime.reloads = [ 'firewall' ]; runtime.changes = []; runtime.after.network = {};
runtime.after.firewall.mark = { '.type': 'rule', nordvpn_managed: '1', nordvpn_iface: 'nv_media', name: 'NordVPN device aa:bb:cc:dd:ee:ff',
	target: 'MARK', src_mac: 'aa:bb:cc:dd:ee:ff', set_xmark: '0x64000000/0xff000000' };
nft_rules = 'ether saddr aa:bb:cc:dd:ee:ff meta mark set 0x65000000 comment "!fw4: NordVPN device aa:bb:cc:dd:ee:ff"\n';
ok('same firewall comment with another mark cannot confirm this instance', !tx.verify_runtime(runtime, runtime.after, tables));
nft_rules = replace(nft_rules, '0x65000000', '0x64000000');
ok('installed firewall MARK confirms expected value and selector', tx.verify_runtime(runtime, runtime.after, tables));
// Running dnsmasq must contain the requested resolver policy and every
// managed domain membership; a service reload acknowledgement is insufficient.
let dnsfile = '/tmp/nvtx_dns_' + time() + '.conf';
runtime.reloads = [ 'dhcp' ]; runtime.changes = []; runtime.after.network = {}; runtime.after.firewall = {};
runtime.after.dhcp = { dns: { '.type': 'dnsmasq', nordvpn_dns_lock: 'nv_media', nordvpn_dns_servers: [ '103.86.96.100' ] } };
tx.adapters.run = function(argv) { return { code: 0, stdout: sprintf('%J', { dnsmasq: { instances: { dns: { running: true, command: [ 'dnsmasq', '-C', dnsfile ] } } } }) }; };
writefile(dnsfile, 'server=103.86.96.100\n');
ok('running dnsmasq without no-resolv cannot confirm the requested DNS lock', !tx.verify_runtime(runtime, runtime.after, tables));
writefile(dnsfile, 'no-resolv\nserver=103.86.96.100\n');
ok('running dnsmasq config confirms complete requested DNS lock', tx.verify_runtime(runtime, runtime.after, tables));
runtime.after.dhcp.domain = { '.type': 'ipset', nordvpn_managed: '1', nordvpn_iface: 'nv_media', name: [ 'nv_nv_media_dom' ], domain: [ 'example.com' ] };
ok('missing domain membership cannot be called installed DNS policy', !tx.verify_runtime(runtime, runtime.after, tables));
writefile(dnsfile, 'no-resolv\nserver=103.86.96.100\nnftset=/example.com/4#inet#fw4#nv_nv_media_dom\n');
ok('running dnsmasq config confirms requested domain-to-set membership', tx.verify_runtime(runtime, runtime.after, tables));
unlink(dnsfile);
tx.adapters.run = function(argv) {
	let a = argv[0] == 'timeout' ? slice(argv, 2) : argv;
	return a[1] == 'list' ? { code: 0, stdout: '' } : { code: 4, stdout: '' };
};
ok('successful empty ubus listing identifies absent new/deleted interface', tx.interface_state('nv_media').absent);
tx.adapters.run = function() { return { code: 127, stdout: '' }; };
ok('missing ubus is never mistaken for a safely down interface', tx.interface_state('nv_media') == null);
reset(); global.MOCK_UCI.nordvpn_credentials = { _state: { '.type': 'state', migrated: '1' } };
global.MOCK_UCI.network.nv_media.private_key = KEY;
r = apply.apply(cursor(), 'main', 'save', 0);
ok('missing bank key fails before detached planning and never takes an old tunnel down', r.state == 'failure' && r.error == 'no credentials configured' && !counts.ifdown && !counts['commit:network']);
reset(); tx.adapters.run = function() { return { code: 127, stdout: '' }; };
ok('missing WireGuard never becomes a healthy handshake', !apply.verify_handshake('nv_media', 1));
printf('%s\n', failures ? 'FAILURES: ' + failures : 'routing transaction tests passed');
exit(failures ? 1 : 0);
