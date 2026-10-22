// SPDX-License-Identifier: MIT
// Exercise the real RPC loops and scheduler tick with deterministic local I/O.
'use strict';
import { cursor } from 'uci';
import { readfile, unlink, writefile } from 'fs';
const c = require('nordvpn.common');
let fails = 0;
function ok(label, value) { printf('%s %s\n', value ? 'ok  ' : 'FAIL', label); if (!value) fails++; }
function eq(label, got, expected) { ok(label, sprintf('%J', got) == sprintf('%J', expected)); }
let commands = [], dump = [], handshakes = '', transfers = '', epoch = time();
let handshake_code = 0, transfer_code = 0;
c.run = function(argv) {
	push(commands, argv);
	if (argv[0] == 'wg') {
		let all = argv[2] == 'all', field = argv[3], text = field == 'transfer' ? transfers : handshakes;
		if (!all) {
			let lines = [];
			for (let line in split(trim(text), '\n')) {
				let parts = split(line, '\t');
				if (parts[0] == argv[2]) push(lines, join('\t', slice(parts, 1)));
			}
			text = join('\n', lines);
		}
		return { code: field == 'transfer' ? transfer_code : handshake_code, stdout: text };
	}
	if (argv[0] == 'ubus') return { code: 0, stdout: sprintf('%J', { interface: dump }) };
	return { code: 1, stdout: '' };
};
const runtime = require('nordvpn.status');
const service = require('nordvpn.service');
const rpc = loadfile(RPCD)().nordvpn;
function fixture(count, enabled) {
	global.MOCK_UCI = { nordvpn: {}, network: {} };
	global.MOCK_UBUS = {};
	dump = []; handshakes = ''; transfers = '';
	for (let i = 0; i < count; i++) {
		let name = i == 0 ? 'main' : 'tunnel' + i, iface = 'nv_' + i, dev = 'wg_' + i;
		global.MOCK_UCI.nordvpn[name] = { '.type': 'instance', interface: iface,
			enabled: enabled ? '1' : '0', watchdog: '1', egress_probe: '0' };
		global.MOCK_UCI.network[iface] = { '.type': 'interface', private_key: KEY };
		global.MOCK_UCI.network['peer' + i] = { '.type': 'wireguard_' + iface, interface: iface,
			endpoint_host: '192.0.2.1', endpoint_port: '51820', nordvpn_gateway: 'server' + i };
		let net = { interface: iface, up: true, l3_device: dev, uptime: 42 + i };
		push(dump, net);
		// Keep the old per-interface response too: the baseline's process and
		// connection growth must fail the regression for the intended reason.
		global.MOCK_UBUS['network.interface.' + iface + '~status'] = net;
		handshakes += dev + '\tpeer\t' + (epoch - 10) + '\n';
		transfers += dev + '\tpeer\t' + (100 + i) + '\t' + (20 + i) + '\n';
	}
	global.MOCK_UBUS['network.interface~dump'] = { interface: dump };
}
function reset_counts() {
	commands = [];
	global.MOCK_UBUS_CONNECTS = 0;
	global.MOCK_UBUS_CALLS = [];
}
function bounded(label) {
	let wg = filter(commands, (argv) => argv[0] == 'wg');
	eq(label + ': exactly the two safe all-interface commands', wg,
		[ [ 'wg', 'show', 'all', 'latest-handshakes' ], [ 'wg', 'show', 'all', 'transfer' ] ]);
	eq(label + ': one ubus connection', global.MOCK_UBUS_CONNECTS, 1);
	eq(label + ': one netifd dump', global.MOCK_UBUS_CALLS, [ 'network.interface~dump' ]);
	eq(label + ': no extra shell ubus dump', length(filter(commands, (argv) => argv[0] == 'ubus')), 0);
	eq(label + ': all connections closed', global.MOCK_UBUS_OPEN || 0, 0);
}

