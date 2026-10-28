// SPDX-License-Identifier: MIT
'use strict';
const create = require('nordvpn.task_guard').create;
let fds = 20, restarts = 0, messages = [], done = false, fails = 0;
function ok(label, value) {
	printf('%s %s\n', value ? 'ok  ' : 'FAIL', label);
	if (!value) fails++;
}
const loop = {
	task: function(worker, callback) { return { finished: function() { return done; } }; },
	error: function() { return 'test spawn failure'; }
};
let guard = create(loop, { count: function() { return fds; }, limit: 192,
	recycle: function() { restarts++; }, log: function(message) { push(messages, message); } });
ok('healthy scheduler stays running', !guard.check() && restarts == 0);
guard.start(function() {}, function() {});
fds = 192;
ok('active worker prevents recycle even under pressure', !guard.check() && restarts == 0);
done = true;
ok('completed workers allow recycle at threshold', guard.check() && restarts == 1);
ok('resource recycle explains itself', length(messages) == 1 && index(messages[0], '192 open') >= 0);
fds = 191;
ok('below threshold stays running', !guard.check() && restarts == 1);
loop.task = function() { return null; };
let error = null;
try { guard.start(function() {}); } catch (e) { error = '' + e; }
ok('spawn failure is surfaced', error && index(error, 'test spawn failure') >= 0);
exit(fails ? 1 : 0);
