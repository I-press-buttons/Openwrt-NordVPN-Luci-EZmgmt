// SPDX-License-Identifier: MIT
// Explicit offline execution fixture. Missing router executables are never
// interpreted as a production success. Runtime verification has focused tests.
'use strict';
function install(adapters) {
	let tables = null, outcomes = {};
	adapters.read_outcome = function(name) { return outcomes[name]; };
	adapters.write_outcome = function(name, record) { outcomes[name] = record; return true; };
	adapters.read_tables = function() { return tables; };
	adapters.write_tables = function(value) { tables = value; return true; };
	adapters.verify = function() { return true; };
	adapters.pause = function() {};
	adapters.run = function(argv) {
		let cmd = argv[0] == 'timeout' ? slice(argv, 2) : argv;
		if (cmd[0] == 'wg') return { code: 0, stdout: 'key\t' + time() + '\n' };
		// Existing connection-selection fixtures explicitly simulate failed
		// bring-up, and a currently healthy peer for the no-restart path.
		if (cmd[0] == 'ifup') return { code: 1, stdout: '' };
		if (cmd[0] == 'ubus' && cmd[2] && index(cmd[2], 'network.interface.') == 0)
			return { code: 0, stdout: '{"up":true,"l3_device":"nordvpn"}' };
		return { code: 0, stdout: '' };
	};
}
return { install };
