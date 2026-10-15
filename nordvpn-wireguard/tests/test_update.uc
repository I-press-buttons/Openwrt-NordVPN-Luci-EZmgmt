#!/usr/bin/ucode -S
// SPDX-License-Identifier: MIT
// Offline updater tests: all commands are stubbed, no package manager runs.
'use strict';
import { writefile, stat, unlink, readfile } from 'fs';
const c = require('nordvpn.common');
const u = require('nordvpn.update');
let fails = 0;
function ok(label, cond) { printf('%s %s\n', cond ? 'ok' : 'FAIL', label); if (!cond) fails++; }
function eq(label, got, want) { ok(label, sprintf('%J', got) == sprintf('%J', want)); }
eq('latest default', u.version(null), 'latest');
eq('plain version', u.version('1.8.0'), 'v1.8.0');
eq('nightly tag', u.version('v1.8.0-r20261015'), 'v1.8.0-r20261015');
for (let bad in [ '../v1.8.0', '-1.8.0', '1.8.0\n', '1.8.0;id', '1.8.0$(id)', 'https://example.org', 'v', 123 ])
	eq('reject invalid version ' + bad, u.version(bad), null);
let original = c.run;
let commands = [], downloads = [], install_count = 0, fail_download = 0, apk_code = 0, resolver = 'v1.8.0';
c.run = function(argv) {
	push(commands, argv);
	if (argv[0] == 'curl') {
		let o = index(argv, '--output');
		if (argv[o + 1] == '/dev/null')
			return { code: 0, stdout: 'https://github.com/I-press-buttons/Openwrt-NordVPN-Luci-EZmgmt/releases/tag/' + resolver };
		push(downloads, argv[o + 1]);
		writefile(argv[o + 1], 'mock apk');
		return { code: length(downloads) == fail_download ? 22 : 0, stdout: '' };
	}
	if (argv[2] == 'command -v apk') return { code: 0, stdout: '/sbin/apk' };
	install_count++;
	return { code: apk_code, stdout: 'mock apk output' };
};
let r = u.install('latest', function() {});
eq('latest resolves a single pinned tag', r.version, 'v1.8.0');
eq('one APK transaction', install_count, 1);
let urls = map(filter(commands, (a) => a[0] == 'curl'), (a) => a[length(a)-1]);
ok('both downloads pinned to same tag', index(urls[1], '/download/v1.8.0/') >= 0 && index(urls[2], '/download/v1.8.0/') >= 0);
for (let path in downloads) ok('temporary APK removed', !stat(path));
ok('temporary directory removed', !stat(replace(downloads[0], /\/[^/]+$/, '')));
commands = []; downloads = []; install_count = 0; fail_download = 2;
r = u.install('v1.7.0', function() {});
ok('second download failure reported', r.error != null);
eq('failed download never runs apk', install_count, 0);
for (let path in downloads) ok('failed download cleaned', !stat(path));
downloads = []; fail_download = 0; apk_code = 1;
r = u.install('v1.8.0', function() {});
ok('installer failure reported with output', r.error != null && r.output == 'mock apk output');
for (let path in downloads) ok('installer failure cleaned', !stat(path));
resolver = '../../other';
r = u.install('latest', function() {});
ok('unsafe redirect tag rejected', r.error != null);
eq('invalid RPC version never launches worker', u.start('1.8.0;id').error != null, true);
// The CLI and UI share the same lock, and interrupted workers are visible.
let real_acquire = c.acquire_lock;
c.acquire_lock = function() { return null; };
let before = length(commands);
ok('CLI refuses concurrent updates', u.run('latest').error != null);
ok('RPC refuses concurrent updates', u.start('latest').error != null);
eq('busy updater runs no commands', length(commands), before);
c.acquire_lock = real_acquire;
let saved_status = readfile('/tmp/nordvpn_update.json');
let saved_lock = readfile('/tmp/nordvpn_update.lock');
writefile('/tmp/nordvpn_update.json', '{"state":"running","pid":2147483647}');
writefile('/tmp/nordvpn_update.lock', '1 2147483647');
eq('dead worker reads as error', u.status().state, 'error');
if (saved_status != null) writefile('/tmp/nordvpn_update.json', saved_status);
else unlink('/tmp/nordvpn_update.json');
if (saved_lock != null) writefile('/tmp/nordvpn_update.lock', saved_lock);
else unlink('/tmp/nordvpn_update.lock');
c.run = original;
exit(fails ? 1 : 0);
