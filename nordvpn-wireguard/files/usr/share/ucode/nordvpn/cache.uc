// SPDX-License-Identifier: MIT
// Server-list cache/API module for nordvpn-wireguard. Handles NordVPN API
// pagination, server normalization (country/city/relay), multihop
// classification, atomic cache writes, a single-writer lock and a schema
// version. Shared by the cache-update worker, the rotation worker and rpcd.

'use strict';

import { readfile, stat } from 'fs';
const _common = require('nordvpn.common');
const open_cmd = _common.open_cmd,
      SERVERS_URL = _common.SERVERS_URL,
      PAGE_SIZE = _common.PAGE_SIZE,
      MAX_PAGES = _common.MAX_PAGES,
      DEFAULT_PORT = _common.DEFAULT_PORT,
      CACHE_MAX_AGE = _common.CACHE_MAX_AGE,
      CACHE_SCHEMA_VERSION = _common.CACHE_SCHEMA_VERSION,
      FETCH_STATUS_FILE = _common.FETCH_STATUS_FILE,
      relay_kind = _common.relay_kind,
      clean_label = _common.clean_label,
      validate_hostname = _common.validate_hostname,
      validate_wg_key = _common.validate_wg_key,
      validate_country_code = _common.validate_country_code,
      atomic_write = _common.atomic_write,
      iso_ts = _common.iso_ts,
      log = _common.log;

const MAX_RESPONSE = 16 * 1024 * 1024; // hard cap per API response
const CONNECT_TIMEOUT = 15;
const TOTAL_TIMEOUT = 60;
// Used only when reading pre-upgrade, identity-less progress records.
const FETCH_STALL = 300;
const refresh_slot = require('nordvpn.jobs').create(FETCH_STATUS_FILE, null, { live_until_exit: true });

// ── JSON / HTTP helpers ──────────────────────────────────────────────

function safe_json(str) {
	try {
		return json(str);
	} catch (e) {
		return null;
	}
}

// Fetch a URL with curl (argv array, no shell) and return the body, bounded to
// MAX_RESPONSE bytes. Returns { ok, body, error }.
function http_get(url) {
	let argv = [
		'curl', '-g', '-s', '-S',
		'--connect-timeout', '' + CONNECT_TIMEOUT,
		'--max-time', '' + TOTAL_TIMEOUT,
		'-H', 'Accept: application/json',
		url
	];
	let proc = open_cmd(argv, 'r');
	if (!proc)
		return { ok: false, error: 'failed to start curl' };

	// Chunks are joined once at the end: appending each one to a growing
	// string copies everything read so far, quadratic in a page of ~1 MB.
	let chunks = [], size = 0;
	while (size < MAX_RESPONSE) {
		let chunk = proc.read(65536);
		if (chunk == null || chunk == '')
			break;
		push(chunks, chunk);
		size += length(chunk);
	}
	let code = proc.close();

	if (size >= MAX_RESPONSE)
		return { ok: false, error: 'response exceeded size limit' };
	if (code != 0)
		return { ok: false, error: 'curl exit ' + code };
	return { ok: true, body: join('', chunks) };
}

// ── Fetch-status file (progress for the UI) ──────────────────────────

// Every record carries the writer's pid and an epoch stamp, so a refresh
// whose worker died can be told from a slow one (fetch_status_report()).
function write_fetch_status(status) {
	let now = time();
	status.updated_at = iso_ts(now);
	status.updated_at_epoch = now;
	status.pid = (status.state == 'running') ? _common.self_pid() : null;
	return atomic_write(FETCH_STATUS_FILE, sprintf('%J', status));
}

function read_fetch_status() {
	let data = readfile(FETCH_STATUS_FILE);
	if (!data)
		return null;
	return safe_json(data);
}

