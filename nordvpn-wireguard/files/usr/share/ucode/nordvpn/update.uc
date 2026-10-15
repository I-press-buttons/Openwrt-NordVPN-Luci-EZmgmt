// SPDX-License-Identifier: MIT
// GitHub release updater shared by the CLI and rpcd. Only APK releases from
// this repository are accepted; latest is resolved once to keep the pair aligned.
'use strict';
import { readfile, stat, unlink, rmdir, mkdtemp } from 'fs';
const c = require('nordvpn.common');
const BASE = 'https://github.com/I-press-buttons/Openwrt-NordVPN-Luci-EZmgmt/releases';
const STATUS = '/tmp/nordvpn_update.json';
const LOCK = '/tmp/nordvpn_update.lock';
const PACKAGES = [ 'nordvpn-wireguard', 'luci-app-nordvpn' ];

function version(value) {
	if (value == null || value == '' || value == 'latest')
		return 'latest';
	if (type(value) != 'string' || length(value) > 100 ||
	    !c.full_match(value, /^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$/))
		return null;
	return substr(value, 0, 1) == 'v' ? value : 'v' + value;
}

function status() {
	let s;
	try { s = json(readfile(STATUS) || '{}'); } catch (e) { s = {}; }
	if (type(s) != 'object') s = {};
	let lock = match(readfile(LOCK) || '', /^[0-9]+ ([0-9]+)/);
	let pid = lock ? int(lock[1]) : s.pid;
	if (s.state == 'running' && (!pid || !stat('/proc/' + pid)))
		s = { ...s, state: 'error', error: 'Update worker stopped unexpectedly. Check installed package versions before retrying.' };
	return { installed: c.VERSION, ...s, state: s.state || 'idle' };
}

function write_status(s) {
	if (!c.atomic_write(STATUS, sprintf('%J\n', s)))
		die('Cannot write update status\n');
}

function curl(args) {
	return c.run([ 'curl', '--fail', '--silent', '--show-error', '--location',
		'--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20',
		'--max-time', '180', '--retry', '2', ...args ], true);
}

function install(target, progress) {
	if (c.run([ 'sh', '-c', 'command -v apk' ], true).code != 0)
		return { error: 'GitHub release updates require OpenWrt with apk (25.12 or snapshots).' };
	if (target == 'latest') {
		progress('Resolving latest GitHub release');
		let r = curl([ '--output', '/dev/null', '--write-out', '%{url_effective}', BASE + '/latest' ]);
		let prefix = BASE + '/tag/';
		let url = trim(r.stdout || '');
		if (r.code != 0 || index(url, prefix) != 0)
			return { error: 'Could not resolve the latest GitHub release.' };
		target = substr(url, length(prefix));
		if (!version(target) || version(target) != target)
			return { error: 'GitHub returned an unsupported release tag.' };
	}
	let dir = mkdtemp('/tmp/nordvpn-update.XXXXXX');
	if (!dir) return { error: 'Could not create a temporary download directory.' };
	let paths = [];
	let result;
	try {
		for (let name in PACKAGES) {
			let path = dir + '/' + name + '.apk';
			push(paths, path);
			progress('Downloading ' + name + ' (' + target + ')');
			let r = curl([ '--output', path, BASE + '/download/' + target + '/' + name + '-latest.apk' ]);
			if (r.code != 0 || !stat(path) || stat(path).size == 0)
				die('Could not download ' + name + ' for ' + target + '. The release must include both -latest.apk assets.');
		}
		progress('Installing both packages (' + target + ')');
		// Local APKs explicitly select the requested version, including an
		// older release. As in the documented manual installation, these
		// release assets are unsigned; TLS validates their download origin.
		let r = c.run([ 'sh', '-c', 'apk add --allow-untrusted ' +
			join(' ', map(paths, c.sh_quote)) + ' 2>&1' ]);
		result = r.code == 0 ? { version: target } :
			{ error: 'Package installation failed. Check installed versions before retrying.', output: substr(r.stdout || '', -6000) };
	} catch (e) {
		result = { error: '' + e };
	}
	for (let path in paths) unlink(path);
	rmdir(dir);
	return result;
}

function run(value, locked) {
	let target = version(value);
	if (!target) return { state: 'error', error: 'Invalid version. Use latest, 1.8.0 or v1.8.0-r20261015.' };
	if (!locked && !c.acquire_lock(LOCK, 86400))
		return { state: 'error', error: 'Another package update is running.' };
	let s = { state: 'running', requested: target, pid: c.self_pid(), started_at: time() };
	// Replace the launching rpcd PID in the lock with the worker PID.
	c.atomic_write(LOCK, sprintf('%d %d\n', time(), s.pid));
	let result;
	try {
		write_status(s);
		result = install(target, function(message) {
			s.message = message;
			write_status(s);
		});
		s = { ...s, ...result, pid: null, state: result.error ? 'error' : 'success', finished_at: time() };
		write_status(s);
	} catch (e) {
		s = { ...s, state: 'error', pid: null, error: '' + e };
		c.atomic_write(STATUS, sprintf('%J\n', s));
	}
	c.release_lock(LOCK);
	return s;
}

function start(value) {
	let target = version(value);
	if (!target) return { error: 'Invalid version. Use latest, 1.8.0 or v1.8.0-r20261015.' };
	if (!c.acquire_lock(LOCK, 86400)) return { error: 'Another package update is running.' };
	try {
		write_status({ state: 'running', requested: target, pid: c.self_pid(), started_at: time(), message: 'Starting update' });
		let r = c.run([ 'sh', '-c', '/usr/bin/nordvpn-update --worker ' + c.sh_quote(target) + ' </dev/null >/dev/null 2>&1 & echo $!' ]);
		let pid = trim(r.stdout || '');
		if (r.code != 0 || !c.full_match(pid, /^[0-9]+$/)) die('Could not start update worker.');
		c.atomic_write(LOCK, sprintf('%d %s\n', time(), pid));
	} catch (e) {
		c.release_lock(LOCK);
		c.atomic_write(STATUS, sprintf('%J\n', { state: 'error', error: '' + e }));
		return { error: '' + e };
	}
	return { started: true };
}

return { version, status, install, run, start };
