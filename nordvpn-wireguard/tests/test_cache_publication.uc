// SPDX-License-Identifier: MIT
'use strict';
import { readfile, unlink } from 'fs';
const c = require('nordvpn.common');
const cache = require('nordvpn.cache');
const jobs = require('nordvpn.jobs');
let fails = 0;
function ok(label, condition) { printf('%s %s\n', condition ? 'ok  ' : 'FAIL', label); if (!condition) fails++; }
let sample = json(readfile(fixture));
let path = '/tmp/nordvpn_publication_' + c.self_pid();
let old = 'previous usable bytes';

// Fail every filesystem boundary explicitly. A temporary is removed, and no
// failed write or close is allowed to reach rename.
for (let failure in [ 'short', 'write', 'close', 'rename', 'throw' ]) {
	let removed = false, replaced = false, closed = false;
	let result = c.atomic_write(path, 'hello', {
		open: function() { return {
			write: function(body) { if (failure == 'throw') die('write failed'); return failure == 'short' ? 2 : failure == 'write' ? null : length(body); },
			close: function() { closed = true; return failure != 'close'; }
		}; },
		rename: function() { replaced = true; return false; },
		unlink: function() { removed = true; return true; }
	});
	ok('checked writer cleans ' + failure, !result && removed && closed);
	ok('checked writer stops before rename after ' + failure, failure == 'rename' ? replaced : !replaced);
}
ok('real old cache bytes written', c.atomic_write(path, old));
let data = null, locked = {}, serial = 0, alive = true, mono = 10, epoch = 1000;
let writes = true, fail_terminal = false, terminal_owned = false, phases = [];
let slot = jobs.create(path + '.status', {
	read: function() { return data ? json(sprintf('%J', data)) : null; },
	write: function(st) {
		if (!writes || (fail_terminal && st.phase == 'done')) return false;
		if (st.progress && st.progress.phase == 'validating') phases[2] = 'validating';
		if (st.phase == 'done') terminal_owned = !!locked[path + '.status.execution.lock'];
		data = json(sprintf('%J', st)); return true;
	},
	lock: function(p) { if (locked[p]) return null; locked[p] = true; return { path: p }; },
	unlock: function(t) { delete locked[t.path]; },
	id: function() { return 'refresh-' + (++serial); },
	pid: function() { return 42; }, identity: function() { return alive ? 'owner' : null; },
	uptime: function() { return mono; }, clock: function() { return epoch; }
}, { live_until_exit: true });
function http() {
	phases[0] = data.progress.phase;
	// The old 600-second ownership age and the scheduler's 1800-second
	// deadline must not supersede a legitimate live pagination request.
	mono += 100000; epoch -= 100000;
	ok('long live refresh keeps ownership across clock changes', slot.status().state == 'running');
	let duplicate = slot.reserve('cache', 'refresh', { path: path }, 0);
	ok('busy loser preserves exact running status', duplicate.already_running && duplicate.apply.id == data.id);
	return { ok: true, body: sprintf('%J', sample) };
}
let result = cache.fetch_and_build(path, null, { slot: slot, http: http, write: function(p, body) {
	phases[1] = data.progress.phase;
	ok('old bytes survive until publishing', readfile(p) == old && data.state == 'running');
	return c.atomic_write(p, body);
} });
ok('done follows readable publication', !result.error && data.state == 'done' && cache.read_cache(path).generation == data.id);
ok('fetching and publishing exposed', phases[0] == 'fetching' && phases[1] == 'publishing' && phases[2] == 'validating');
ok('terminal publication occurs under execution ownership', terminal_owned);
ok('status stores compact publication metadata', !data.result.cache && !data.result.countries && data.result.generation == result.generation);
let usable = readfile(path);
for (let body in [ '[]', 'not json', '[null,42,{}]' ]) {
	result = cache.fetch_and_build(path, null, { slot: slot, http: function() { return { ok: true, body: body }; } });
	ok('bad or empty response rejected: ' + body, result.error && data.state == 'failed' && readfile(path) == usable);
}
let page = [];
for (let i = 0; i < c.PAGE_SIZE; i++) push(page, sample[0]);
let requests = 0;
result = cache.fetch_and_build(path, null, { slot: slot, http: function() {
	return ++requests == 1 ? { ok: true, body: sprintf('%J', page) } : { ok: false, error: 'later page failed' };
} });
ok('later pagination failure preserves old cache', requests == 2 && result.error == 'later page failed' && readfile(path) == usable);
result = cache.fetch_and_build(path, null, { slot: slot, http: http, write: function() { return false; } });
ok('publication failure cannot report done or replace bytes', result.error && data.state == 'failed' && readfile(path) == usable);
let malformed = cache.normalize(sample);
malformed.countries[0].cities[0].relays[0].public_key = 'bad';
ok('required normalized gateway fields checked before write', !cache.write_cache(malformed, path) && readfile(path) == usable);
fail_terminal = true;
result = cache.fetch_and_build(path, null, { slot: slot, http: http });
ok('terminal storage ambiguity retains newly published cache', result.error && result.cache_published && cache.read_cache(path).generation == data.id && data.state == 'running');
fail_terminal = false; alive = false;
ok('worker exit recovers failed terminal publication', slot.status().state == 'failed');
alive = true;
let reserved = slot.reserve('cache', 'refresh', { path: path }, 0);
locked[path + '.status.execution.lock'] = true;
result = cache.fetch_and_build(path, reserved.apply.id, { slot: slot });
ok('execution busy is an explicit error', result.error == 'refresh already in progress');
delete locked[path + '.status.execution.lock']; slot.fail(reserved.apply.id, 'cleanup');
writes = false;
ok('unavailable reservation storage prevents work', cache.fetch_and_build(path, null, { slot: slot }).error != null);
// New data that is replaced but cannot be read must be reported as ambiguous.
writes = true;
result = cache.fetch_and_build(path, null, { slot: slot, http: http, read: function() { return null; } });
ok('unreadable replacement is explicitly identified', result.error && result.cache_published && data.state == 'failed');
for (let st in data.history) ok('history never retains server tree', !st.result || (!st.result.cache && !st.result.countries));
// Exercise the actual production slot/report mapping, including fast spawn
// handoff and missing exact-ID status, rather than only the adapter lifecycle.
let status_before = readfile(c.FETCH_STATUS_FILE);
let fast = cache.spawn_refresh(path, function(st) {
	let result = cache.fetch_and_build(path, st.id, { http: function() { return { ok: true, body: sprintf('%J', sample) }; } });
	ok('real reservation completes before spawn returns', !result.error);
	return { pid: c.self_pid() };
});
let report = cache.fetch_status_report(null, fast.job || fast.apply.id);
ok('real terminal report remains done after launcher handoff', report.state == 'done' && report.phase == 'done');
let queued_path = cache.reserve_refresh(path);
let different_path = cache.spawn_refresh(path + '.new', function() { die('different-path duplicate must not spawn'); });
ok('changed cache path cannot deduplicate to old-path success', different_path.busy && different_path.error);
cache.fail_refresh(queued_path.apply.id, 'cleanup');
let failed_spawn = cache.spawn_refresh(path, function() { return { error: 'spawn failed' }; });
ok('spawn failure is visible through legacy error state', failed_spawn.error && cache.fetch_status_report().state == 'error');
let current_id = cache.read_fetch_status().id;
unlink(c.FETCH_STATUS_FILE);
ok('exact ID with vanished status reports missing', cache.fetch_status_report(null, current_id).state == 'missing');
if (status_before) c.atomic_write(c.FETCH_STATUS_FILE, status_before);

unlink(path);
exit(fails ? 1 : 0);
