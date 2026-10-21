// SPDX-License-Identifier: MIT
// Filesystem-backed UCI adapter for separate-process mutation tests. Each
// cursor deliberately caches its own snapshot, like libuci. No shared globals.
'use strict';
import { readfile, writefile, rename } from 'fs';
export function cursor() {
	let data = json(readfile(global.PROCESS_STORE));
	return {
		get: function(pkg, sec, opt) {
			let s = data[pkg] ? data[pkg][sec] : null;
			return !s ? null : (opt == null ? s['.type'] : s[opt]);
		},
		foreach: function(pkg, type_, cb) {
			for (let sec in (data[pkg] || {}))
				if (type_ == null || data[pkg][sec]['.type'] == type_)
					cb({ ...data[pkg][sec], '.name': sec });
		},
		set: function(pkg, sec, opt, value) { data[pkg][sec][opt] = value; },
		commit: function() {
			let tmp = global.PROCESS_STORE + '.new';
			if (writefile(tmp, sprintf('%J', data)) == null || !rename(tmp, global.PROCESS_STORE))
				die('process test publication failed');
			return true;
		}
	};
}