// Legacy records keep their old recovery rules; new records use exact process
// identity and advisory execution ownership, without an age ceiling.
function fetch_running(st, now) {
	if (type(st) != 'object' || st.state != 'running') return false;
	if (st.id) return refresh_slot.active(st);
	now = now || time();
	let at = (type(st.updated_at_epoch) == 'int') ? st.updated_at_epoch : 0;
	return !!(at && now - at <= FETCH_STALL && at <= now + 60 &&
		(!st.pid || !stat('/proc/self') || stat('/proc/' + st.pid)));
}

function report(st) {
	if (!st) return st;
	let out = { ...st, ...(st.progress || {}), state: st.state };
	if (st.state == 'failed') {
		out.state = 'error';
		out.message = st.error;
		if (st.progress && st.progress.phase == 'publishing')
			out.message += '; cache publication may have succeeded; check the available server list';
	} else if (st.state == 'done') out.phase = 'done';
	return out;
}

function fetch_status_report(now, id) {
	let st = read_fetch_status();
	if (id || (st && st.id)) return report(refresh_slot.status(id));
	if (st && st.state == 'running' && !fetch_running(st, now))
		return { ...st, state: 'error', stale: true, pid: null,
			message: 'the server list refresh stopped unexpectedly' };
	return st;
}

// A reservation is published before spawn, including scheduler forks. Busy
// losers return the current identity and never write winner progress.
function reservation_for_path(result, path) {
	if (result.already_running && result.apply.context && result.apply.context.path != path)
		return { busy: true, error: 'another cache path is being refreshed; retry when it finishes' };
	return result;
}
function reserve_refresh(path) {
	return reservation_for_path(refresh_slot.reserve('cache', 'refresh', { path: path }, 0), path);
}
function spawn_refresh(path, spawn) {
	return reservation_for_path(refresh_slot.start('cache', 'refresh', { path: path }, 0, spawn), path);
}

function fail_refresh(id, error) { return refresh_slot.fail(id, error); }

// ── Normalization ────────────────────────────────────────────────────


function new_accumulator() {
	return {
		country_index: {},
		location_index: {},
		country_list: [],
		stats: { countries: 0, cities: 0, gateways: 0, servers_seen: 0 }
	};
}

function ensure_country(acc, country_name, country_code) {
	if (!acc.country_index[country_name]) {
		let c = {
			code: country_code,
			name: country_name,
			display_name: country_name,
			cities: [],
			gateway_count: 0
		};
		acc.country_index[country_name] = c;
		push(acc.country_list, c);
	}
	return acc.country_index[country_name];
}

function ensure_city(acc, country, loc_code, city_name, lat, lon, country_code) {
	if (!acc.location_index[loc_code]) {
		let city = {
			code: loc_code,
			name: city_name,
			country: country.name,
			country_code: country_code,
			latitude: lat || 0,
			longitude: lon || 0,
			relays: [],
			gateway_count: 0
		};
		acc.location_index[loc_code] = city;
		push(country.cities, city);
	}
	return acc.location_index[loc_code];
}

// Identifiers of the NordVPN server groups a server belongs to
// ('legacy_p2p', 'legacy_dedicated_ip', 'legacy_double_vpn', ...).
function group_ids(server) {
	let out = {};
	if (type(server.groups) != 'array')
		return out;
	for (let g in server.groups)
		if (type(g) == 'object' && type(g.identifier) == 'string')
			out[g.identifier] = true;
	return out;
}

function extract_public_key(server) {
	let techs = server.technologies;
	if (type(techs) != 'array')
		return null;
	for (let tech in techs) {
		if (type(tech) == 'object' && tech.identifier == 'wireguard_udp') {
			let md = tech.metadata;
			if (type(md) == 'array')
				for (let meta in md)
					if (type(meta) == 'object' && meta.name == 'public_key')
						return meta.value;
			return null;
		}
	}
	return null;
}