// Execute the daemon's real tick/instance_step functions. Only independent
// rotation, cache and task I/O are adapted; runtime collection is the real module.
let source = readfile(replace(RPCD, 'usr/share/rpcd/ucode/nordvpn.uc', 'usr/bin/nordvpn-service'));
let begin = index(source, 'function instance_step('), end = index(source, '// Re-check every 30s;');
global.STATUS_TEST_DEPS = { common: c, runtime: runtime, service: service, cursor: cursor };
let tick = loadstring(`
const d = global.STATUS_TEST_DEPS, _common = d.common, _status = d.runtime;
const status = _status.status, load_settings = _common.load_settings, list_instances = _common.list_instances;
const cursor = d.cursor, should_rotate = d.service.should_rotate, watchdog_update = d.service.watchdog_update;
const effective_state = d.service.effective_state, should_probe = d.service.should_probe;
const should_recover = d.service.should_recover, watchdog_result_update = d.service.watchdog_result_update;
const probe_clear = d.service.probe_clear, PROBE_STUCK = 120;
let probing = {};
function read_state(name) { return {}; }
function record(fields, name) {}
function mark_attempt(now, name) { die('unexpected scheduled rotation'); }
function refresh_step(uci, now) {}
function errmsg(e) { return '' + e; }
function log(message) { die(message); }
function in_flight() { return false; }
function start_probe() { die('unexpected egress probe'); }
function record_event() { die('unexpected watchdog recovery'); }
const uloop = { task: function() { die('unexpected worker'); } };
` + substr(source, begin, end - begin) + '\nreturn tick;')();
for (let count in [ 1, 4, 8 ]) {
	fixture(count, true);
	for (let method in [ 'overview', 'instances' ]) {
		reset_counts();
		let result = rpc[method].call();
		bounded(method + ' with ' + count + ' instances');
		eq(method + ': output count', length(result.instances), count);
		ok(method + ': preserves mapped L3 device health', result.instances[0].state == 'connected');
		eq(method + ': preserves counters', result.instances[count - 1].transfer,
			{ rx_bytes: 99 + count, tx_bytes: 19 + count });
		if (method == 'overview') {
			eq('overview performs no routing processes', length(commands), 2);
			ok('overview stays light and secret-free', result.instances[0].routing == null && index(sprintf('%J', result), KEY) < 0);
		}
	}
	reset_counts(); tick(); bounded('scheduler with ' + count + ' active instances');
	reset_counts(); tick(); bounded('scheduler recollects on the next tick with ' + count + ' instances');
	fixture(count, false);
	reset_counts(); tick();
	eq('idle scheduler with ' + count + ' instances collects nothing', [ commands, global.MOCK_UBUS_CONNECTS ], [ [], 0 ]);
}

ok('collector API is present', type(runtime.collect_runtime) == 'function');
if (type(runtime.collect_runtime) != 'function') exit(1);

// One deterministic clock drives all handshake ages and no per-instance status
// builder performs I/O once a snapshot is supplied.
fixture(1, true);
function collect() { return runtime.collect_runtime([ c.load_settings(cursor(), 'main') ], epoch); }
handshakes = 'wg_0\told\t' + (epoch - 200) + '\nwg_0\tnew\t' + (epoch - 180) + '\nforeign\tpeer\t' + epoch + '\n';
transfers = 'wg_0\told\t100\t20\nwg_0\tnew\t5\t1\nforeign\tpeer\t900\t900\n';
let snap = collect(), settings = c.load_settings(cursor(), 'main');
let before = sprintf('%J', snap);
let pure = runtime.runtime_status(snap, settings.interface);
eq('pure interpretation preserves snapshot bytes', sprintf('%J', snap), before);
eq('pure interpretation reports mapped interface status', pure, { state: 'connected', device: 'wg_0', uptime: 42,
	transfer: { rx_bytes: 105, tx_bytes: 21 }, latest_handshake_seconds: 180 });
