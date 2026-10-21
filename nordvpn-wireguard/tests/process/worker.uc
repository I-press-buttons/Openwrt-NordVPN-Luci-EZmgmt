// SPDX-License-Identifier: MIT
'use strict';
import { writefile, readfile } from 'fs';
import { cursor } from 'uci';
const c = require('nordvpn.common');
const m = require('nordvpn.mutation');
let mode = ARGV[0], path = ARGV[1], first = ARGV[2], second = ARGV[3];
if (mode == 'hold' || mode == 'hold_exec') {
	let token = c.acquire_advisory(path);
	if (!token) exit(3);
	if (mode == 'hold_exec') {
		// The shell exec closes advisory descriptors before spawning sleep.
		let result = c.run([ 'sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!' ]);
		writefile(path + '.child', trim(result.stdout));
	}
	writefile(path + '.ready', 'ready');
	while (true) sleep(100);
}
if (mode == 'try') {
	let token = c.acquire_advisory(path);
	if (!token) exit(3);
	c.release_advisory(token);
	exit(0);
}
if (mode == 'old_release') {
	let old = c.acquire_advisory(path);
	c.release_advisory(old);
	let current = c.acquire_advisory(path);
	if (!current) die('new owner missing');
	c.release_advisory(old);
	if (c.acquire_advisory(path)) die('old release unlocked the new owner');
	c.release_advisory(current);
	exit(0);
}
if (mode == 'write' || mode == 'reverse') {
	// This cursor must never be used to write after waiting for ownership.
	let stale = cursor();
	writefile(path + '.ready', 'ready');
	let owner = m.acquire(mode == 'reverse' ? [ second, first ] : [ first ], 10);
	if (owner.busy) die(owner.error);
	try {
		for (let i = 0; i < 30; i++) {
			m.configuration(function(fresh) {
				let value = int(fresh.get('network', 'counters', first) || 0);
				sleep(2);
				fresh.set('network', 'counters', first, value + 1);
				fresh.commit('network');
			}, 10);
			// A verification wait keeps ownership but frees shared config.
			sleep(2);
		}
	} catch (e) {
		m.release(owner.locks);
		die(e);
	}
	m.release(owner.locks);
	exit(0);
}
if (mode == 'fanout') {
	let result = m.all(function(fresh, names) {
		let value = int(fresh.get('network', 'counters', 'fanout') || 0);
		sleep(20);
		fresh.set('network', 'counters', 'fanout', value + 1);
		fresh.commit('network');
		return { ok: true };
	});
	if (result.busy) exit(3);
	if (!result.ok) die(result.error);
	exit(0);
}
die('unknown process test mode');
