// SPDX-License-Identifier: MIT
// Mutation order: sorted instance ownership, then short shared configuration.
// No configuration lock may span HTTP requests or handshake verification.
'use strict';
import { cursor } from 'uci';
const c = require('nordvpn.common');
const CONFIG_LOCK = '/tmp/nordvpn_configuration.lock';

// Reject aliased interfaces before touching their peer. The package creates
// unique interfaces; hand-edited aliases cannot safely have separate owners.
function validate_owner(uci, name) {
	if (uci.get('nordvpn', name) == null)
		return 'no such instance';
	let iface = c.load_settings(uci, name).interface;
	if (!c.managed_interface(uci, iface))
		return 'interface ' + iface + ' is not managed by nordvpn';
	for (let other in c.list_instances(uci))
		if (other != name && c.load_settings(uci, other).interface == iface)
			return 'interface ' + iface + ' is also used by instance ' + other;
	return null;
}

function names_sorted(names) {
	let out = [];
	for (let name in names) {
		if (!c.validate_instance(name))
			die('invalid instance name');
		if (index(out, name) < 0)
			push(out, name);
	}
	return sort(out);
}

function release(locks) {
	for (let token in (locks || []))
		c.release_advisory(token);
}

// Never wait with a partial set: release everything before retrying. CLI and
// workers may wait; interactive paths pass zero (the default).
function acquire(names, wait) {
	names = names_sorted(names);
	for (let attempt = 0; ; attempt++) {
		let locks = [], busy = null;
		for (let name in names) {
			let token = c.acquire_advisory(c.tunnel_lock_path(name));
			if (!token) {
				busy = name;
				break;
			}
			push(locks, token);
		}
		if (busy == null) {
			// Invalidate even a reconnect to the same gateway. Probes cannot
			// start or publish while these instance locks remain held.
			let invalidated = require('nordvpn.probe_state').store.bump(names);
			if (invalidated.error) {
				release(locks);
				return { busy: true, error: invalidated.error, instances: names };
			}
			return { locks: locks, instances: names };
		}
		release(locks);
		if (attempt >= (wait || 0) * 10)
			return { busy: true, instance: busy, instances: names,
				error: 'a mutation of instance ' + busy + ' is running; retry when it finishes' };
		sleep(100);
	}
}

function configuration(work, wait) {
	let lock = null;
	for (let i = 0; ; i++) {
		lock = c.acquire_advisory(CONFIG_LOCK);
		if (lock || i >= (wait || 0) * 10)
			break;
		sleep(100);
	}
	if (!lock)
		die('shared VPN configuration is busy; retry when it finishes');
	let result;
	try {
		// Never reuse a cursor opened before ownership: libuci caches packages.
		result = work(cursor());
	} catch (e) {
		c.release_advisory(lock);
		die(e);
	}
	c.release_advisory(lock);
	return result;
}

// Used by credential operations and migration. Lock the whole configured set
// conservatively, then revalidate membership under the shared lock. Creation
// and deletion also use the shared lock, so new users cannot escape ownership.
function all(work) {
	for (let attempt = 0; attempt < 3; attempt++) {
		let names = names_sorted(c.list_instances(cursor()));
		let owner = acquire(names);
		if (owner.busy)
			return { ...owner, succeeded: [], errors: [ { instance: owner.instance, busy: true, error: owner.error } ] };
		let result;
		try {
			result = configuration(function(uci) {
				if (sprintf('%J', names_sorted(c.list_instances(uci))) != sprintf('%J', names))
					return { retry_membership: true };
				return work(uci, names);
			});
		} catch (e) {
			release(owner.locks);
			return { busy: index('' + e, 'busy') >= 0, error: '' + e, succeeded: [], errors: map(names, (n) => ({ instance: n, error: '' + e })) };
		}
		release(owner.locks);
		if (type(result) != 'object' || !result.retry_membership)
			return result;
	}
	return { error: 'VPN instance list changed; retry' };
}

return { CONFIG_LOCK, validate_owner, names_sorted, acquire, release, configuration, all };
