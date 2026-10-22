// SPDX-License-Identifier: MIT
// Shared generation journal and bounded observations. Never stores credentials
// or raw HTTP bodies. Mutation and publication serialize on the same lock.
'use strict';
import { readfile } from 'fs';
const c = require('nordvpn.common');
const LIMIT = 16;
const PATH = '/tmp/nordvpn_probe_cache.json';

function create(adapters) {
	let a = adapters || {};
	let read = a.read || function() {
		try { return json(readfile(PATH) || '{}'); } catch (e) { return {}; }
	};
	let write = a.write || function(value) { return c.atomic_write(PATH, sprintf('%J', value)); };
	let lock = a.lock || function() { return c.acquire_advisory(PATH + '.lock'); };
	let unlock = a.unlock || c.release_advisory;
	let uuid = a.id || function() { return trim(readfile('/proc/sys/kernel/random/uuid') || ''); };
	function load() {
		let value = read();
		return { versions: value && type(value.versions) == 'array' ? value.versions : [],
			records: value && type(value.records) == 'array' ? value.records : [] };
	}
	function transaction(work) {
		let token = null;
		for (let n = 0; n < 50 && !token; n++) {
			token = lock();
			if (!token) sleep(10);
		}
		if (!token) return { error: 'probe cache is busy or unavailable; retry' };
		let result;
		try { result = work(load(), write); }
		catch (e) { result = { error: 'probe cache storage failed' }; }
		unlock(token);
		return result;
	}
	function version(data, name) {
		for (let v in data.versions) if (v.instance == name) return v.id;
		return 'uninitialized';
	}
	function initialize(data, name) {
		let id = uuid();
		if (!id) return false;
		data.versions = filter(data.versions, (v) => v.instance != name);
		push(data.versions, { instance: name, id: id });
		while (length(data.versions) > LIMIT * 2) shift(data.versions);
		return true;
	}
	function bump(names) {
		return transaction(function(data, save) {
			for (let name in names) {
				if (!initialize(data, name)) return { error: 'probe generation identity unavailable' };
			}
			return save(data) ? { ok: true } : { error: 'could not invalidate probe generation' };
		});
	}
	return { load, transaction, version, bump, initialize };
}
const store = create();
return { create, store, LIMIT };
