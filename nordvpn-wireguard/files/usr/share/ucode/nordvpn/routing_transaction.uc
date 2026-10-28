// SPDX-License-Identifier: MIT
// Detached desired state and scoped routing execution. Call only while holding
// mutation.configuration(): snapshots and restoration share its short lock.
'use strict';
import { readfile, unlink, open, rename } from 'fs';
const common = require('nordvpn.common');
const PACKAGES = [ 'firewall', 'network', 'dhcp', 'nordvpn' ];
const TABLES = '/etc/iproute2/rt_tables';
let adapters, verify_runtime;
function copy(v) { return v == null ? null : json(sprintf('%J', v)); }
function equal(a, b) { return sprintf('%J', a) == sprintf('%J', b); }
function options(s) {
	let out = {};
	for (let k, v in (s || {})) if (substr(k, 0, 1) != '.') out[k] = v;
	return out;
}
function outcome_path(name) { return '/tmp/nordvpn_routing_' + common.validate_instance(name) + '.json'; }
function generation(uci, name) {
	let s = common.load_settings(uci, name), relevant = {};
	for (let k in [ 'interface', 'enabled', 'auto_routing', 'routing_table', 'killswitch', 'block_ipv6', 'vpn_masq', 'vpn_dns', 'custom_dns',
		'source_networks', 'source_devices', 'source_domains', 'source_ips', 'bypass_devices', 'bypass_domains', 'bypass_ips' ]) relevant[k] = s[k];
	let text = sprintf('%J', relevant), a = 5381, b = 52711;
	for (let i = 0; i < length(text); i++) { let ch = ord(text, i); a = ((a * 33) ^ ch) & 0xffffffff; b = ((b * 65599) + ch) & 0xffffffff; }
	return sprintf('%x:%x:%d', a, b, length(text));
}
function read_outcome(name) {
	try { let raw = adapters.read_outcome(name); let record = type(raw) == 'string' ? json(raw) : raw; return type(record) == 'object' ? record : null; }
	catch (e) { return null; }
}
function confirmation(uci, name) {
	name = common.validate_instance(name) || 'main';
	let record = read_outcome(name);
	return { confirmed: !!record?.ok && record.generation == generation(uci, name),
		stage: record?.stage || 'unconfirmed', error: record?.error || null, rollback: record?.rollback || null };
}
function checked_write(path, data) {
	if (data == null) return readfile(path) == null || unlink(path);
	let tmp = path + '.nordvpn.' + common.self_pid();
	let f = open(tmp, 'wx');
	if (!f) return false;
	let written = f.write(data), closed = f.close();
	if (written != length(data) || !closed || !rename(tmp, path)) { unlink(tmp); return false; }
	return true;
}
function snapshot(uci) {
	let out = {};
	for (let pkg in [ ...PACKAGES, 'nordvpn_credentials' ]) {
		out[pkg] = {};
		uci.foreach(pkg, null, function(s) { out[pkg][s['.name']] = copy(s); });
	}
	return out;
}
// This is deliberately independent of libuci's saved deltas: planning cannot
// stage, commit or publish any desired configuration or routing-table file.
function detached(data) {
	let serial = 0;
	let c;
	c = {
		get_all: function(p, s) { return copy(s == null ? data[p] : data[p]?.[s]); },
		get: function(p, s, k) { return k == null ? data[p]?.[s]?.['.type'] : copy(data[p]?.[s]?.[k]); },
		foreach: function(p, t, cb) {
			for (let n, s in (data[p] || {}))
				if (t == null || s['.type'] == t)
					if (cb({ ...copy(s), '.name': n }) === false) break;
			return true;
		},
		set: function(p, s, k, v) {
			data[p] ||= {};
			data[p][s] ||= { '.type': k, '.name': s };
			if (v == null) data[p][s]['.type'] = k;
			else data[p][s][k] = copy(v);
			return true;
		},
		add: function(p, t) {
			let n = 'nvtx_' + serial++;
			while (data[p]?.[n]) n = 'nvtx_' + serial++;
			c.set(p, n, t);
			data[p][n]['.anonymous'] = true;
			return n;
		},
		delete: function(p, s, k) {
			if (data[p]?.[s]) {
				if (k == null) delete data[p][s]; else delete data[p][s][k];
			}
			return true;
		},
		list_append: function(p, s, k, v) {
			let a = c.get(p, s, k);
			if (type(a) != 'array') a = a == null ? [] : [ a ];
			push(a, v); return c.set(p, s, k, a);
		}
	};
	return c;
}
function list(v) { return type(v) == 'array' ? v : (v == null ? [] : [ v ]); }
// Inventory the global reload boundary, never just the instance being edited.
// A set name alone is not ownership: both stamped sections and the instance
// identity must agree. Ambiguous/unsupported objects cannot retain membership.
function domain_sets(data) {
	let owners = {}, sets = {}, c = detached(data);
	for (let name in common.list_instances(c)) {
		let s = common.load_settings(c, name);
		if (owners[s.interface]) owners[s.interface] = { ambiguous: true };
		else owners[s.interface] = { name, active: s.enabled };
	}
	for (let sid, sec in data.firewall) {
		let iface = common.validate_interface(sec.nordvpn_iface), role = sec.nordvpn_role;
		if (sec['.type'] != 'ipset' || sec.nordvpn_managed != '1' || !iface ||
		    index([ 'domain_set', 'bypass_set' ], role) < 0 || sec.family != 'ipv4') continue;
		let name = 'nv_' + iface + (role == 'domain_set' ? '_dom' : '_byp');
		if (sec.name != name) continue;
		if (sets[name]) { sets[name].ambiguous = true; continue; }
		let owner = owners[iface], domains = [], dns_count = 0, valid = true;
		for (let did, dns in data.dhcp) {
			if (dns['.type'] != 'ipset' || dns.nordvpn_managed != '1' || dns.nordvpn_iface != iface ||
			    dns.nordvpn_role != (role == 'domain_set' ? 'domain_dns' : 'bypass_dns')) continue;
			dns_count++;
			if (dns.nordvpn_set != name || !equal(list(dns.name), [ name ]) || dns.table != 'fw4' || dns.table_family != 'inet' || dns.family != '4') valid = false;
			for (let d in list(dns.domain)) {
				let normalized = common.validate_domain(d);
				if (!normalized) valid = false;
				else if (index(domains, normalized) < 0) push(domains, normalized);
			}
		}
		sort(domains);
		sets[name] = { iface, role, owner: owner?.name, active: !!owner?.active && !owner.ambiguous,
			domains, valid: valid && dns_count == 1 && length(domains) > 0, definition: options(sec) };
	}
	return sets;
}
function preservation(before, after) {
	let old = domain_sets(before), next = domain_sets(after), keep = [];
	for (let n in sort(keys(next))) {
		let a = next[n], b = old[n];
		if (!b || !a.active || !b.active || !a.valid || !b.valid || a.ambiguous || b.ambiguous ||
		    a.owner != b.owner || a.iface != b.iface || a.role != b.role || !equal(a.definition, b.definition)) continue;
		if (!length(filter(b.domains, (d) => index(a.domains, d) < 0))) push(keep, n);
	}
	return { before: old, after: next, keep };
}
function needs_refill(sets, retained) {
	for (let n, sec in sets)
		if (sec.active && sec.valid && !sec.ambiguous && index(retained, n) < 0) return true;
	return false;
}
function plan(uci, reconcile) {
	let before = snapshot(uci), after = copy(before);
	let c = detached(after);
	let tables = { before: adapters.read_tables() };
	tables.data = tables.before || '';
	let routing = reconcile(c, tables) || {};
	if (!routing.instance && routing.interface)
		for (let name, section in after.nordvpn)
			if ((section.interface || (name == 'main' ? common.DEFAULT_INTERFACE : '')) == routing.interface) routing.instance = name;
	let instance = common.validate_instance(routing.instance);
	let desired_generation = instance ? generation(c, instance) : null;
	let changes = [], packages = [];
	for (let p in PACKAGES) {
		let names = keys(before[p]);
		for (let n in keys(after[p])) if (index(names, n) < 0) push(names, n);
		for (let n in names) {
			let b = before[p][n], a = after[p][n];
			if (b && a && b['.type'] == a['.type'] && equal(options(b), options(a))) continue;
			let kind = !b ? 'add' : !a ? 'delete' : 'update';
			push(changes, { package: p, section: n, kind, before: b, after: a,
				position: index(keys(before[p]), n) });
			if (index(packages, p) < 0) push(packages, p);
		}
	}
	let reloads = [];
	if (index(packages, 'firewall') >= 0) push(reloads, 'firewall');
	if (index(packages, 'network') >= 0 || tables.data != (tables.before || '')) push(reloads, 'network');
	let domain_preservation = preservation(before, after);
	if (index(packages, 'dhcp') >= 0 || (index(reloads, 'firewall') >= 0 && needs_refill(domain_preservation.after, domain_preservation.keep))) push(reloads, 'dhcp');
	return { changes, packages, reloads, before, after, tables, desired_generation, ...routing, domain_preservation };
}
function must(ok, stage) { if (!ok) die(stage); }
function write_section(uci, p, n, s) {
	must(uci.set(p, n, s['.type']), 'create ' + p + '.' + n);
	for (let k, v in options(s)) must(uci.set(p, n, k, v), 'set ' + p + '.' + n + '.' + k);
}
function patch(uci, change, reverse) {
	let p = change.package, n = change.actual || change.section;
	let from = reverse ? change.after : change.before;
	let to = reverse ? change.before : change.after;
	if (!to) { must(uci.delete(p, n), 'delete ' + p + '.' + n); return; }
	if (!from) {
		if (to['.anonymous']) {
			n = uci.add(p, to['.type']);
			must(n, 'add ' + p);
			if (reverse) change.restored = n; else change.actual = n;
			for (let k, v in options(to)) must(uci.set(p, n, k, v), 'set ' + p + '.' + n + '.' + k);
		} else write_section(uci, p, n, to);
		return;
	}
	if (from['.type'] != to['.type']) must(uci.set(p, n, to['.type']), 'type ' + p + '.' + n);
	let names = keys(options(from));
	for (let k in keys(options(to))) if (index(names, k) < 0) push(names, k);
	for (let k in names) {
		if (equal(from[k], to[k])) continue;
		must(to[k] == null ? uci.delete(p, n, k) : uci.set(p, n, k, to[k]), 'option ' + p + '.' + n + '.' + k);
	}
}
const COMMANDS = {
	firewall: [ '/etc/init.d/firewall', 'reload' ],
	network: [ 'ubus', 'call', 'network', 'reload' ],
	dhcp: [ '/etc/init.d/dnsmasq', 'reload' ]
};
let verification_deadline = null;
function milliseconds() { let t = clock(true); return t ? t[0] * 1000 + int(t[1] / 1000000) : null; }
function command(argv, timeout) {
	if (verification_deadline != null && milliseconds() >= verification_deadline) return { code: 124, stdout: '' };
	return adapters.run([ 'timeout', verification_deadline == null ? (timeout || '15') : '1', ...argv ], true);
}
function interface_state(iface) {
	let r = command([ 'ubus', 'call', 'network.interface.' + iface, 'status' ], '1');
	if (r.code == 0) {
		try { let st = json(r.stdout); return st && st.up != null ? st : null; } catch (e) { return null; }
	}
	// netifd may not have loaded a newly created interface, or may already
	// have removed a deleted one. A successful empty ubus listing proves
	// absence; a missing/unavailable ubus executable never establishes it.
	r = command([ 'ubus', 'list', 'network.interface.' + iface ], '1');
	return r.code == 0 && trim(r.stdout || '') == '' ? { up: false, absent: true } : null;
}

