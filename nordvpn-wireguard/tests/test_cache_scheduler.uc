// SPDX-License-Identifier: MIT
'use strict';
import { readfile } from 'fs';
const service = require('nordvpn.service');
let source = readfile(replace(RPCD, 'usr/share/rpcd/ucode/nordvpn.uc', 'usr/bin/nordvpn-service'));
// Execute the actual daemon outcome helper with an explicit state adapter;
// uloop/netifd are unavailable on the host and are not treated as success.
let begin = index(source, 'function refresh_result(');
let end = index(source, '// The server-list cache is shared');
let latest = { id: 'first' }, fails = 0;
global.SCHED_LATEST = function() { return latest; };
let scheduler = loadstring(`
let refresh_job = 'first', cache_path = 'cache', last_cache = 1, refresh_fails = 0;
const _cache = { read_fetch_status: global.SCHED_LATEST };
function log(message) {}
` + substr(source, begin, end - begin) + `
return {
 result: refresh_result,
 watch: function(id) { refresh_job = id; },
 snapshot: function() { return { id: refresh_job, last: last_cache, fails: refresh_fails }; }
};`)();
function ok(label, condition) { printf('%s %s\n', condition ? 'ok  ' : 'FAIL', label); if (!condition) fails++; }
scheduler.result('first', 'cache', { error: 'spawn failed' });
let first = scheduler.snapshot();
ok('spawn failure updates scheduler failure streak', first.fails == 1 && first.id == null && first.last > 1);
ok('spawn failure retries with backoff instead of full refresh interval',
	!service.should_refresh({ cache_refresh_interval: 21600 }, first.last, first.last + 1, first.fails) &&
	service.should_refresh({ cache_refresh_interval: 21600 }, first.last, first.last + 300, first.fails));
latest.id = 'second'; scheduler.watch('second');
scheduler.result('first', 'cache', { ok: true });
ok('late old callback cannot reset new failure streak', scheduler.snapshot().fails == 1 && scheduler.snapshot().id == 'second');
scheduler.result('second', 'cache', { error: 'dead worker' });
ok('death recovery uses the same failure backoff path once', scheduler.snapshot().fails == 2);
scheduler.result('second', 'cache', { error: 'late callback' });
ok('same worker outcome is folded once', scheduler.snapshot().fails == 2);
latest.id = 'third'; scheduler.watch('third');
scheduler.result('third', 'cache', { ok: true });
ok('successful publication resets failure streak at completion', scheduler.snapshot().fails == 0 && scheduler.snapshot().last >= first.last);

// Startup guard: arguments print the usage, and a second copy never runs.
let gbegin = index(source, '// procd starts the daemon without arguments.');
let gend = index(source, '// One-time move of per-interface keys');
ok('the startup guard runs before the first scheduler work', gbegin > 0 && gend > gbegin);
let guard = function(argv, lock_free) {
	let out = { exit: null, locked: false, said: '' };
	global.GUARD_OUT = out;
	try {
		loadstring(`
let ARGV = ` + sprintf('%J', argv) + `;
function warn(m) { global.GUARD_OUT.said += m; }
function log(m) { global.GUARD_OUT.said += m; }
function exit(c) { global.GUARD_OUT.exit = c; die('exit'); }
const _common = { acquire_advisory: function(p) { global.GUARD_OUT.locked = p; return ` + (lock_free ? '{}' : 'null') + `; } };
` + substr(source, gbegin, gend - gbegin))();
	} catch (e) {}
	return out;
};
let g = guard([ 'help' ], true);
ok('`help` prints the usage and exits 0 without starting', g.exit == 0 && index(g.said, 'usage') >= 0 && !g.locked);
g = guard([ 'start' ], true);
ok('an unknown argument exits 2 without starting', g.exit == 2 && !g.locked);
g = guard([], true);
ok('procd\'s plain start takes the daemon lock and continues', g.exit == null && g.locked == '/var/run/nordvpn-service.lock');
g = guard([], false);
ok('a second daemon refuses to start', g.exit == 1 && index(g.said, 'already running') >= 0);

// The WAN default check: a missing main-table default starts one repair.
let wbegin = index(source, 'let wan_heal = 0;');
let wend = index(source, '// An exception escaping a uloop callback');
ok('the WAN default check is part of the daemon', wbegin > 0 && wend > wbegin && index(source, 'wan_default_step(now);') > 0);
global.WAN = { route: '', started: 0 };
let wan = loadstring(`
const PROBE_STUCK = 120;
function in_flight(since, now, ceiling) { return since > 0 && now >= since && (now - since) < ceiling; }
function errmsg(e) { return '' + e; }
const _common = { run: function() { return { code: 0, stdout: global.WAN.route }; }, drop_inherited_locks: function() {} };
const tasks = { start: function(work, done) { global.WAN.started++; global.WAN.done = done; return {}; } };
` + substr(source, wbegin, wend - wbegin) + `
return wan_default_step;`)();
global.WAN.route = 'default via 192.0.2.1 dev wan\n';
wan(1000);
ok('a present default route needs nothing', global.WAN.started == 0);
global.WAN.route = '';
wan(1030);
ok('a missing default route starts a repair', global.WAN.started == 1);
wan(1060);
ok('... only one at a time', global.WAN.started == 1);
global.WAN.done({ ok: true });
wan(1090);
ok('a finished repair lets the next tick look again', global.WAN.started == 2);
exit(fails ? 1 : 0);