// Add one raw API server object to the accumulator. The list is external
// data, and ucode throws on reading a field of anything but an object, so a
// single malformed entry would otherwise abort the whole refresh: such
// entries are skipped.
function add_server(acc, server) {
	acc.stats.servers_seen++;

	if (type(server) != 'object')
		return;
	let locs = server.locations;
	if (type(locs) != 'array' || length(locs) == 0 || type(locs[0]) != 'object')
		return;
	let loc = locs[0];
	let cinfo = loc.country;
	if (type(cinfo) != 'object')
		return;

	// Everything below ends up in /etc/config/network (endpoint, key) or in
	// the UI, so malformed entries are dropped rather than passed along.
	let country_code = validate_country_code(cinfo.code);
	if (!country_code)
		return;
	let country_name = clean_label(cinfo.name, uc(country_code));
	let city_name = clean_label((type(cinfo.city) == 'object') ? cinfo.city.name : null, 'Unknown');
	let location_code = country_code + '-' + replace(lc(city_name), /[^a-z0-9]/g, '');

	let public_key = validate_wg_key(extract_public_key(server));
	if (!public_key)
		return;
	let hostname = validate_hostname(server.hostname);
	if (!hostname)
		return;

	let country = ensure_country(acc, country_name, country_code);
	let city = ensure_city(acc, country, location_code, city_name,
		loc.latitude, loc.longitude, country_code);

	let friendly = clean_label(server.name, '');

	// Multihop: hostname cc1-cc2##.nordvpn.com, or name "CountryA - CountryB #".
	// POSIX ERE only ([.] for literal dots; no \s/\w/non-greedy).
	let entry_code = null, entry_name = null;
	let hm = match(hostname, /^([a-z][a-z])-([a-z][a-z])[0-9]+[.]nordvpn[.]com$/);
	if (hm) {
		entry_code = hm[1];
	} else if (friendly) {
		let nm = match(friendly, /^ *([A-Za-z0-9 ]+)-([A-Za-z0-9 ]+)#/);
		if (nm)
			entry_name = trim(nm[1]);
	}

	let groups = group_ids(server);

	let multihop = false;
	if (entry_code && entry_code != country_code)
		multihop = true;
	else if (entry_name && lc(entry_name) != lc(country_name))
		multihop = true;
	else if (groups.legacy_double_vpn)
		multihop = true;

	// Onion Over VPN: hostname cc-onionNN.nordvpn.com (exit through Tor).
	// Kept out of both the single and multihop pools so it is an explicit choice.
	let onion = false;
	if (match(hostname, /^[a-z][a-z]-onion[0-9]+[.]nordvpn[.]com$/))
		onion = true;
	else if (friendly && match(friendly, / Onion #/))
		onion = true;
	else if (groups.legacy_onion_over_vpn && !multihop)
		onion = true;

	push(city.relays, {
		hostname: hostname,
		ip_address: validate_hostname(server.station) || '',
		name: friendly,
		public_key: public_key,
		load: (type(server.load) == 'int' && server.load >= 0 && server.load <= 100) ? server.load : 0,
		location: location_code,
		port: DEFAULT_PORT,
		active: true,
		multihop: multihop,
		onion: onion,
		// P2P-optimised; Dedicated IP servers only accept the account they
		// are assigned to, so they never enter an automatic pool.
		p2p: !!groups.legacy_p2p,
		dedicated: !!groups.legacy_dedicated_ip,
		entry_country_code: entry_code,
		entry_country: entry_name || (entry_code ? uc(entry_code) : null),
		exit_country_code: country_code,
		exit_country: country_name
	});
	city.gateway_count++;
	acc.stats.gateways++;
}

function finalize(acc) {
	let filtered = [];
	for (let country in acc.country_list) {
		let valid = [];
		country.gateway_count = 0;
		for (let city in country.cities) {
			if (length(city.relays) > 0) {
				sort(city.relays, function(a, b) {
					return (a.name < b.name) ? -1 : (a.name > b.name) ? 1 : 0;
				});
				push(valid, city);
				country.gateway_count += length(city.relays);
				acc.stats.cities++;
			}
		}
		sort(valid, function(a, b) {
			return (a.name < b.name) ? -1 : (a.name > b.name) ? 1 : 0;
		});
		country.cities = valid;
		if (length(valid) > 0)
			push(filtered, country);
	}
	sort(filtered, function(a, b) {
		return (a.name < b.name) ? -1 : (a.name > b.name) ? 1 : 0;
	});
	acc.stats.countries = length(filtered);

	return {
		countries: filtered,
		stats: acc.stats,
		// Relays carry the server-group flags (p2p, dedicated). A cache
		// written before they existed reads as stale, so the daemon refreshes
		// it on its first tick while the old one keeps serving.
		groups: true,
		source: SERVERS_URL,
		generated_at: iso_ts()
	};
}

// Trimmed country/city tree for the UI (no per-relay data). Small enough to
// return over ubus, which caps message size — the full list is multi-MB.
function locations_tree(cache) {
	let out = [];
	if (!cache || type(cache.countries) != 'array')
		return out;
	for (let c in cache.countries) {
		let cities = [], cs = 0, cm = 0, co = 0, cp = 0;
		for (let city in c.cities) {
			let s = 0, m = 0, o = 0, p = 0;
			for (let r in city.relays) {
				if (r.dedicated)
					continue;
				let k = relay_kind(r);
				if (k == 'multihop')
					m++;
				else if (k == 'onion')
					o++;
				else {
					s++;
					if (r.p2p)
						p++;
				}
			}
			push(cities, { code: city.code, name: city.name, single: s, multi: m, onion: o, p2p: p });
			cs += s;
			cm += m;
			co += o;
			cp += p;
		}
		push(out, { code: c.code, name: c.name, single: cs, multi: cm, onion: co, p2p: cp, cities: cities });
	}
	return out;
}

// Union of relays over a location set (country codes and/or cc-city codes),
// each entry carrying the grouping fields the UI needs (country_code,
// city_code, city). Deduped by hostname; hop_mode filters the relay kind and
// server_group 'p2p' keeps only P2P servers (single-hop only). Dedicated IP
// servers are listed (flagged) so their owner can pin one.
function pool_relays(cache, locations, hop_mode, server_group) {
	let out = [], seen = {};
	if (!cache || type(cache.countries) != 'array' || type(locations) != 'array')
		return out;
	let want = (hop_mode == 'multihop' || hop_mode == 'onion') ? hop_mode : 'single';
	let p2p_only = (want == 'single' && server_group == 'p2p');
	let set = {};
	for (let e in locations)
		if (type(e) == 'string' && e != '')
			set[lc(e)] = true;
	for (let c in cache.countries) {
		for (let city in c.cities) {
			if (!set[lc(c.code)] && !set[city.code])
				continue;
			for (let r in city.relays) {
				let k = relay_kind(r);
				if (k != want || seen[r.hostname] || (p2p_only && !r.p2p))
					continue;
				seen[r.hostname] = true;
				push(out, { hostname: r.hostname, name: r.name, load: r.load,
					multihop: k == 'multihop', onion: k == 'onion',
					p2p: !!r.p2p, dedicated: !!r.dedicated,
					country_code: lc(c.code), city_code: city.code, city: city.name });
			}
		}
	}
	return out;
}

// Trimmed relay list for one city, optionally filtered by hop mode.
function city_relays(cache, country_code, city_code, hop_mode) {
	let out = [];
	if (!cache || type(cache.countries) != 'array')
		return out;
	let cc = country_code ? lc(country_code) : null;
	let want = (hop_mode == null || hop_mode == '') ? null
		: (hop_mode == 'multihop' || hop_mode == 'onion') ? hop_mode : 'single';
	for (let c in cache.countries) {
		if (cc && lc(c.code) != cc)
			continue;
		for (let city in c.cities) {
			if (city.code != city_code)
				continue;
			for (let r in city.relays) {
				let k = relay_kind(r);
				if (want == null || k == want)
					push(out, { hostname: r.hostname, name: r.name, load: r.load,
						multihop: k == 'multihop', onion: k == 'onion',
						p2p: !!r.p2p, dedicated: !!r.dedicated });
			}
			return out;
		}
	}
	return out;
}

// Normalize an array of raw API server objects into the cache structure.
// Exported for fixture tests (no network access required).
function normalize(list) {
	let acc = new_accumulator();
	for (let server in list)
		add_server(acc, server);
	return finalize(acc);
}

// ── Full paginated fetch ─────────────────────────────────────────────

function fetch_servers(progress, http) {
	let notify = progress || function() { return true; };
	let get = http || http_get;
	let acc = new_accumulator();
	let offset = 0, pages = 0, last_page = 0;
	let started = iso_ts();

	if (!notify({ state: 'running', phase: 'fetching', started_at: started, page_size: PAGE_SIZE,
		pages: 0, loaded: 0, gateways: 0, source: SERVERS_URL })) return { error: 'failed to publish refresh progress' };

	while (pages < MAX_PAGES) {
		let url = sprintf('%s?limit=%d&offset=%d&filters[servers_technologies][identifier]=wireguard_udp',
			SERVERS_URL, PAGE_SIZE, offset);
		let r = get(url);
		if (!r.ok) {
			return { error: r.error };
		}

		let data = safe_json(r.body);
		if (type(data) != 'array') {
			// Detect Cloudflare/NordVPN rate limiting from an HTML body.
			let lower = lc(r.body || '');
			let msg = (index(lower, 'rate limit') >= 0 || index(lower, 'error 1015') >= 0 ||
				index(lower, 'banned you temporarily') >= 0)
				? 'NordVPN API rate limited (Cloudflare); wait a few minutes and retry'
				: 'failed to parse NordVPN server response';
			return { error: msg };
		}

		last_page = length(data);
		if (last_page == 0)
			break;

		for (let server in data)
			add_server(acc, server);

		pages++;
		offset += PAGE_SIZE;
		if (!notify({ state: 'running', phase: 'fetching', started_at: started, page_size: PAGE_SIZE,
			pages: pages, last_page: last_page, loaded: acc.stats.servers_seen,
			gateways: acc.stats.gateways, source: SERVERS_URL })) return { error: 'failed to publish refresh progress' };

		if (last_page < PAGE_SIZE)
			break;
	}

	if (pages >= MAX_PAGES) {
		let msg = 'pagination safety limit reached';
		return { error: msg };
	}

	let resp = finalize(acc);
	resp.pagination = { page_size: PAGE_SIZE, pages: pages,
		servers_seen: acc.stats.servers_seen, last_page_size: last_page };

	return resp;
}

// ── Cache read/write ─────────────────────────────────────────────────

// Reject normalized trees that cannot serve a single usable gateway. Strict
// count/ownership checks also prevent publishing partial malformed structures.
function validate_cache(obj) {
	if (type(obj) != 'object' || type(obj.countries) != 'array' || !length(obj.countries) ||
		type(obj.stats) != 'object' || type(obj.generated_at) != 'string')
		return 'server response contains no usable cache structure';
	let cities = 0, gateways = 0;
	for (let country in obj.countries) {
		if (type(country) != 'object' || !validate_country_code(country.code) ||
			type(country.name) != 'string' || type(country.cities) != 'array' || !length(country.cities))
			return 'invalid country in normalized cache';
		for (let city in country.cities) {
			if (type(city) != 'object' || type(city.code) != 'string' || !length(city.code) ||
				type(city.name) != 'string' || type(city.relays) != 'array' || !length(city.relays))
				return 'invalid city in normalized cache';
			cities++;
			for (let relay in city.relays) {
				if (type(relay) != 'object' || !validate_hostname(relay.hostname) ||
					!validate_wg_key(relay.public_key) || relay.location != city.code ||
					type(relay.port) != 'int' || relay.port < 1 || relay.port > 65535)
					return 'invalid gateway in normalized cache';
				gateways++;
			}
		}
	}
	if (!gateways || obj.stats.gateways != gateways || obj.stats.cities != cities ||
		obj.stats.countries != length(obj.countries)) return 'unusable or inconsistent server response';
	return null;
}

// Read the cache, rejecting malformed or schema-incompatible content.
function read_cache(path) {
	let data = readfile(path);
	if (!data)
		return null;
	let obj = safe_json(data);
	if (type(obj) != 'object' || obj.schema_version != CACHE_SCHEMA_VERSION || validate_cache(obj))
		return null;
	return obj;
}

// True when an already-parsed cache object is missing, incompatible, lacks
// the server group flags or is older than the staleness threshold. Callers
// holding the parsed cache use this instead of cache_is_stale(), which reads
// and parses the multi-megabyte file again.
function is_stale(obj, now) {
	if (type(obj) != 'object' || obj.schema_version != CACHE_SCHEMA_VERSION ||
	    type(obj.cached_at) != 'int' || !obj.groups)
		return true;
	return ((now || time()) - obj.cached_at) > CACHE_MAX_AGE;
}

// is_stale() for the cache file at `path`.
function cache_is_stale(path) {
	return is_stale(read_cache(path));
}

function write_cache(response, path, writer) {
	if (validate_cache(response)) return false;
	response.cached_at = time();
	response.schema_version = CACHE_SCHEMA_VERSION;
	response.cache_info = { created: iso_ts(), expires_at: iso_ts(time() + CACHE_MAX_AGE) };
	return (writer || atomic_write)(path, sprintf('%J', response));
}

// The outer coordinator alone owns terminal status. Its separate execution
// slot spans normalization, readable replacement and terminal publication.
// Explicit adapters are for offline failure injection only.
function fetch_and_build(path, id, adapters) {
	let a = adapters || {}, slot = a.slot || refresh_slot;
	if (!id) {
		let reservation = slot.reserve('cache', 'refresh', { path: path }, 0);
		if (!reservation.started) return { error: reservation.error || 'refresh already in progress' };
		id = reservation.apply.id;
	}
	let published = false, response = null;
	let outcome = slot.run(id, 'cache', 'refresh', function(instance, context) {
		if (context.path != path) return { error: 'refresh cache path does not match its reservation' };
		let details = { phase: 'fetching', source: SERVERS_URL };
		function progress(next) {
			details = next;
			return slot.progress(id, details);
		}
		let resp = fetch_servers(progress, a.http);
		if (!resp || resp.error) return resp || { error: 'fetch failed' };
		if (!progress({ ...details, phase: 'validating' })) return { error: 'failed to publish validation progress' };
		let error = validate_cache(resp);
		if (error) return { error: error };
		if (!progress({ ...details, phase: 'publishing' })) return { error: 'failed to publish cache progress' };
		resp.generation = id;
		if (!write_cache(resp, path, a.write)) return { error: 'failed to write cache file: ' + path };
		// Atomic replacement guarantees reader visibility; verify the same
		// schema/structure through the production reader before claiming done.
		published = true;
		let readable = (a.read || read_cache)(path);
		if (!readable || readable.generation != id) return { error: 'published cache generation is not readable: ' + path };
		response = resp;
		return { ok: true, generation: id, cached_at: resp.cached_at, stats: resp.stats };
	});
	if (outcome && outcome.ok) return response;
	if (published) {
		let error = 'cache replaced but refresh completion could not be confirmed; new cache retained: ' +
			((outcome && outcome.error) || 'terminal status unavailable');
		log(error);
		return { error: error, cache_published: true };
	}
	if (outcome && outcome.skipped) return { error: 'refresh already in progress' };
	return outcome || { error: 'refresh failed' };
}

return {
	FETCH_STALL,
	write_fetch_status, read_fetch_status, fetch_running, fetch_status_report, add_server, normalize,
	locations_tree, city_relays, pool_relays, validate_cache,
	reserve_refresh, spawn_refresh, fail_refresh,
	fetch_servers, read_cache, is_stale, cache_is_stale, write_cache, fetch_and_build
};
