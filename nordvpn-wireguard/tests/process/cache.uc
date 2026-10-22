// SPDX-License-Identifier: MIT
'use strict';
import { readfile, writefile } from 'fs';
const c = require('nordvpn.common');
const cache = require('nordvpn.cache');
let mode = ARGV[0], path = ARGV[1];
let slot = require('nordvpn.jobs').create(path + '.status', null, { live_until_exit: true });
if (mode == 'status') printf('%J\n', slot.status(ARGV[2]));
else if (mode == 'reserve') printf('%J\n', slot.reserve('cache', 'refresh', { path: path }, 0));
else if (mode == 'publish') {
	let padding = '';
	for (let i = 0; i < 10000; i++) padding += 'x';
	for (let i = 0; i < 100; i++)
		if (!c.atomic_write(path, sprintf('%J', { generation: i % 2 ? 'new' : 'old', padding: padding }))) exit(1);
} else {
	let progress = slot.progress;
	slot.progress = function(id, details) {
		let result = progress(id, details);
		if (result && details.phase == ARGV[2]) {
			writefile(path + '.ready', id);
			sleep(20000);
		}
		return result;
	};
	let result = cache.fetch_and_build(path, null, { slot: slot, http: function() {
		return { ok: true, body: readfile(ARGV[3]) };
	} });
	printf('%J\n', result);
	if (result.error) exit(1);
}
