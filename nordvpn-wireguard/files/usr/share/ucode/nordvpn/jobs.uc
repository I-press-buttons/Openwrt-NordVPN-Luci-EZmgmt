// SPDX-License-Identifier: MIT
// Reusable background execution slots. Metadata ownership never spans spawn or
// work; execution ownership spans claim, work and terminal publication.
'use strict';
import { readfile, open, rename, unlink } from 'fs';
const c = require('nordvpn.common');
const HISTORY_LIMIT = 16;
const QUEUE_TIMEOUT = 30;

function uptime() {
	let raw = readfile('/proc/uptime');
	return raw ? int(split(raw, ' ')[0]) : null;
}

// PID reuse must not turn a dead worker into a healthy one. Linux field 22 is
// the process start time; split after comm (which may itself contain spaces).
function identity(pid) {
	let raw = readfile('/proc/' + pid + '/stat');
	if (!raw) return null;
	let end = rindex(raw, ')');
	let fields = split(substr(raw, end + 2), ' ');
	if (end < 0 || length(fields) < 20 || fields[0] == 'Z') return null;
	return fields[19];
}

function read(path) {
	try {
		let raw = readfile(path);
		let value = raw ? json(raw) : null;
		return type(value) == 'object' ? value : null;
	} catch (e) { return null; }
}

// Job storage is checked independently of the cache's legacy atomic writer.
function write(path, value) {
	let tmp, file;
	for (let attempt = 0; attempt < 100; attempt++) {
		tmp = path + '.tmp.' + c.self_pid() + '.' + attempt;
		file = open(tmp, 'wxe', 0600);
		if (file) break;
	}
	if (!file) return false;
	let body = sprintf('%J', value);
	let complete = file.write(body) == length(body);
	let closed = file.close();
	if (!complete || !closed || !rename(tmp, path)) {
		unlink(tmp);
		return false;
	}
	return true;
}