reset_counts();
let st = runtime.status(cursor(), 'main', settings, snap);
eq('snapshot construction starts no process or connection', [ commands, global.MOCK_UBUS_CONNECTS ], [ [], 0 ]);
eq('newest peer handshake and summed counters', [ st.state, st.latest_handshake_seconds, st.transfer, st.device, st.uptime ],
	[ 'connected', 180, { rx_bytes: 105, tx_bytes: 21 }, 'wg_0', 42 ]);
eq('snapshot timestamp is fixed', snap.at, epoch);
ok('foreign devices are excluded', snap.handshakes.foreign == null && snap.transfers.foreign == null);

for (let test in [
	{ seconds: 181, state: 'degraded' }, { seconds: 180, state: 'connected' },
	{ seconds: 0, state: 'connected' }, { seconds: -10, state: 'connected' }
]) {
	handshakes = 'wg_0\tpeer\t' + (epoch - test.seconds) + '\n';
	st = runtime.status(cursor(), 'main', settings, collect());
	eq('handshake threshold ' + test.seconds, [ st.state, st.latest_handshake_seconds ], [ test.state, max(0, test.seconds) ]);
}
for (let text in [ '', 'wg_0\tpeer\t0\n', 'wg_0\tpeer\t123oops\n', 'wg_0\tpeer\t-1\n',
	'wg_0\tpeer\t99999999999999999999999999\n',
	'wg_0\tpeer\t' + epoch + '\nwg_0\tpeer\t' + epoch + '\n',
	'wg_0\tgood\t' + epoch + '\nwg_0\tbad\tgarbage\n', 'wg_0\tpeer\t' + epoch + '\textra\n', 'wg_0\tpeer\t' + epoch + '\t\n' ]) {
	handshakes = text;
	st = runtime.status(cursor(), 'main', settings, collect());
	eq('missing or malformed handshake is never healthy', [ st.state, st.latest_handshake_seconds ], [ 'connecting', null ]);
}
handshakes = 'wg_0\tpeer\t' + epoch + '\n';
for (let text in [ '', 'wg_0\tpeer\t5\toops\n', 'wg_0\tpeer\t-1\t1\n',
	'wg_0\tpeer\t9999999999999999999999999\t1\n',
	'wg_0\ta\t9223372036854775800\t1\nwg_0\tb\t20\t1\n',
	'wg_0\tgood\t5\t1\nwg_0\tbad\toops\t1\n', 'wg_0\tpeer\t5\t1\nwg_0\tpeer\t5\t1\n' ]) {
	transfers = text;
	eq('missing or malformed peer counters stay unknown', runtime.status(cursor(), 'main', settings, collect()).transfer, null);
}
transfers = 'wg_0\tpeer\t0\t0\n';
eq('observed reset counters remain real zeros', runtime.status(cursor(), 'main', settings, collect()).transfer, { rx_bytes: 0, tx_bytes: 0 });
handshake_code = 1;
st = runtime.status(cursor(), 'main', settings, collect());
eq('handshake command failure preserves independent counters', [ st.state, st.latest_handshake_seconds, st.transfer ],
	[ 'connecting', null, { rx_bytes: 0, tx_bytes: 0 } ]);
handshake_code = 0; transfer_code = 1;
st = runtime.status(cursor(), 'main', settings, collect());
eq('transfer command failure preserves independently observed handshake', [ st.state, st.transfer ], [ 'connected', null ]);
transfer_code = 0;
reset_counts();
st = runtime.status(cursor(), 'main', settings);
bounded('legacy individual status caller');
eq('legacy caller collects a current sample', st.state, 'connected');
dump[0].l3_device = 'wg-media.0';
handshakes = 'wg-media.0\tpeer\t' + epoch + '\n';
transfers = 'wg-media.0\tpeer\t10\t20\n';
st = runtime.status(cursor(), 'main', settings, collect());
eq('Linux L3 names retain dots and hyphens', [ st.device, st.state, st.transfer ],
	[ 'wg-media.0', 'connected', { rx_bytes: 10, tx_bytes: 20 } ]);
