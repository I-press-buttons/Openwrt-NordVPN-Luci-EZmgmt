// SPDX-License-Identifier: MIT
'use strict';
const jobs = require('nordvpn.jobs');
let fails = 0;
function ok(label, condition) {
	printf('%s %s\n', condition ? 'ok  ' : 'FAIL', label);
	if (!condition) fails++;
}
let data = null, epoch = 1000, mono = 10, serial = 0, alive = true;
let locked = {}, writes = true, executed = 0, throw_read = false, terminal_owned = false;
let slot = jobs.create('/test/status', {
	read: function() { if (throw_read) die('injected storage read failure'); return data ? json(sprintf('%J', data)) : null; },
	write: function(value) { if (!writes) return false; if (value.phase == 'done') terminal_owned = !!locked['/test/status.execution.lock']; data = json(sprintf('%J', value)); return true; },
	lock: function(path) { if (locked[path]) return null; locked[path] = true; return { path: path }; },
	unlock: function(token) { delete locked[token.path]; },
	clock: function() { return epoch; },
	uptime: function() { return mono; },
	pid: function() { return 42; },
	identity: function(pid) { return alive ? 'process-' + pid : null; },
	id: function() { return 'job-' + (++serial); }
});
function reserve() { return slot.reserve('main', 'apply', { source: 'save' }, 300); }
let first = reserve();
ok('reservation publishes queued before spawn', first.apply.phase == 'queued' && data.id == first.apply.id);
let duplicate = reserve();
ok('duplicate start shares reservation ID', duplicate.already_running && duplicate.apply.id == first.apply.id);
let result = slot.run(first.apply.id, 'main', 'apply', function() { executed++; return { state: 'success' }; });
ok('worker completes before spawn returns', result.state == 'success' && data.state == 'done');
slot.spawned(first.apply.id, 42);
ok('launcher cannot replace completed result', data.state == 'done' && data.result.state == 'success');
let second = reserve();
ok('consecutive operations have distinct IDs', first.apply.id != second.apply.id);
ok('exact ID retrieves older terminal result', slot.status(first.apply.id).state == 'done');
slot.run(first.apply.id, 'main', 'apply', function() { executed++; });
ok('late old worker cannot claim new job', data.id == second.apply.id && data.phase == 'queued' && executed == 1);
slot.fail(second.apply.id, 'spawn failed');
ok('spawn failure is terminal', data.state == 'failed' && data.error == 'spawn failed');
writes = false;
ok('missing status storage refuses reservation', !!reserve().error);
writes = true;

// Exercise the actual launcher handoff with a synchronous fake child.
let fast = slot.start('main', 'apply', { source: 'save' }, 300, function(st) {
	slot.run(st.id, 'main', 'apply', function() { return { state: 'success' }; });
	return { pid: 42 };
});
ok('start itself cannot regress a completed child', fast.started && data.state == 'done');
let spawned_failure = slot.start('main', 'apply', {}, 300, function() { return { error: 'spawn refused' }; });
ok('launcher failure publishes its own terminal ID', spawned_failure.error == 'spawn refused' && data.error == 'spawn refused');
let thrown_spawn = slot.start('main', 'apply', {}, 300, function() { die('spawn exception'); });
ok('thrown spawn failure reaches status', thrown_spawn.error && data.state == 'failed');
let dead = reserve();
alive = false;
slot.spawned(dead.apply.id, 99);
ok('dead worker recovers without waiting for queue deadline', slot.status(dead.apply.id).state == 'failed');
alive = true;
let queued = reserve();
mono += jobs.QUEUE_TIMEOUT + 1;
ok('unclaimed queued job expires while launcher remains alive', slot.status(queued.apply.id).state == 'failed');
let clock_job = reserve();
let frozen = false, replacement_blocked = false;
let clock_result = slot.run(clock_job.apply.id, 'main', 'apply', function() {
	epoch += 1000000;
	frozen = slot.status().phase == 'running';
	epoch -= 2000000;
	frozen = frozen && slot.status().phase == 'running';
	mono += 301;
	let timeout = slot.status();
	replacement_blocked = timeout.state == 'failed' && reserve().busy;
	return { state: 'success' };
});
ok('wall clock changes do not abandon a healthy worker', frozen);
ok('runtime timeout never releases live execution ownership', replacement_blocked);
ok('late timeout completion cannot overwrite terminal failure', clock_result.error && data.state == 'failed');
let cannot_claim = reserve();
writes = false;
let attempted = slot.run(cannot_claim.apply.id, 'main', 'apply', function() { executed++; });
ok('claim storage failure prevents work and releases execution', attempted.error && executed == 1 && !locked['/test/status.execution.lock']);
writes = true;
slot.fail(cannot_claim.apply.id, 'cleanup');
let cannot_finish = reserve();
let finished_error = slot.run(cannot_finish.apply.id, 'main', 'apply', function() {
	writes = false;
	return { state: 'success' };
});
ok('terminal storage failure never returns success', finished_error.error && data.phase == 'running' && !locked['/test/status.execution.lock']);
writes = true;
alive = false;
ok('failed terminal publication recovers after worker exit', slot.status().state == 'failed');
alive = true;
let throws = reserve();
throw_read = true;
let thrown = slot.run(throws.apply.id, 'main', 'apply', function() { executed++; });
ok('thrown metadata failure releases execution and metadata', thrown.error && length(locked) == 0);
throw_read = false;
slot.fail(throws.apply.id, 'cleanup');
let live = reserve();
let checked_ownership = false;
let owned_finish = slot.run(live.apply.id, 'main', 'apply', function() {
	checked_ownership = !!locked['/test/status.execution.lock'];
	return { state: 'success' };
});
ok('execution ownership covers work and terminal publication', checked_ownership && terminal_owned && owned_finish.state == 'success');
for (let n = 0; n < jobs.HISTORY_LIMIT + 2; n++) {
	let next = reserve();
	slot.fail(next.apply.id, 'bounded history fixture');
}
ok('terminal history is bounded', length(data.history) == jobs.HISTORY_LIMIT);
ok('evicted exact ID never falls back to latest', slot.status(first.apply.id).state == 'missing');
ok('legacy no-ID query returns latest', slot.status().id == data.id);
data = null;
ok('missing storage exact ID never falls back to idle', slot.status('absent-id').state == 'missing');
printf('%s\n', fails ? 'JOB TESTS FAILED' : 'JOB TESTS PASSED');
exit(fails ? 1 : 0);
