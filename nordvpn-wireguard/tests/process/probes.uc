// SPDX-License-Identifier: MIT
'use strict';
import { readfile, writefile, stat } from 'fs';
const c = require('nordvpn.common');
let mode = ARGV[0], path = ARGV[1];
let store = require('nordvpn.probe_state').create({
	read: function() { return json(readfile(path + '.cache') || '{}'); },
	write: function(data) { return c.atomic_write(path + '.cache', sprintf('%J', data)); },
	lock: function() { return c.acquire_advisory(path + '.cache.lock'); }
});
let slot = require('nordvpn.jobs').create(path + '.job');
let probe = require('nordvpn.probes').create({ store: store, slot: slot,
	context: function(name, data) {
		return { instance: name, enabled: true, available: true, interface: 'nordvpn', gateway: 'same.nordvpn.com',
			legacy_lan: false, generation: store.version(data, name) };
	},
	lock: function() { return c.acquire_advisory(path + '.instance.lock'); },
	spawn: function() { return { pid: c.self_pid() }; },
	insights: function() {
		writefile(path + '.ready', slot.read().id);
		for (let n = 0; n < 500 && !stat(path + '.release'); n++) sleep(10);
		return { ip: '1.2.3.4', protected: true };
	}
});
if (mode == 'status') printf('%J\n', probe.status('main', ARGV[2]));
else if (mode == 'start') printf('%J\n', probe.start('main'));
else if (mode == 'invalidate') {
	let token = c.acquire_advisory(path + '.instance.lock');
	if (!token) exit(1);
	let result = store.bump([ 'main' ]);
	c.release_advisory(token);
	printf('%J\n', result);
} else {
	store.bump([ 'main' ]);
	let reservation = slot.reserve('main', 'probe', {
		instance: 'main', enabled: true, available: true, interface: 'nordvpn', gateway: 'same.nordvpn.com',
		legacy_lan: false, generation: store.version(store.load(), 'main')
	}, 25);
	if (!reservation.started) { printf('%J\n', reservation); exit(1); }
	printf('%J\n', probe.run('main', reservation.apply.id));
}