dump[0].l3_device = 'wg_0';
handshakes = 'wg_0\tpeer\t' + epoch + '\n';
transfers = 'wg_0\tpeer\t0\t0\n';
dump[0].up = 'true';
st = runtime.status(cursor(), 'main', settings, collect());
eq('malformed netifd up flag cannot make a healthy connection', st.state, 'disconnected');
dump[0].up = true; dump[0].l3_device = 'wg;bad';
st = runtime.status(cursor(), 'main', settings, collect());
eq('malformed device mapping cannot fabricate health', st.state, 'disconnected');
dump[0].l3_device = 'wg_0'; dump[0].up = false;
st = runtime.status(cursor(), 'main', settings, collect());
eq('down interface keeps disconnected semantics', [ st.state, st.transfer, st.uptime ], [ 'disconnected', null, null ]);
dump[0].up = true;
global.MOCK_UBUS['network.interface~dump'] = { interface: [] };
st = runtime.status(cursor(), 'main', settings, collect());
eq('disappeared device cannot reuse the previous sample', [ st.state, st.transfer, st.uptime, st.latest_handshake_seconds ],
	[ 'disconnected', null, null, null ]);
global.MOCK_UBUS['network.interface~dump'] = { interface: dump };
global.MOCK_UBUS_THROW = true;
reset_counts(); snap = collect();
eq('throwing ubus call still closes the connection', global.MOCK_UBUS_OPEN, 0);
eq('failed netifd collection cannot manufacture healthy state', runtime.status(cursor(), 'main', settings, snap).state, 'disconnected');
global.MOCK_UBUS_THROW = false;
global.MOCK_UBUS_CONNECT_THROW = true;
reset_counts(); snap = collect();
eq('throwing ubus connect becomes unavailable data', runtime.status(cursor(), 'main', settings, snap).state, 'disconnected');
global.MOCK_UBUS_CONNECT_THROW = false;

// A malformed observation for one device must not poison another instance.
fixture(2, true);
let all_settings = map(c.list_instances(cursor()), (name) => c.load_settings(cursor(), name));
transfers += 'wg_0\tbad\toops\t1\n';
let partial = runtime.collect_runtime(all_settings, epoch);
eq('bad peer counters are isolated to their device',
	map(all_settings, (s) => runtime.status(cursor(), s.name, s, partial).transfer),
	[ null, { rx_bytes: 101, tx_bytes: 21 } ]);
fixture(1, true);
reset_counts();
eq('single-instance RPC preserves live state', rpc.status.call({ args: { instance: 'main' } }).state, 'connected');
bounded('single-instance RPC');
delete global.MOCK_UCI.network.nv_0.private_key;
reset_counts(); st = runtime.status(cursor(), 'main');
eq('unconfigured legacy caller preserves fields',
	[ st.state, st.configured, st.device, st.transfer, st.latest_handshake_seconds ],
	[ 'not_configured', false, null, null, null ]);
eq('unconfigured legacy caller needs no runtime collection', [ commands, global.MOCK_UBUS_CONNECTS ], [ [], 0 ]);

// Retain effective-state semantics in both RPCs, including configured disabled
// instances (enabled remains an administrative flag, separate from live state).
fixture(1, false);
const rotate = require('nordvpn.rotate');
let saved_state = readfile('/tmp/nordvpn_rotate_state.json');
rotate.record({ probe_server: 'server0', probe_fails: c.PROBE_FAIL_THRESHOLD }, 'main');
global.MOCK_UCI.nordvpn.main.egress_probe = '1';
for (let method in [ 'overview', 'instances' ]) {
	let result = rpc[method].call().instances[0];
	eq(method + ': disabled flag and no-egress folding preserved', [ result.enabled, result.state ], [ false, 'no_egress' ]);
}
if (saved_state == null) unlink('/tmp/nordvpn_rotate_state.json');
else writefile('/tmp/nordvpn_rotate_state.json', saved_state);
exit(fails ? 1 : 0);
