// SPDX-License-Identifier: MIT
// Global firewall reload boundaries, with explicit nft/process adapters.
'use strict';
import { cursor } from 'uci';
const tx = require('nordvpn.routing_transaction');
let failures = 0;
function ok(label, value) { printf('%s %s\n', value ? 'ok' : 'FAIL', label); if (!value) failures++; }
function same(a, b) { return sprintf('%J', a) == sprintf('%J', b); }
let events, restored, runtime, fail, calls, outcomes, pending_observed;
function reset() {
	global.MOCK_UCI = { nordvpn: {}, firewall: {}, network: {}, dhcp: {} };
	events = []; restored = []; runtime = []; fail = {}; calls = {}; outcomes = {}; pending_observed = false;
	for (let owner in [ 'main', 'other' ]) {
		let iface = 'wg_' + owner;
		global.MOCK_UCI.nordvpn[owner] = { '.type': 'instance', interface: iface, enabled: '1' };
		for (let role in [ 'domain', 'bypass' ]) {
			let name = 'nv_' + iface + (role == 'domain' ? '_dom' : '_byp');
			global.MOCK_UCI.firewall[name] = { '.type': 'ipset', name, family: 'ipv4', match: [ 'dest_ip' ],
				nordvpn_managed: '1', nordvpn_iface: iface, nordvpn_role: role + '_set' };
			global.MOCK_UCI.dhcp[name] = { '.type': 'ipset', name: [ name ], domain: [ role + '.' + owner + '.test' ],
				nordvpn_set: name, table: 'fw4', table_family: 'inet', family: '4',
				nordvpn_managed: '1', nordvpn_iface: iface, nordvpn_role: role + '_dns' };
			push(runtime, { set: { family: 'inet', table: 'fw4', name, type: 'ipv4_addr', elem: [ '1.2.3.4' ] } });
		}
	}
	tx.adapters.read_tables = function() { return ''; };
	tx.adapters.read_outcome = function(name) { return outcomes[name]; };
	tx.adapters.write_outcome = function(name, record) { outcomes[name] = record; return true; };
	tx.adapters.commit = function(c, pkg) { push(events, 'commit:' + pkg); return true; };
	tx.adapters.verify = function() { return true; };
	tx.adapters.pause = function() {};
	tx.adapters.run = function(argv) {
		let a = argv[0] == 'timeout' ? slice(argv, 2) : argv;
		let event = a[0] == 'nft' ? join(' ', slice(a, 0, 4)) : a[0];
		push(events, event); calls[event] = (calls[event] || 0) + 1;
		if (a[0] == '/etc/init.d/firewall') pending_observed = !tx.confirmation(cursor(), 'other').confirmed;
		if (fail[event] == calls[event] || (type(fail[event]) == 'array' && index(fail[event], calls[event]) >= 0)) return { code: 1, stdout: '' };
		if (a[0] == 'nft' && a[1] == '-j') return { code: 0, stdout: sprintf('%J', { nftables: a[3] == 'tables' ? [] : runtime }) };
		if (a[0] == 'nft' && a[1] == 'add') push(restored, { name: a[5], elements: a[6] });
		return { code: 0, stdout: '' };
	};
	outcomes.other = { ok: true, stage: 'complete', generation: tx.plan(cursor(), function() { return { interface: 'wg_other', instance: 'other' }; }).desired_generation };
}
function plan(edit) {
	return tx.plan(cursor(), function(c) {
		c.set('firewall', 'device', 'rule'); c.set('firewall', 'device', 'name', 'device changed');
		if (edit) edit(c);
		return { interface: 'wg_main', instance: 'main', routing_policy: true };
	});
}
function names() { return map(restored, (s) => s.name); }
const ALL = [ 'nv_wg_main_byp', 'nv_wg_main_dom', 'nv_wg_other_byp', 'nv_wg_other_dom' ];
reset(); let p = plan(), result = tx.execute(cursor(), p);
ok('device-only apply preserves steering and bypass sets for both instances', result.ok && same(names(), ALL));
ok('capture runs after commits immediately before the global firewall reload', same(slice(events, 0, 3), [ 'commit:firewall', 'nft -j list table', '/etc/init.d/firewall' ]));
ok('fully preserved domain sets need no dnsmasq reload', index(p.reloads, 'dhcp') < 0 && !calls['/etc/init.d/dnsmasq']);
ok('other-instance confirmation is pending before reload and restored after success', pending_observed && tx.confirmation(cursor(), 'other').confirmed);
reset(); outcomes.other.ok = false; p = plan(); result = tx.execute(cursor(), p);
ok('successful preservation does not certify previously unconfirmed instances', result.ok && !tx.confirmation(cursor(), 'other').confirmed);
reset(); global.MOCK_UCI.nordvpn.other.killswitch = '1'; p = plan(); result = tx.execute(cursor(), p);
ok('successful preservation never updates a stale preference generation', result.ok && !tx.confirmation(cursor(), 'other').confirmed);
reset(); p = plan(function(c) { c.set('dhcp', 'nv_wg_other_dom', 'domain', [ 'new.test' ]); }); result = tx.execute(cursor(), p);
ok('domain removal invalidates only that whole set, including another instance', result.ok && same(names(), slice(ALL, 0, 3)) && calls['/etc/init.d/dnsmasq'] == 1);
reset(); p = plan(function(c) { c.set('dhcp', 'nv_wg_other_dom', 'domain', [ 'added.test', 'domain.other.test', 'domain.other.test' ]); }); result = tx.execute(cursor(), p);
ok('adding/reordering/duplicating domains retains existing valid addresses', result.ok && same(names(), ALL));
for (let mode in [ 'disabled', 'deleted', 'swapped', 'removed' ]) {
	reset(); p = plan(function(c) {
		if (mode == 'disabled') c.set('nordvpn', 'other', 'enabled', '0');
		if (mode == 'deleted') c.delete('nordvpn', 'other');
		if (mode == 'swapped') { c.set('nordvpn', 'other', 'interface', 'wg_main'); c.set('nordvpn', 'main', 'interface', 'wg_other'); }
		if (mode == 'removed') { c.delete('firewall', 'nv_wg_other_dom'); c.delete('firewall', 'nv_wg_other_byp'); }
	}); result = tx.execute(cursor(), p);
	ok(mode + ' ownership never resurrects old memberships', result.ok && (mode == 'swapped' ? !length(restored) : same(names(), slice(ALL, 0, 2))));
}
reset(); splice(runtime, 2, 1); p = plan(); result = tx.execute(cursor(), p);
ok('missing runtime set is recreated and refilled by global DNS reload', result.ok && same(names(), slice(ALL, 0, 3)) && calls['/etc/init.d/dnsmasq'] == 1);
reset(); runtime = []; fail['nft -j list table'] = 1; p = plan(); result = tx.execute(cursor(), p);
ok('absent fw4 table established by successful inventory can refill', result.ok && !length(restored) && calls['/etc/init.d/dnsmasq'] == 1);
reset(); fail['nft -j list table'] = 1; fail['nft -j list tables'] = 1; p = plan(); result = tx.execute(cursor(), p);
ok('capture tool failure stops before firewall reload and restores configuration', !result.ok && result.stage == 'capture:elements' && result.rollback.ok && !calls['/etc/init.d/firewall']);
reset(); fail['/etc/init.d/firewall'] = 1; p = plan(function(c) { c.delete('firewall', 'nv_wg_other_dom'); c.delete('dhcp', 'nv_wg_other_dom'); }); result = tx.execute(cursor(), p);
ok('failed reload restores every previous set including a deleted set', !result.ok && result.stage == 'reload:firewall' && result.rollback.ok && same(names(), ALL));
reset(); fail['nft add element inet'] = 1; p = plan(); result = tx.execute(cursor(), p);
ok('failed forward restore reports its stage and restores previous global sets', !result.ok && result.stage == 'restore:elements' && result.rollback.ok && same(names(), ALL));
ok('complete compensation restores prior other-instance confirmation', tx.confirmation(cursor(), 'other').confirmed);
reset(); fail['nft add element inet'] = [ 4, 5 ]; p = plan(); result = tx.execute(cursor(), p);
ok('failed other-instance restore and compensation stay unconfirmed in a fresh status cursor', !result.ok && result.stage == 'restore:elements' && !result.rollback.ok && !tx.confirmation(cursor(), 'other').confirmed && outcomes.other.stage == 'applying:firewall');
reset(); let publish = tx.adapters.write_outcome;
tx.adapters.write_outcome = function(name, record) { return name == 'other' && record.ok ? false : publish(name, record); };
p = plan(); result = tx.execute(cursor(), p);
ok('failed cross-instance terminal publication leaves durable uncertainty', !result.ok && result.stage == 'record:global_result' && !tx.confirmation(cursor(), 'other').confirmed);
reset(); fail['/etc/init.d/firewall'] = 1; fail['nft add element inet'] = 1; p = plan(); result = tx.execute(cursor(), p);
ok('failed rollback element restore remains separate from original error', !result.ok && result.stage == 'reload:firewall' && !result.rollback.ok);
reset(); runtime[0].set.elem = [];
for (let i = 1; i <= 600; i++) push(runtime[0].set.elem, '10.0.' + int(i / 256) + '.' + (i % 256));
p = plan(); result = tx.execute(cursor(), p);
ok('large sets restore in bounded 256-address batches', result.ok && length(filter(restored, (s) => s.name == 'nv_wg_main_dom')) == 3);
reset(); push(runtime, { set: { family: 'inet', table: 'fw4', name: 'user_set', type: 'ipv4_addr', elem: [ '9.8.7.6' ] } });
p = plan(); result = tx.execute(cursor(), p);
ok('unmanaged runtime set membership is never restored', result.ok && same(names(), ALL));
reset(); runtime[0].set.elem = [ { prefix: { addr: '1.2.3.0', len: 24 } } ]; p = plan(); result = tx.execute(cursor(), p);
ok('unsupported runtime elements fail explicitly before destructive reload', !result.ok && result.stage == 'capture:elements' && !calls['/etc/init.d/firewall']);
reset(); p = plan(); p.activation = { before_configuration: true, stage: 'ifdown:wg_main', argv: [ 'ifdown', 'wg_main' ], restore_argv: [ 'ifup', 'wg_main' ] };
fail['nft -j list table'] = 1; fail['nft -j list tables'] = 1; result = tx.execute(cursor(), p);
ok('capture failure after early teardown never triggers an uncaptured rollback reload', !result.ok && result.rollback.ok && !calls['/etc/init.d/firewall'] && calls.ifup == 1);
printf('%s\n', failures ? 'FAILURES: ' + failures : 'domain preservation tests passed');
exit(failures ? 1 : 0);