function set_elements(sets) {
	let out = {}, total = 0;
	if (!length(keys(sets))) return out;
	let r = command([ 'nft', '-j', 'list', 'table', 'inet', 'fw4' ], '3');
	if (r.code != 0) {
		// Absence is recoverable; an unavailable tool or unreadable table is not.
		let inventory = command([ 'nft', '-j', 'list', 'tables' ], '3'), tables;
		must(inventory.code == 0, 'could not inventory nft tables');
		try { tables = json(inventory.stdout); } catch (e) { die('invalid nft table inventory'); }
		must(type(tables?.nftables) == 'array', 'invalid nft table inventory');
		for (let item in tables.nftables)
			must(item.table?.family != 'inet' || item.table?.name != 'fw4', 'could not capture nft fw4 table');
		return out;
	}
	let data;
	try { data = json(r.stdout); } catch (e) { die('invalid nft set snapshot'); }
	must(type(data?.nftables) == 'array', 'invalid nft set snapshot');
	for (let item in data.nftables) {
		let sec = item.set, n = sec?.name;
		if (!sets[n] || sec.family != 'inet' || sec.table != 'fw4') continue;
		must(sec.type == 'ipv4_addr' && !length(filter(sec.flags || [], (flag) => flag != 'interval')) && !sec.timeout, 'unsupported nft set ' + n);
		let ips = [], seen = {};
		for (let ip in (sec.elem || [])) {
			must(common.validate_ipv4(ip), 'unsupported nft element in ' + n);
			if (!seen[ip]) { seen[ip] = true; push(ips, ip); total++; }
			must(total <= 65536, 'nft preservation exceeds 65536 addresses');
		}
		out[n] = ips;
	}
	return out;
}
function restore_elements(saved) {
	let start = milliseconds();
	must(start != null, 'nft restoration clock unavailable');
	for (let n in sort(keys(saved))) {
		let ips = saved[n];
		for (let i = 0; i < length(ips); i += 256) {
			must(milliseconds() < start + 10000, 'nft restoration deadline');
			must(command([ 'nft', 'add', 'element', 'inet', 'fw4', n,
				'{ ' + join(', ', slice(ips, i, i + 256)) + ' }' ], '1').code == 0, 'nft elements ' + n);
		}
	}
}
// Bound the one global nft snapshot before parsing; common.run otherwise reads
// all stdout. timeout also bounds close() when a producer exceeds this limit.
function run_bounded_nft(argv, quiet) {
	if (argv[2] != 'nft' || argv[3] != '-j') return common.run(argv, quiet);
	let proc = common.open_cmd(argv, 'r', quiet);
	if (!proc) return { code: -1, stdout: '' };
	let out = '', part, overflow = false;
	while ((part = proc.read(4096)) != null && length(part)) {
		if (length(out) + length(part) > 2097152) { overflow = true; break; }
		out += part;
	}
	let code = proc.close();
	return { code: overflow ? 1 : code, stdout: overflow ? '' : out };
}
// Explicit injection surface. Production defaults never treat a missing tool
// as success. Tests replace only these dependencies, not executable discovery.
adapters = {
	commit: function(uci, p) { return uci.commit(p); },
	run: run_bounded_nft,
	read_tables: function() { return readfile(TABLES); },
	write_tables: function(data) { return checked_write(TABLES, data); },
	read_outcome: function(name) { return readfile(outcome_path(name)); },
	write_outcome: function(name, record) { return checked_write(outcome_path(name), sprintf('%J', record)); },
	verify: function(p, desired, tables) { return verify_runtime(p, desired, tables); },
	pause: function() { sleep(250); }
};
function confirm(p, desired, tables) {
	let start = milliseconds();
	if (start == null) return false;
	verification_deadline = start + 3000;
	try {
		for (let i = 0; i < 12 && milliseconds() < verification_deadline; i++) {
			if (adapters.verify(p, desired, tables)) { verification_deadline = null; return true; }
			if (i < 11) adapters.pause();
		}
	} catch (e) { verification_deadline = null; die(e); }
	verification_deadline = null;
	return false;
}
// Merge only this plan's exact table-line delta into the current file; external
// registrations made after planning survive success and restoration.
function merge_tables(current, from, to) {
	let a = split(from || '', '\n'), b = split(to || '', '\n');
	let remove = filter(a, (l) => l != '' && index(b, l) < 0);
	let add = filter(b, (l) => l != '' && index(a, l) < 0);
	let out = filter(split(current || '', '\n'), (l) => index(remove, l) < 0);
	for (let l in add) {
		let wanted = match(l, /^[ \t]*([0-9]+)[ \t]+([^ \t#]+)/);
		for (let existing in out) {
			let m = match(existing, /^[ \t]*([0-9]+)[ \t]+([^ \t#]+)/);
			if (m && wanted && (m[1] == wanted[1] || m[2] == wanted[2]) && existing != l) die('routing table registration conflicts with a concurrent edit');
		}
		if (index(out, l) < 0) {
			if (length(out) && out[length(out) - 1] == '') splice(out, length(out) - 1, 0, l);
			else { push(out, l); push(out, ''); }
		}
	}
	let text = join('\n', out);
	return text == '' && to == null ? null : text;
}

function publish_outcome(name, record) {
	try { return adapters.write_outcome(name, record); } catch (e) { return false; }
}
function execute_inner(uci, p, affected) {
	let changed = length(p.changes) > 0 || p.tables.data != (p.tables.before || '');
	if (!changed && !p.activation) {
		let ok = false;
		try { ok = confirm(p, p.after, p.tables.data); } catch (e) { ok = false; }
		return { ok, changed: false, stage: ok ? 'unchanged' : 'verify:runtime', rollback: null,
			error: ok ? null : 'routing runtime installation could not be confirmed; retry Apply' };
	}
	let stage = 'prepare', applied = [], committed = [], attempted = [], saved = {}, table_written = false;
	try {
		// An anonymous deletion must be restorable at its original position.
		for (let ch in p.changes)
			if (ch.kind == 'delete' && type(uci.reorder) != 'function') die('UCI section reordering is unavailable');
		if (p.activation?.before_configuration) {
			stage = p.activation.stage; push(attempted, 'activation');
			must(command(p.activation.argv).code == 0, stage);
		}
		if (p.tables.data != (p.tables.before || '')) {
			stage = 'write:rt_tables'; table_written = true;
			must(adapters.write_tables(merge_tables(adapters.read_tables(), p.tables.before, p.tables.data)), stage);
		}
		// Persist every package before any runtime reload. Firewall precedes
		// network and DNS both here and at the runtime dependency boundary.
		for (let pkg in p.packages) {
			stage = 'stage:' + pkg;
			for (let ch in p.changes) if (ch.package == pkg) {
				push(applied, ch); patch(uci, ch, false);
			}
			stage = 'commit:' + pkg;
			push(committed, pkg);
			must(adapters.commit(uci, pkg), stage);
		}
		for (let pkg in p.reloads) {
			if (pkg == 'firewall') {
				stage = 'capture:elements';
				saved = set_elements(p.domain_preservation.before);
				// Runtime loss/cold boot also needs DNS refill, even if UCI was
				// unchanged. This decision covers every active domain instance.
				let retained = filter(p.domain_preservation.keep, (n) => saved[n] != null);
				if (needs_refill(p.domain_preservation.after, retained) && index(p.reloads, 'dhcp') < 0) push(p.reloads, 'dhcp');
				// The global reload can interrupt every domain instance. Persist
				// uncertainty before it, including when a worker dies mid-reload.
				for (let sets in [ p.domain_preservation.before, p.domain_preservation.after ])
					for (let n, sec in sets) {
						let name = common.validate_instance(sec.owner);
						if (!name || name == p.instance || affected[name]) continue;
						affected[name] = { prior: read_outcome(name) };
						stage = 'record:pending:' + name;
						must(publish_outcome(name, { ok: false, stage: 'applying:firewall', updated_at: common.iso_ts(time()),
							generation: affected[name].prior?.generation }), stage);
					}
			}
			stage = 'reload:' + pkg; push(attempted, pkg);
			must(command(COMMANDS[pkg]).code == 0, stage);
			if (pkg == 'firewall') {
				stage = 'restore:elements';
				let retained = {};
				for (let n in p.domain_preservation.keep) if (saved[n] != null) retained[n] = saved[n];
				restore_elements(retained);
			}
		}
		if (p.activation && !p.activation.before_configuration) {
			stage = p.activation.stage; push(attempted, 'activation');
			must(command(p.activation.argv).code == 0, stage);
		}
		stage = 'verify:runtime';
		must(confirm(p, p.after, p.tables.data), stage);
		return { ok: true, changed, stage: 'complete', rollback: null };
	} catch (e) {
		let errors = [];
		// Restore only touched options/sections. Unrelated packages, sections
		// and options (including edits made since the snapshot) are untouched.
		for (let i = length(applied) - 1; i >= 0; i--)
			try { patch(uci, applied[i], true); } catch (restore_error) { push(errors, '' + restore_error); }
		// Reinsert deleted sections in ascending original order. libuci add()
		// recreates anonymous sections; their generated IDs may change.
		for (let pkg in p.packages)
			for (let n in keys(p.before[pkg]))
				for (let ch in applied)
					if (ch.package == pkg && ch.section == n && ch.kind == 'delete')
						try { must(uci.reorder(pkg, ch.restored || n, ch.position), 'reorder ' + pkg + '.' + n); }
						catch (restore_error) { push(errors, '' + restore_error); }
		if (table_written)
			try { must(adapters.write_tables(merge_tables(adapters.read_tables(), p.tables.data, p.tables.before)), 'restore rt_tables'); }
			catch (restore_error) { push(errors, '' + restore_error); }
		for (let pkg in committed)
			try { must(adapters.commit(uci, pkg), 'restore commit:' + pkg); }
			catch (restore_error) { push(errors, '' + restore_error); }
		if (length(attempted)) {
			// Activation before configuration can fail before set capture. No
			// package reload ran in that case; avoid an uncaptured firewall reload.
			for (let pkg in length(filter(attempted, (s) => s != 'activation')) ? p.reloads : [])
				try {
					must(command(COMMANDS[pkg]).code == 0, 'restore reload:' + pkg);
					if (pkg == 'firewall') restore_elements(saved);
				} catch (restore_error) { push(errors, '' + restore_error); }
			if (p.activation)
				try { must(command(p.activation.restore_argv).code == 0, 'restore ' + p.activation.stage); }
				catch (restore_error) { push(errors, '' + restore_error); }
			try { must(confirm(p, p.before, p.tables.before || ''), 'restore verify:runtime'); }
			catch (restore_error) { push(errors, '' + restore_error); }
		}
		let original = 'routing failed at ' + stage + ': ' + e;
		return { ok: false, changed, stage, original_error: original,
			error: original + (length(errors) ? '; restoration incomplete: ' + join('; ', errors) : '; previous configuration restored'),
			rollback: { ok: !length(errors), errors, runtime_attempted: length(attempted) > 0 } };
	}
}
function execute(uci, p) {
	let name = common.validate_instance(p.instance), prior = name ? read_outcome(name) : null;
	if (name && !publish_outcome(name, { ok: false, stage: 'applying', updated_at: common.iso_ts(time()), generation: p.desired_generation }))
		return { ok: false, changed: false, stage: 'record:pending', error: 'could not record routing application; no changes executed', rollback: null };
	let affected = {}, result = execute_inner(uci, p, affected);
	// Restore existing evidence only after the entire runtime boundary (or
	// complete compensation) succeeded. This never creates a new confirmation
	// for an unconfirmed instance or updates its recorded preference generation.
	if (result.ok || result.rollback?.ok) {
		let failed = [];
		for (let other, record in affected)
			if (!publish_outcome(other, record.prior || { ok: false, stage: 'unconfirmed' })) push(failed, other);
		if (length(failed)) result = { ...result, ok: false, stage: 'record:global_result', original_error: result.error,
			error: (result.error ? result.error + '; ' : '') + 'could not restore routing confirmation for ' + join(', ', failed) };
	}
	if (name) {
		// Peer-only transactions cannot certify unapplied routing preferences.
		let record = !p.routing_policy && result.ok ? (prior || { ok: false, stage: 'unconfirmed' }) :
			{ ok: result.ok, stage: result.stage, updated_at: common.iso_ts(time()), error: result.error, generation: p.desired_generation,
				rollback: result.rollback ? { ok: result.rollback.ok, errors: result.rollback.errors } : null };
		if (!publish_outcome(name, record))
			return { ...result, ok: false, stage: 'record:result', original_error: result.error,
				error: (result.error ? result.error + '; ' : '') + 'could not publish routing confirmation; installation remains unconfirmed' };
	}
	return result;
}

function table_id(name, text) {
	if (common.full_match(name, /^[0-9]+$/)) return '' + int(name);
	if (name == 'main') return '254';
	if (name == 'default') return '253';
	for (let l in split(text || '', '\n')) {
		let m = match(l, /^[ \t]*([0-9]+)[ \t]+([^ \t#]+)/);
		if (m && m[2] == name) return '' + int(m[1]);
	}
	return null;
}
function number(s) { return int(s, index(s || '', '0x') == 0 ? 16 : 10); }
function rule_signature(sec, tables) {
	return sec ? sprintf('%J', [ sec['.type'], sec.priority || '0', sec['in'] || null, sec.mark || null, sec.action || null, sec.src || null, sec.dest || null, sec.lookup ? table_id(sec.lookup, tables) : null ]) : null;
}
function rule_present(sec, text, devices, tables) {
	for (let l in split(text || '', '\n')) {
		if (!match(l, regexp('^' + sec.priority + ':'))) continue;
		let tokens = split(trim(l), /[ \t]+/);
		if (sec['in'] && (!devices[sec['in']] || tokens[index(tokens, 'iif') + 1] != devices[sec['in']])) continue;
		if (sec.src && replace(tokens[index(tokens, 'from') + 1] || '', /\/(32|128)$/, '') != replace(sec.src, /\/(32|128)$/, '')) continue;
		if (sec.dest && (index(tokens, 'to') < 0 || replace(tokens[index(tokens, 'to') + 1] || '', /\/(32|128)$/, '') != replace(sec.dest, /\/(32|128)$/, ''))) continue;
		if (sec.mark) {
			let m = match(l, /fwmark (0x[0-9a-f]+)(\/(0x[0-9a-f]+))?/);
			let wanted = split(sec.mark, '/');
			if (!m || number(m[1]) != number(wanted[0]) || number(m[3] || '0xffffffff') != number(wanted[1] || '0xffffffff')) continue;
		}
		if (sec.action && index(l, ' ' + sec.action) < 0) continue;
		if (sec.lookup) {
			let m = match(l, /lookup ([^ \t]+)/);
			if (!m || table_id(m[1], tables) != table_id(sec.lookup, tables)) continue;
		}
		return true;
	}
	return false;
}
function firewall_present(sec, text) {
	for (let l in split(text || '', '\n')) {
		if (!sec.name || index(l, 'comment "!fw4: ' + sec.name + '"') < 0) continue;
		if (sec.target == 'REJECT' && index(l, 'reject') < 0) continue;
		if (sec.target == 'MARK') {
			let value = split(sec.set_xmark || sec.set_mark || '', '/')[0];
			if (index(l, 'mark set') < 0 || !value || index(l, sprintf('0x%x', number(value))) < 0) continue;
		}
		let macs = type(sec.src_mac) == 'array' ? sec.src_mac : (sec.src_mac ? [ sec.src_mac ] : []), matches = true;
		for (let mac in macs) if (index(lc(l), lc(replace(mac, /^!/, ''))) < 0 || (substr(mac, 0, 1) == '!' && index(l, '!=') < 0)) matches = false;
		if (!matches) continue;
		if (sec.dest_ip && index(l, sec.dest_ip) < 0) continue;
		if (sec.ipset && index(l, '@' + sec.ipset) < 0) continue;
		if (sec.target == 'DNAT' && (index(l, 'dnat') < 0 || index(l, sec.dest_ip) < 0)) continue;
		return true;
	}
	return false;
}
// Bounded convergence probes of installed policy rules, nft protections and
// the running dnsmasq instance's generated config. A reload exit is insufficient.
// This confirms installation, not end-to-end traffic or resolver reachability.
verify_runtime = function(p, desired, tables) {
	let domain_inventory = p.domain_preservation?.[desired == p.after ? 'after' : 'before'] || {};
	if (p.activation) {
		let st = interface_state(p.interface), r;
		if (!st) return false;
		let iface = desired.network[p.interface];
		let expect_up = desired == p.after ? p.activation.up : p.activation.previous_up;
		if (!!st.up != !!expect_up) return false;
		if (expect_up) {
			let peer = null;
			for (let n, sec in desired.network) if (sec.interface == p.interface && sec.route_allowed_ips == '1') peer = sec;
			if (peer) {
				r = command([ 'ip', '-4', 'route', 'show', 'table', table_id(iface.ip4table || 'main', tables) || iface.ip4table, 'default' ]);
				if (r.code != 0 || !st.l3_device || index(r.stdout || '', 'dev ' + st.l3_device) < 0) return false;
			}
		}
	}
	let devices = {}, rules = {}, nft = null;
	let need_network = index(p.reloads, 'network') >= 0;
	let need_firewall = index(p.reloads, 'firewall') >= 0;
	for (let n, sec in desired.network) if (sec.nordvpn_managed == '1' && sec.nordvpn_iface == p.interface) need_network = true;
	if (desired.network[p.interface]?.nordvpn_managed_routing == '1') need_network = true;
	for (let n, sec in desired.firewall) if (sec.nordvpn_managed == '1' && sec.nordvpn_iface == p.interface) need_firewall = true;
	if (need_network) {
		let r = command([ 'ubus', 'call', 'network.interface', 'dump' ]);
		if (r.code != 0) return false;
		let dump;
		try { dump = json(r.stdout); } catch (e) { return false; }
		for (let d in (dump.interface || [])) if (d.up && d.l3_device) devices[d.interface] = d.l3_device;
		for (let f in [ '4', '6' ]) {
			r = command([ 'ip', '-' + f, 'rule', 'show' ]);
			if (r.code != 0) return false;
			rules[f] = r.stdout;
		}
		for (let n, sec in desired.network) {
			if (sec.nordvpn_managed != '1' || sec.nordvpn_iface != p.interface) continue;
			if (sec['.type'] == 'rule' || sec['.type'] == 'rule6') {
				if (!rule_present(sec, rules[sec['.type'] == 'rule6' ? '6' : '4'], devices, tables)) return false;
			}
			if (sec['.type'] == 'route' && devices[sec.interface]) {
				r = command([ 'ip', '-4', 'route', 'show', 'table', table_id(sec.table, tables) || sec.table ]);
				if (r.code != 0 || index(r.stdout, sec.target) < 0 || index(r.stdout, 'dev ' + devices[sec.interface]) < 0) return false;
			}
		}
		if (devices[p.interface] && desired.network[p.interface]?.nordvpn_managed_routing == '1') {
			let peer_routed = false;
			for (let n, sec in desired.network) if (sec.interface == p.interface && sec.route_allowed_ips == '1') peer_routed = true;
			if (peer_routed) {
				let table = desired.network[p.interface].ip4table || 'main';
				let r = command([ 'ip', '-4', 'route', 'show', 'table', table_id(table, tables) || table, 'default' ]);
				if (r.code != 0 || index(r.stdout || '', 'dev ' + devices[p.interface]) < 0) return false;
			}
		}
		// Removed rules must disappear too (disable/delete must release them).
		for (let ch in p.changes) {
			let old = desired == p.after ? ch.before : ch.after;
			let now = desired == p.after ? ch.after : ch.before;
			if (ch.package != 'network' || !old || rule_signature(old, tables) == rule_signature(now, tables)) continue;
			let retained = false;
			for (let n, sec in desired.network) if (rule_signature(sec, tables) == rule_signature(old, tables)) retained = true;
			if (retained) continue;
			if ((old['.type'] == 'rule' || old['.type'] == 'rule6') && old.nordvpn_managed == '1' &&
			    rule_present(old, rules[old['.type'] == 'rule6' ? '6' : '4'], devices, tables)) return false;
		}
	}
	if (need_firewall) {
		let r = command([ 'nft', 'list', 'table', 'inet', 'fw4' ]);
		if (r.code != 0) return false;
		nft = r.stdout || '';
		for (let n, sec in desired.firewall) {
			if (sec.nordvpn_managed != '1' || sec.nordvpn_iface != p.interface) continue;
			if ((sec['.type'] == 'rule' || sec['.type'] == 'redirect') && !firewall_present(sec, nft)) return false;
			if (sec['.type'] == 'ipset' && !match(nft, regexp('set ' + sec.name + ' \\{'))) return false;
		}
		for (let n, sec in domain_inventory)
			if (sec.active && sec.valid && !match(nft, regexp('set ' + n + ' \\{'))) return false;
		for (let ch in p.changes) {
			let old = desired == p.after ? ch.before : ch.after;
			let now = desired == p.after ? ch.after : ch.before;
			let retained = false;
			for (let n, sec in desired.firewall)
				if (old && sec.name == old.name && sec.target == old.target && sec.set_xmark == old.set_xmark && sec.dest_ip == old.dest_ip) retained = true;
			if (ch.package == 'firewall' && old && !now && !retained && (old['.type'] == 'rule' || old['.type'] == 'redirect') &&
			    firewall_present(old, nft)) return false;
		}
	}
	let need_dhcp = index(p.reloads, 'dhcp') >= 0;
	for (let n, sec in desired.dhcp) if (sec.nordvpn_dns_lock == p.interface && p.interface != null) need_dhcp = true;
	if (need_dhcp) {
		let r = command([ 'ubus', 'call', 'service', 'list', '{"name":"dnsmasq"}' ]), service;
		if (r.code != 0) return false;
		try { service = json(r.stdout); } catch (e) { return false; }
		let configs = [];
		for (let n, inst in (service.dnsmasq?.instances || {})) {
			if (!inst.running) continue;
			let at = index(inst.command || [], '-C');
			if (at < 0) continue;
			let text = readfile(inst.command[at + 1]);
			if (text) push(configs, text);
		}
		if (!length(configs)) return false;
		let text = join('\n', configs);
		for (let n, sec in desired.dhcp) {
			if (p.interface != null && sec.nordvpn_dns_lock == p.interface) {
				let confirmed = false;
				for (let config in configs) {
					let valid = index('\n' + config, '\nno-resolv\n') >= 0;
					for (let ip in (sec.nordvpn_dns_servers || [])) if (index('\n' + config, '\nserver=' + ip + '\n') < 0) valid = false;
					if (valid) confirmed = true;
				}
				if (!confirmed) return false;
			}
			let global_domain = domain_inventory[sec.nordvpn_set];
			if (sec.nordvpn_managed == '1' && sec['.type'] == 'ipset' &&
			    (sec.nordvpn_iface == p.interface || (global_domain?.active && global_domain?.valid))) {
				let names = sec.name;
				for (let name in type(names) == 'array' ? names : [ names ]) {
					if (!name || index(text, '4#inet#fw4#' + name) < 0) return false;
					for (let domain in (sec.domain || []))
						if (!length(filter(split(text, '\n'), (line) => index(line, 'nftset=/') == 0 && index(line, '/' + domain + '/') >= 0 && index(line, '4#inet#fw4#' + name) >= 0))) return false;
				}
			}
		}
	}
	return true;
};
return { plan, execute, adapters, verify_runtime, snapshot, merge_tables, confirmation, interface_state };
