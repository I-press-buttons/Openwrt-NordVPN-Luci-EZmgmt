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
exit(fails ? 1 : 0);