function create(path, adapters, options) {
	let opts = options || {};
	let a = adapters || {};
	let load = a.read || function() { return read(path); };
	let save = a.write || function(value) { return write(path, value); };
	let lock = a.lock || c.acquire_advisory;
	let unlock = a.unlock || c.release_advisory;
	let clock = a.clock || time;
	let monotonic = a.uptime || uptime;
	let pid = a.pid || c.self_pid;
	let process = a.identity || identity;
	let new_id = a.id || function() {
		let raw = readfile('/proc/sys/kernel/random/uuid');
		return raw ? trim(raw) : null;
	};
	let metadata_path = path + '.metadata.lock';
	let execution_path = path + '.execution.lock';

	function metadata(work) {
		let token = null;
		// Bounded contention: only local record reads/writes are protected.
		for (let attempt = 0; attempt < 50 && !token; attempt++) {
			token = lock(metadata_path);
			if (!token) sleep(10);
		}
		if (!token) return { error: 'job metadata is busy or unavailable; retry' };
		let result;
		try { result = work(); }
		catch (e) { result = { error: 'job metadata storage error: ' + e }; }
		unlock(token);
		return result;
	}

	function public_record(st) {
		if (!st) return null;
		let out = { ...st };
		delete out.history;
		// Older clients see queued as running; phase carries the exact state.
		if (out.phase == 'queued') out.state = 'running';
		return out;
	}

	function publish(st) {
		st.updated_at_epoch = clock();
		st.updated_at = c.iso_ts(st.updated_at_epoch);
		return save(st);
	}

	function active(st, now) {
		if (type(st) != 'object' || st.state != 'running') return false;
		// Legacy records have wall clock timestamps only. Retain their recovery
		// rules until the first new job replaces them after a package upgrade.
		if (!st.id) {
			now = now == null ? clock() : now;
			let started = st.started_at_epoch;
			let max = st.max_runtime;
			if (type(max) != 'int' || max < c.APPLY_MAX_RUNTIME || max > c.JOB_MAX_RUNTIME_CAP)
				max = c.APPLY_MAX_RUNTIME;
			return type(started) == 'int' && started > 0 && started <= now + 60 &&
				now - started <= max && (!st.pid || process(st.pid) != null);
		}
		// Some bounded, paginated workers have no useful total wall deadline.
		if (opts.live_until_exit && st.phase == 'running')
			return !!(st.pid && st.owner && process(st.pid) == st.owner);
		let stamp = st.phase == 'queued' ? st.queued_at_uptime : st.started_at_uptime;
		let current_uptime = monotonic();
		if (current_uptime == null) return false;
		let age = current_uptime - stamp;
		let limit = st.phase == 'queued' ? QUEUE_TIMEOUT : st.max_runtime;
		if (type(stamp) != 'int' || age < 0 || age > limit) return false;
		if (st.phase == 'queued')
			return !st.pid || (st.owner && process(st.pid) == st.owner);
		return st.pid && st.owner && process(st.pid) == st.owner;
	}

	function terminal(st, error, result) {
		st.state = error ? 'failed' : 'done';
		st.phase = st.state;
		st.finished_at_epoch = clock();
		st.finished_at = c.iso_ts(st.finished_at_epoch);
		st.finished_at_uptime = monotonic();
		st.worker_pid = st.pid;
		st.pid = null;
		st.result = result || { error: error };
		st.error = error || null;
		return publish(st);
	}

	function recover(st, now) {
		if (st && st.state == 'running' && !active(st, now)) {
			st.stale = true;
			let error = st.phase == 'queued' ? 'the worker did not claim its queued job in time'
				: 'the ' + (st.kind == 'rotate' ? 'rotation' : (st.kind || 'apply')) + ' worker stopped unexpectedly';
			if (st.id && st.phase == 'running' && st.pid && process(st.pid) == st.owner)
				error = 'the worker exceeded its runtime limit; ownership remains held until it exits';
			if (!terminal(st, error, null))
				return { error: 'could not publish abandoned job status', state: 'unavailable' };
		}
		return st;
	}

	function reserve(instance, kind, context, max_runtime) {
		return metadata(function() {
			let old = recover(load());
			if (old && old.state == 'unavailable') return old;
			if (old && old.state == 'running') {
				if (old.instance == instance && (old.kind || 'apply') == kind)
					return { already_running: true, apply: public_record(old) };
				return { busy: true, error: (old.kind == 'rotate' ? 'a rotation' : 'an apply') +
					' of instance ' + old.instance + ' is still running; try again when it finishes' };
			}
			// A timed-out live worker keeps its execution slot, even after the
			// watcher gets a terminal error. Never steal live ownership by age.
			let execution = lock(execution_path);
			if (!execution) return { busy: true, error: 'a worker still owns this execution slot; retry when it exits' };
			unlock(execution);
			let id = new_id(), owner_pid = pid(), owner = process(owner_pid), up = monotonic();
			if (!id || !owner_pid || !owner || up == null)
				return { error: 'job identity or monotonic clock is unavailable' };
			let history = old ? [ ...(old.history || []) ] : [];
			if (old && old.id) push(history, public_record(old));
			while (length(history) > HISTORY_LIMIT) shift(history);
			let now = clock();
			let st = { id: id, instance: instance, kind: kind, context: context || {},
				state: 'running', phase: 'queued', pid: null, owner: null,
				launcher_pid: owner_pid, launcher_owner: owner,
				queued_at: c.iso_ts(now), queued_at_epoch: now, queued_at_uptime: up,
				started_at: null, started_at_epoch: null,
				max_runtime: max_runtime, finished_at: null, result: null, error: null, history: history };
			if (!publish(st)) return { error: 'could not reserve job status storage' };
			return { started: true, instance: instance, apply: public_record(st) };
		});
	}

	function spawned(id, worker_pid) {
		return metadata(function() {
			let st = load();
			if (!st || st.id != id || st.phase != 'queued') return public_record(st);
			let owner = process(worker_pid);
			// A worker which already exited will be recovered on the next read.
			st.pid = worker_pid;
			st.owner = owner;
			if (!publish(st)) return { error: 'could not publish worker handoff' };
			return public_record(st);
		});
	}

	function fail(id, error) {
		return metadata(function() {
			let st = load();
			if (!st || st.id != id || st.phase != 'queued') return public_record(st);
			if (!terminal(st, error, null)) return { error: 'could not publish worker start failure' };
			return public_record(st);
		});
	}

	function start(instance, kind, context, max_runtime, spawn) {
		let reservation = reserve(instance, kind, context, max_runtime);
		if (!reservation.started) return reservation;
		let id = reservation.apply.id, child;
		// No metadata lock is held here: the child may finish before spawn
		// returns. Launcher updates are conditional on the queued phase.
		try { child = spawn(reservation.apply); }
		catch (e) { child = { error: 'could not spawn worker: ' + e }; }
		if (!child || child.error || !child.pid) {
			let error = (child && child.error) || 'worker spawn returned no process ID';
			let failed = fail(id, error);
			return { error: error, apply: failed };
		}
		let handed = spawned(id, child.pid);
		if (handed && handed.error && !handed.id)
			return { error: handed.error, apply: reservation.apply };
		// Return the immutable reserved ID even if a later job already exists.
		return reservation;
	}

	function status(id, now) {
		return metadata(function() {
			let st = load();
			if (id && (!st || st.id != id)) {
				// Reading an older outcome must not depend on recovering or
				// writing the unrelated latest job's status.
				for (let previous in ((st && st.history) || []))
					if (previous.id == id) return public_record(previous);
				return { id: id, state: 'missing', error: 'job status is unavailable or expired' };
			}
			return public_record(recover(st, now));
		});
	}

	function progress(id, details) {
		return metadata(function() {
			let st = load();
			if (!st || st.id != id || st.phase != 'running' || st.pid != pid() || st.owner != process(pid()))
				return false;
			st.progress = details;
			return publish(st);
		}) == true;
	}

	function run(id, instance, kind, work) {
		let execution = lock(execution_path);
		if (!execution) return { skipped: true, reason: kind == 'apply' ? 'apply already running' : 'an apply or rotation is already running' };
		function owned() {
			let claimed = metadata(function() {
				let st = load();
				if (!st || st.id != id || st.instance != instance || st.kind != kind || st.phase != 'queued')
					return { error: 'job reservation is missing, replaced or already claimed' };
				if (!active(st)) return { error: 'job reservation expired' };
				let worker_pid = pid(), owner = process(worker_pid);
				if (!owner) return { error: 'worker process identity is unavailable' };
				st.phase = 'running';
				st.pid = worker_pid;
				st.owner = owner;
				st.started_at_epoch = clock();
				st.started_at = c.iso_ts(st.started_at_epoch);
				st.started_at_uptime = monotonic();
				if (!publish(st)) return { error: 'could not publish running job status' };
				return public_record(st);
			});
			if (claimed.error) return claimed;
			let result;
			try { result = work(instance, claimed.context); }
			catch (e) { result = { error: kind + ' error: ' + e, state: 'failure' }; }
			let success = kind == 'apply' ? result && result.state == 'success' : result && (result.ok || result.skipped);
			let finished = metadata(function() {
				let st = load();
				if (!st || st.id != id || st.phase != 'running' || st.owner != claimed.owner || st.pid != claimed.pid)
					return { error: 'job ownership changed before completion' };
				if (!terminal(st, success ? null : ((result && result.error) || 'the operation failed'), result))
					return { error: 'could not publish terminal job status; check the system log' };
				return { ok: true };
			});
			// Publication is inside execution ownership, including failure paths.
			if (finished.error) {
				c.log(finished.error);
				return { error: finished.error, state: 'failure' };
			}
			return result;
		}
		let outcome;
		try { outcome = owned(); }
		catch (e) { outcome = { error: 'job status storage error: ' + e, state: 'failure' }; }
		unlock(execution);
		return outcome;
	}

	return { reserve, spawned, fail, start, run, status, active, progress,
		read: function() { return public_record(load()); },
		// Legacy writer for callers migrating old records; normal transitions
		// above are always conditional on identity and ownership under metadata.
		write: function(st) { return type(st) == 'object' && metadata(function() { return publish(st); }) == true; } };
}

return { create, HISTORY_LIMIT, QUEUE_TIMEOUT };
