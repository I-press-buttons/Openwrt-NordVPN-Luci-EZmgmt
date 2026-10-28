// SPDX-License-Identifier: MIT
'use strict';
import { writefile } from 'fs';
const jobs = require('nordvpn.jobs');
let mode = ARGV[0], path = ARGV[1];
let slot = jobs.create(path);
if (mode == 'status') {
	printf('%J\n', slot.status(ARGV[2]));
} else if (mode == 'reserve') {
	printf('%J\n', slot.reserve('main', 'apply', { source: 'external' }, 300));
} else {
	let reserved = slot.reserve('main', 'apply', { source: 'external' }, 300);
	if (!reserved.started) { printf('%J\n', reserved); exit(1); }
	let result = slot.run(reserved.apply.id, 'main', 'apply', function() {
		if (mode == 'hold') {
			writefile(path + '.ready', reserved.apply.id);
			sleep(20000);
		}
		return { state: 'success' };
	});
	printf('%J\n', result);
	if (result.error) exit(1);
}
