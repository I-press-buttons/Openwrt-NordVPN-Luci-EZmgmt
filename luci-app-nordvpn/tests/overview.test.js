'use strict';
/* global require, __dirname, process */

// Small VM harness for the view's change classification and global-disable/save
// flows. It stubs LuCI services while executing the actual overview.js module.
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');

var calls = {};
var uciWrites = [];
var uciValues = {};
String.prototype.format = function() {
	var a = arguments;
	return this.replace(/%s/g, function() { return a[0]; });
};
var uci = {
	get: function(config, section, option) {
		var sec = uciValues[section] || {};
		return option ? sec[option] : uciValues[section];
	},
	set: function(config, section, option, value) {
		uciWrites.push(Array.prototype.slice.call(arguments));
		(uciValues[section] || (uciValues[section] = {}))[option] = value;
	},
	unset: function(config, section, option) {
		uciWrites.push(Array.prototype.slice.call(arguments));
		delete (uciValues[section] || {})[option];
	},
	unload: function() {},
	load: function() { return Promise.resolve(); },
	save: function() { return Promise.resolve(); }
};
var context = {
	console: console,
	Promise: Promise,
	Date: Date,
	JSON: JSON,
	Array: Array,
	Math: Math,
	window: { setTimeout: setTimeout },
	require: function(name) {
		return {
			view: { extend: function(obj) { return obj; } },
			rpc: { declare: function(spec) {
				return function() {
					var fn = calls[spec.method];
					return fn ? fn.apply(null, arguments) : Promise.resolve({});
				};
			} },
			uci: uci,
			ui: {},
			poll: {},
			dom: {
				elem: function() { return false; },
				content: function() {}
			}
		}[name];
		},
	L: { bind: function(fn, obj) { return fn.bind.apply(fn, Array.prototype.slice.call(arguments, 1)); } },
	setTimeout: function() {},
	document: { addEventListener: function() {} }
};
context.view = context.require('view');
context.rpc = context.require('rpc');
context.ui = context.require('ui');
context.poll = context.require('poll');
context.dom = context.require('dom');
context.uci = uci;
vm.runInNewContext('String.prototype.format = function() { var a = arguments; return this.replace(/%s/g, function() { return a[0]; }); }; globalThis._ = function(s) { return s; };', context);
var source = fs.readFileSync(require('path').join(__dirname,
	'../htdocs/luci-static/resources/view/nordvpn/overview.js'), 'utf8');
var app = vm.runInNewContext('(function() { ' + source + '\n})()', context);

app.instance = 'main';
uciValues = { main: { hop_mode: 'single', selection: 'balanced', rotation_mode: 'interval', rotation_interval: '360' } };
assert.strictEqual(app.routingOnlyChange(app.optionSnapshot(), {}), true,
	'normalizing explicit UI defaults cannot trigger a reconnect');
assert.strictEqual(app.routingOnlyChange({ killswitch: JSON.stringify('0') },
	{ killswitch: JSON.stringify('1') }), true, 'routing changes do not reconnect');
assert.strictEqual(app.routingOnlyChange({ fixed_server: JSON.stringify('old') },
	{ fixed_server: JSON.stringify('new') }), false, 'server changes require reconnecting');

function deferred() {
	var resolve, reject;
	var promise = new Promise(function(yes, no) { resolve = yes; reject = no; });
	return { promise: promise, resolve: resolve, reject: reject };
}

function pickerTests() {
	context.dom.create = function(tag, attrs, children) {
		return { tag: tag, attrs: attrs || {}, children: children || [], value: (attrs || {}).value || '', events: {},
			classList: { add: function() {}, remove: function() {} },
			addEventListener: function(name, fn) { this.events[name] = fn; }, focus: function() { context.document.activeElement = this; },
			appendChild: function(child) { this.children.push(child); } };
	};
	context.dom.content = function(node, children) { node.children = children; };
	var timers = new Map(), nextTimer = 0;
	context.setTimeout = function(fn) { timers.set(++nextTimer, fn); return nextTimer; };
	context.clearTimeout = function(id) { timers.delete(id); };
	function flush() { var pending = Array.from(timers.values()); timers.clear(); pending.forEach(function(fn) { fn(); }); }
	function nodes(node, test) {
		if (!node || typeof node !== 'object') return [];
		if (Array.isArray(node)) return node.flatMap(function(child) { return nodes(child, test); });
		return (test(node) ? [node] : []).concat(nodes(node.children, test));
	}
	function css(node, name) { return (node.attrs.class || '').split(' ').includes(name); }
	function rows(v) { return nodes(v.srvPanel, function(node) { return css(node, 'nv-srv-relay'); }); }
	var relays = Array.from({ length: 125 }, function(_, i) {
		return { hostname: 'host' + (125 - i), name: 'Server #' + (125 - i), country_code: 'de', city: i % 2 ? 'Berlin' : 'Bonn', load: 10 };
	});
	relays.push({ hostname: 'dedicated', name: 'Dedicated', country_code: 'de', load: 0, dedicated: true });
	var v = Object.assign({}, app, { _ccNames: { de: 'Germany' }, status: { gateway: 'host100' }, _srvFilter: '',
		_serverChosen: 'host110', srvPanel: context.dom.create('div'), srvTrigger: context.dom.create('button'),
		markConnectionDirty: function() {}, updateRotationAvailability: function() {} });
	v._serverData = { relays: relays };
	v._serverIndex = v.srvBuildIndex(relays);
	assert(Object.isFrozen(v._serverIndex) && Object.isFrozen(v._serverIndex.groups[0].rows), 'display index is immutable');
	assert.strictEqual(v.srvRelayByHost('host5').hostname, 'host5');
	assert.strictEqual(v.srvRelayByHost('absent'), null);
	assert.strictEqual(v.srvLowestLoad().hostname, 'host1', 'numeric ties are deterministic and dedicated is excluded');
	assert.strictEqual(v._serverIndex.groups[0].rows[1].relay.hostname, 'host1');
	assert(Object.isFrozen(v._serverIndex.byHost.host5), 'indexed relays are immutable snapshots');
	var grouped = v.srvBuildIndex([
		{ hostname: 'fr2', country_code: 'fr', load: 2 }, { hostname: 'de-missing', country_code: 'de' },
		{ hostname: 'de10', country_code: 'de', load: 10 }, { hostname: 'de2', country_code: 'de', load: 10 } ]);
	assert.strictEqual(grouped.groups.map(function(g) { return g.name; }).join(','), 'FR,Germany', 'country groups sort by display name');
	assert.strictEqual(grouped.groups[1].rows.map(function(r) { return r.relay.hostname; }).join(','), 'de2,de10,de-missing', 'missing names use hostname and missing loads sort last');
	assert.strictEqual(v.srvBuildIndex([{ hostname: 'only-dedicated', load: 0, dedicated: true }, { hostname: 'no-load' }]).lowest, null);
	var originalSort = Array.prototype.sort;
	context.savedVmSort = vm.runInNewContext('Object.getPrototypeOf([]).sort', context);
	try {
		Array.prototype.sort = function() { throw new Error('filter/render must not sort'); };
		vm.runInNewContext("Object.getPrototypeOf([]).sort = function() { throw new Error('filter/render must not sort'); };", context);
		v.srvTogglePanel(); flush();
		assert.strictEqual(rows(v).length, 50, 'initial DOM has only one page of relay rows');
		assert.strictEqual(v._srvMatchCount, 126);
		var more = nodes(v.srvPanel, function(n) { return css(n, 'nv-srv-more'); })[0];
		more.focus(); more.attrs.click({ stopPropagation: function() {} });
		assert.strictEqual(rows(v).length, 50, 'Show more replaces the page with at most fifty rows');
		assert.strictEqual(context.document.activeElement, rows(v)[0], 'keyboard paging focuses the first new row');
		nodes(v.srvPanel, function(n) { return css(n, 'nv-srv-more'); })[0].attrs.click({ stopPropagation: function() {} });
		assert.strictEqual(rows(v).length, 26, 'all remaining relays are reachable on the last page');
		assert.strictEqual(nodes(v.srvPanel, function(n) { return css(n, 'nv-srv-more'); }).length, 0);
		nodes(v.srvPanel, function(n) { return css(n, 'nv-srv-prev'); })[0].attrs.click({ stopPropagation: function() {} });
		assert.strictEqual(rows(v).length, 50, 'Previous returns to a full bounded page');
		v._srvFilter = 'BERLIN'; v._srvOffset = 0; v.srvRenderList();
		assert.strictEqual(rows(v).length, 50);
		assert.strictEqual(v._srvMatchCount, 62, 'matching total excludes unmatched pin summaries');
		assert.strictEqual(v._serverChosen, 'host110', 'rendering never changes draft selection');
		v._srvFilter = 'HOST5'; v.srvRenderList();
		assert.strictEqual(v._srvMatchCount, 11, 'hostname search is normalized and does not force unmatched pins into the results');
		v._srvFilter = 'nothing'; v.srvRenderList();
		assert.strictEqual(rows(v).length, 0);
		assert.strictEqual(nodes(v.srvPanel, function(n) { return css(n, 'nv-srv-quick'); }).length, 2, 'quick controls survive empty filters');
		v._serverChosen = 'missing'; v.srvRenderList();
		assert.strictEqual(v._serverChosen, 'missing', 'missing pins are retained');
	} finally { Array.prototype.sort = originalSort; vm.runInNewContext('Object.getPrototypeOf([]).sort = savedVmSort;', context); }
	var filter = v._srvFilterEl;
	filter.value = 'Berlin'; filter.events.input(); filter.value = 'Bonn'; filter.events.input();
	assert.strictEqual(timers.size, 1, 'rapid input coalesces');
	flush(); assert.strictEqual(v._srvFilter, 'Bonn');
	filter.value = 'late'; filter.events.input(); v.srvClosePanel();
	assert.strictEqual(timers.size, 0, 'closing cancels delayed work');
	v.srvTogglePanel(); flush();
	assert.strictEqual(v._srvFilterEl.value, 'late', 'reopening preserves typed filter');
	v._srvFilter = ''; v._srvFilterEl.value = ''; v.srvRenderList();
	var pendingMore = nodes(v.srvPanel, function(n) { return css(n, 'nv-srv-more'); })[0];
	v._srvFilterEl.value = 'Server #125'; v._srvFilterEl.events.input();
	pendingMore.attrs.click({ stopPropagation: function() {} });
	assert.strictEqual(rows(v).length, 1, 'paging during debounce renders the new filter from its first page');
	assert.strictEqual(timers.size, 0, 'paging cancels the pending filter callback');
	v._srvFilterEl.events.input(); v.srvReplaceData([]);
	assert.strictEqual(timers.size, 0, 'new data cancels callbacks for old data');
	assert.strictEqual(v.srvLowestLoad(), null);
	var contextView = Object.assign({}, v, { credNode: {}, ensureConnectionState: function() {}, buildCredentials: function() {},
		buildConnection: function() {}, buildRoutingSection: function() {}, buildRotation: function() {}, buildAdvanced: function() {},
		srvRenderTrigger: function() {} });
	contextView._srvFilterTimer = context.setTimeout(function() { throw new Error('old form callback'); });
	contextView.buildFormSections();
	assert.strictEqual(timers.size, 0, 'form/context replacement cancels pending work');
	// The fallback must remain numeric when Intl is absent or rejects options.
	var intl = context.Intl;
	for (var replacement of [null, { Collator: function() { throw new Error('unsupported'); } },
		{ Collator: function() { this.compare = function(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }; } }]) {
		context.Intl = replacement;
		var fallback = vm.runInNewContext('(function() { ' + source + '\n})()', context);
		var idx = fallback.srvBuildIndex([relays[0], relays[123], relays[115]]);
		assert.strictEqual(idx.groups[0].rows.map(function(r) { return r.relay.hostname; }).join(','), 'host2,host10,host125');
	}
	context.Intl = intl;
	context.setTimeout = function() {};
}

async function draftTests() {
	// A small DOM executes the real connection widgets, their bound callbacks,
	// form replacement, UCI collection and save/discard flows.
	context.dom.create = function(tag, attrs, children) {
		return { tag: tag, attrs: attrs || {}, children: children || [], value: (attrs || {}).value || '',
			style: {}, events: {}, classList: { add: function() {}, remove: function() {}, toggle: function() {} },
			addEventListener: function(name, fn) { this.events[name] = fn; },
			appendChild: function(child) { if (!Array.isArray(this.children)) this.children = [this.children]; this.children.push(child); } };
	};
	context.dom.content = function(node, value) { node.children = value; };
	context.window.confirm = function() { return true; };
	context.poll.remove = function() {};
	function textOf(node) {
		if (node == null) return '';
		if (typeof node !== 'object') return '' + node;
		if (Array.isArray(node)) return node.map(textOf).join('');
		return textOf(node.children);
	}
	var requests, view;
	function fixture(pin, rotation) {
		uciValues = { main: { fixed_server: pin || '', locations: ['de'], hop_mode: 'single', mtu: '1420', rotation_enabled: rotation ? '1' : '0' },
			other: { fixed_server: 'other-pin', locations: ['de'], hop_mode: 'single' } };
		uciWrites.length = 0;
		requests = [];
		calls.servers = function(codes, hop, group) {
			var request = deferred(); request.query = [ codes.slice(), hop, group ]; requests.push(request);
			return request.promise;
		};
		calls.commit = function() { return Promise.resolve(); };
		uci.save = function() { return Promise.resolve(); };
		uci.load = function() { return Promise.resolve(); };
		calls.instances = function() { return Promise.resolve({ instances: [
			{ instance: 'main', enabled: false, routing: { mode: 'auto' } },
			{ instance: 'other', enabled: false, routing: { mode: 'auto' } }
		] }); };
		view = Object.assign({}, app, { instance: 'main', status: { enabled: false }, _connectionState: null,
			_otherDirty: false, _saving: false, dirty: false, refs: {}, credNode: {}, formNode: {},
			saveBtn: {}, discardBtn: {}, locations: { countries: [{ code: 'de', name: 'Germany', single: 2, multi: 2, onion: 2, p2p: 2,
				cities: [{ code: 'de-berlin', name: 'Berlin', single: 2, multi: 2, onion: 2, p2p: 2 }] },
				{ code: 'fr', name: 'France', single: 2, multi: 2, onion: 2, p2p: 2,
					cities: [{ code: 'fr-paris', name: 'Paris', single: 2, multi: 2, onion: 2, p2p: 2 }] }] },
			// Keep unrelated panels small; their ordinary input is a real view input.
			buildCredentials: function() { return []; }, buildRoutingSection: function() { return []; },
			buildAdvanced: function() {
				return [ this.input('mtu', 'text', uci.get('nordvpn', this.instance, 'mtu') || '1420'),
					this.input('cache_dir', 'text', uci.get('nordvpn', 'main', 'cache_dir') || '') ];
			}, updateInstancesTable: function() {}, updateStatusBand: function() {}, refreshHistory: function() {},
			notice: function(message) { this.lastNotice = message; return {}; }, dismiss: function() {},
			clearChangeIndicator: function() {} });
		view.buildFormSections();
		return view;
	}
	async function finish(request, result, fail) {
		if (fail) request.reject(new Error(result));
		else request.resolve(result || { relays: [] });
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	}
	function assertPin(pin, message) {
		assert.strictEqual(view._serverChosen, pin, message);
		assert(textOf(view.srvTrigger).includes(pin || 'Automatic server'), 'visible picker agrees with the draft');
		view.collectIntoUci();
		assert.strictEqual(uciValues[view.instance].fixed_server || '', pin, 'UCI collection writes the visible pin');
	}

	// Focused original regression: initial list RPC returns after a new pin.
	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	await finish(requests[0]);
	assertPin('edited-pin', 'server-list completion cannot overwrite a newly selected pin');
	assert(textOf(view.srvTrigger).includes('(not in the set)'), 'absent pins stay visible as unavailable');

	fixture('persisted-pin');
	view.srvSetChosen('');
	await finish(requests[0]);
	assertPin('', 'server-list completion cannot restore an explicitly cleared pin');
	assert.strictEqual(view.dirty, true);
	view.srvSetChosen('persisted-pin');
	assert.strictEqual(view.dirty, false, 'returning to the persisted connection values clears dirty state');

	fixture('', true);
	view.srvSetChosen('temporary-pin');
	view.srvSetChosen('');
	assert.strictEqual(view.rotEnable.checked, false, 'pinning explicitly disables scheduled rotation');
	assert.strictEqual(view.dirty, true, 'clearing a temporary pin retains the changed rotation setting as dirty');
	view.collectIntoUci();
	assert.strictEqual(uciValues.main.rotation_enabled, '0', 'the changed rotation setting reaches UCI');

	fixture('persisted-pin');
	view.poolSetWhole('fr');
	view.setHopMode('multihop');
	await finish(requests[requests.length - 1]);
	await finish(requests[0], 'superseded failure', true);
	assert.strictEqual(view.hopMode(), 'multihop');
	assert.strictEqual(view.poolEntries.map(function(e) { return e.code; }).join(','), 'de,fr');
	assert.strictEqual(textOf(view.srvError), '', 'a superseded error cannot replace latest success');
	assertPin('persisted-pin', 'location and hop responses preserve the pin');
	assert.strictEqual(uciValues.main.hop_mode, 'multihop');
	assert.strictEqual(uciValues.main.locations.join(','), 'de,fr');

	fixture('persisted-pin');
	view.poolSetWhole('fr');
	await finish(requests[1], { relays: [{ hostname: 'new-data' }] });
	await finish(requests[0], { relays: [{ hostname: 'old-data' }] });
	assert.strictEqual(view.srvRelayByHost('old-data'), null, 'older same-context success cannot overwrite newer server data');
	assert(view.srvRelayByHost('new-data'));

	fixture('persisted-pin');
	view.p2pBox.checked = true;
	view.p2pBox.attrs.change();
	assert.strictEqual(requests[1].query[2], 'p2p', 'group callback queries the edited group');
	await finish(requests[0]);
	await finish(requests[1], { error: 'offline' });
	assert(textOf(view.srvError).includes('offline') && textOf(view.srvError).includes('Retry'), 'latest list error is visible and retryable');
	assertPin('persisted-pin', 'group changes and failures preserve the pin');
	assert.strictEqual(uciValues.main.server_group, 'p2p');
	var retry = view.srvError.children[2];
	var retryPromise = retry.attrs.click();
	await finish(requests[2]); await retryPromise;
	assert.strictEqual(textOf(view.srvError), '', 'successful retry clears the error');

	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	await view.discard();
	await finish(requests[0], 'late discarded failure', true);
	await finish(requests[1]);
	assertPin('persisted-pin', 'discard restores persisted values and invalidates earlier requests');
	assert.strictEqual(view.dirty, false);

	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	view.selectInstance('other');
	await finish(requests[1]);
	await finish(requests[0], { relays: [{ hostname: 'old-instance-data' }] });
	assertPin('other-pin', 'instance switch rejects old form results even when query generations overlap');
	assert.strictEqual(view.srvRelayByHost('old-instance-data'), null);

	fixture('persisted-pin');
	view.srvSetChosen('saved-pin');
	var oldRequest = requests[0];
	await view.save();
	await finish(oldRequest, { relays: [{ hostname: 'old-form-data' }] });
	await finish(requests[1]);
	assertPin('saved-pin', 'successful save synchronization retains the saved pin after late list responses');
	assert.strictEqual(view.dirty, false);

	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	var load = deferred(); uci.load = function() { return load.promise; };
	var discarding = view.discard();
	await finish(requests[0], { relays: [{ hostname: 'discarded-data' }] });
	assert.strictEqual(view.srvRelayByHost('discarded-data'), null, 'discard invalidates a pending list before config load completes');
	load.resolve(); await discarding;
	assertPin('persisted-pin', 'delayed discard restores persisted values');

	fixture('persisted-pin');
	view.srvSetChosen('saved-pin');
	var commit = deferred(); calls.commit = function() { return commit.promise; };
	var saving = view.save();
	await Promise.resolve(); await Promise.resolve();
	view.srvSetChosen('newer-pin');
	view.refs.mtu.value = '1380'; view.refs.mtu.events.input();
	await finish(requests[0]);
	commit.resolve(); await saving;
	assert.strictEqual(view._connectionState.baseline.fixed_server, 'saved-pin', 'successful save establishes the captured snapshot as baseline');
	assert.strictEqual(uciValues.main.fixed_server, 'saved-pin', 'pending save writes the captured pin');
	assert.strictEqual(view.refs.mtu.value, '1380', 'save completion retains later nonconnection edits');
	assert.strictEqual(view.dirty, true);
	assertPin('newer-pin', 'save completion retains the newer visible pin and its eventual UCI value');

	fixture('persisted-pin');
	view.srvSetChosen('saved-pin');
	var statusRead = deferred(); calls.instances = function() { return statusRead.promise; };
	saving = view.save();
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	view.srvSetChosen('after-commit-pin');
	view.refs.mtu.value = '1360'; view.refs.mtu.events.input();
	statusRead.resolve({ instances: [{ instance: 'main', enabled: false, routing: { mode: 'manual' } }] });
	await saving;
	assert.strictEqual(view.refs.mtu.value, '1360', 'late post-save status refresh preserves newer ordinary inputs');
	assertPin('after-commit-pin', 'post-save refresh cannot replace edits made after commit');

	fixture('persisted-pin');
	view.cacheRow = {}; view._cacheJob = 'draft-refresh';
	calls.refresh_status = function() { return Promise.resolve({ id: 'draft-refresh', state: 'done' }); };
	var locationsRead = deferred(); calls.locations = function() { return locationsRead.promise; };
	var refreshing = view.pollCacheOnce({});
	await Promise.resolve(); await Promise.resolve();
	view.selectInstance('other');
	view.srvSetChosen('other-refresh-edit');
	locationsRead.resolve(view.locations); await refreshing;
	await finish(requests[requests.length - 1]);
	assertPin('other-refresh-edit', 'late cache refresh across an instance switch preserves the new draft');

	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	view.refs.mtu.value = '1380'; view.refs.mtu.events.input();
	uci.save = function() { return Promise.reject(new Error('save offline')); };
	await view.save();
	await finish(requests[0]);
	assert.strictEqual(uciValues.main.fixed_server, 'persisted-pin', 'failed save restores staged UCI baseline');
	assert.strictEqual(uciValues.main.mtu, '1420');
	assert.strictEqual(view.refs.mtu.value, '1380');
	assert.strictEqual(view.dirty, true, 'failed save retains editable state');
	assert.strictEqual(view.saveBtn.disabled, false, 'failed save is retryable');
	// Discard also restores other fields after failed UCI staging.
	await view.discard();
	assert.strictEqual(view.refs.mtu.value, '1420');
	assertPin('persisted-pin', 'discard after failure restores the original pin');

	fixture('persisted-pin');
	view.srvSetChosen('saved-pin');
	commit = deferred(); calls.commit = function() { return commit.promise; };
	saving = view.save();
	await Promise.resolve(); await Promise.resolve();
	view.selectInstance('other');
	view.srvSetChosen('other-edit');
	commit.resolve(); await saving;
	assertPin('other-edit', 'old-instance save completion cannot overwrite the new instance draft');
	assert.strictEqual(view._connectionState.baseline.fixed_server, 'other-pin');

	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	commit = deferred(); calls.commit = function() { return commit.promise; };
	saving = view.save();
	await Promise.resolve(); await Promise.resolve();
	view.srvSetChosen('later-edit');
	commit.reject(new Error('commit offline')); await saving;
	await finish(requests[0], 'list offline', true);
	assert.strictEqual(view.dirty, true);
	assertPin('later-edit', 'late commit and refresh failures preserve newer edits');

	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	view.refs.cache_dir.value = '/tmp/saving-cache'; view.refs.cache_dir.events.input();
	commit = deferred(); calls.commit = function() { return commit.promise; };
	saving = view.save();
	await Promise.resolve(); await Promise.resolve();
	uciValues.main.external_option = 'new action';
	uciValues.main.mtu = '1300';
	uciValues.main.fixed_server = 'external-pin';
	uciValues.main.cache_dir = '/tmp/new-action-cache';
	commit.reject(new Error('commit offline')); await saving;
	assert.strictEqual(uciValues.main.external_option, 'new action', 'failed save preserves newly introduced options');
	assert.strictEqual(uciValues.main.mtu, '1300', 'failed save preserves options this save did not change');
	assert.strictEqual(uciValues.main.fixed_server, 'external-pin', 'failed save preserves staged fields subsequently changed by another action');
	assert.strictEqual(uciValues.main.cache_dir, '/tmp/new-action-cache', 'failed save preserves newer shared cache settings');
	assert.strictEqual(view._serverChosen, 'edited-pin', 'conditional staging rollback does not replace the editable pin');

	fixture('persisted-pin');
	view.srvSetChosen('edited-pin');
	commit = deferred(); calls.commit = function() { return commit.promise; };
	saving = view.save();
	await Promise.resolve(); await Promise.resolve();
	delete uciValues.main;
	commit.reject(new Error('deleted while saving')); await saving;
	assert.strictEqual(uciValues.main, undefined, 'failed save cannot recreate a deleted instance');
	assert.strictEqual(view._serverChosen, 'edited-pin');

	fixture('persisted-pin');
	view._routingMode = 'manual';
	view.refs.mtu.value = '1380'; view.refs.mtu.events.input();
	var oldInput = view.refs.mtu;
	await view.refreshStatus();
	assert.strictEqual(view.refs.mtu, oldInput, 'status-driven routing changes cannot rebuild a dirty nonconnection field');
	assert.strictEqual(view.refs.mtu.value, '1380');
	uci.save = function() { return Promise.resolve(); };
	calls.commit = function() { return Promise.resolve(); };
}

async function probeTests() {
	var legacyCalls = 0, starts = 0, renders = 0;
	calls.external_ip = function() { legacyCalls++; return Promise.resolve({ protected: true }); };
	function fixture(generation) {
		return Object.assign({}, app, { instance: 'main', _formGeneration: 1,
			status: { state: 'connected', gateway: 'same-server', probe_generation: generation || 'one' },
			extIp: null, _extIpPending: null, _extIpLastCheck: null, _extIpRetryAt: null,
			updateStatusBand: function() { renders++; } });
	}
	function textOf(node) {
		if (node == null) return '';
		if (typeof node !== 'object') return '' + node;
		if (Array.isArray(node)) return node.map(textOf).join('');
		return textOf(node.children);
	}
	var view = fixture(), requested = [];
	calls.external_ip_status = function(instance, id) {
		requested.push([instance, id]); return Promise.resolve({ state: 'stale', generation: 'one' });
	};
	calls.external_ip_start = function() { starts++; return Promise.resolve({ id: 'mine', state: 'pending', generation: 'one' }); };
	await view.maybeFetchExternalIp(view.externalIpKey());
	assert.strictEqual(starts, 1, 'stale observation launches one asynchronous worker');
	assert.strictEqual(legacyCalls, 0, 'LuCI never calls the retained synchronous HTTP method');
	assert(textOf(view.externalIpLine(view.externalIpKey())).includes('pending'), 'pending freshness is visible');
	view._extIpLastCheck = null;
	calls.external_ip_status = function(instance, id) {
		requested.push([instance, id]);
		return Promise.resolve({ id: 'mine', state: 'fresh', generation: 'one', ttl_seconds: 120,
			result: { protected: true, ip: '1.2.3.4' } });
	};
	await view.maybeFetchExternalIp(view.externalIpKey());
	assert.strictEqual(requested[1][1], 'mine', 'polling passes the precise worker ID');
	assert(textOf(view.externalIpLine(view.externalIpKey())).includes('Protected by NordVPN'), 'fresh success displays provider verdict');
	view.extIp.expires = 0;
	assert(textOf(view.externalIpLine(view.externalIpKey())).includes('stale'), 'locally expired success loses protected styling immediately');
	view.status.probe_generation = 'two';
	assert(!textOf(view.externalIpLine(view.externalIpKey())).includes('Protected by NordVPN'), 'same-gateway reconnect cannot reuse old success');
	view = fixture();
	var delayed = deferred();
	calls.external_ip_status = function() { return delayed.promise; };
	var pending = view.maybeFetchExternalIp(view.externalIpKey());
	assert.strictEqual(view.maybeFetchExternalIp(view.externalIpKey()), pending, 'one tab deduplicates a pending status request');
	// A normal status RPC can finish before the delayed probe-status response.
	var normalDone = false;
	await Promise.resolve().then(function() { normalDone = true; });
	assert(normalDone && view.extIp === null, 'probe polling does not hold normal status updates');
	view.instance = 'other';
	delayed.resolve({ state: 'fresh', generation: 'one', ttl_seconds: 120, result: { protected: true } });
	await pending;
	assert.strictEqual(view.extIp, null, 'late response cannot populate another instance');
	view = fixture(); delayed = deferred();
	calls.external_ip_status = function() { return delayed.promise; };
	pending = view.maybeFetchExternalIp(view.externalIpKey());
	view._formGeneration++;
	delayed.resolve({ state: 'fresh', generation: 'one', ttl_seconds: 120, result: { protected: true } });
	await pending;
	assert.strictEqual(view.extIp, null, 'late response cannot populate a replaced form');
	view = fixture(); delayed = deferred();
	calls.external_ip_status = function() { return delayed.promise; };
	pending = view.maybeFetchExternalIp(view.externalIpKey());
	view.status.probe_generation = 'new-generation';
	delayed.resolve({ state: 'fresh', generation: 'one', ttl_seconds: 120, result: { protected: true } });
	await pending;
	assert.strictEqual(view.extIp, null, 'late generation cannot restore protection after rotation');
	view = fixture(); delayed = deferred();
	calls.external_ip_status = function() { return delayed.promise; };
	pending = view.maybeFetchExternalIp(view.externalIpKey());
	view.status.state = 'disconnected';
	delayed.reject(new Error('old request failed'));
	await pending;
	assert.strictEqual(view.extIp, null, 'late failure after disconnect cannot replace view context');
	view = fixture();
	view.extIp = { key: view.externalIpKey(), observation: { id: 'mine', state: 'pending' } };
	calls.external_ip_status = function() { return Promise.resolve({ id: 'other-job', state: 'fresh', generation: 'one', ttl_seconds: 120, result: { protected: true } }); };
	await view.maybeFetchExternalIp(view.externalIpKey());
	assert.strictEqual(view.extIp.observation.state, 'failed', 'another job cannot satisfy an exact-ID watcher');
	assert(!textOf(view.externalIpLine(view.externalIpKey())).includes('Protected by NordVPN'), 'failed status never keeps protected styling');
	view = fixture(); var beforeStarts = starts;
	calls.external_ip_status = function() { return Promise.resolve({ state: 'failed', generation: 'one', retry_after_seconds: 30, error: 'timeout' }); };
	await view.maybeFetchExternalIp(view.externalIpKey());
	assert.strictEqual(starts, beforeStarts, 'server backoff suppresses worker starts');
	assert(textOf(view.externalIpLine(view.externalIpKey())).includes('timeout'), 'failed observation is visible');
	view = fixture();
	context.L.hasViewPermission = function() { return false; };
	calls.external_ip_status = function() { return Promise.resolve({ state: 'stale', generation: 'one' }); };
	await view.maybeFetchExternalIp(view.externalIpKey());
	assert.strictEqual(starts, beforeStarts, 'read-only views inspect cache without starting probes');
	delete context.L.hasViewPermission;
	assert(renders > 0, 'accepted observations update the status band');
}

async function run() {
	pickerTests();
	await draftTests();
	await probeTests();
	// Watch the returned job ID even if a newer identical operation starts.
	var originalTimer = context.window.setTimeout;
	context.window.setTimeout = function(fn) { fn(); };
	app.pauseStatusPoll = function() {};
	app.resumeStatusPoll = function() {};
	var watched = [];
	calls.apply_status = function(id) {
		watched.push(id);
		return Promise.resolve({ id: 'mine', kind: 'apply', instance: 'main', state: 'done', result: { state: 'success', gateway: 'mine-server' } });
	};
	var exact = await app.runJob(function() {
		return Promise.resolve({ started: true, apply: { id: 'mine' } });
	}, 'main', 'apply');
	assert.strictEqual(exact.gateway, 'mine-server', 'the watcher retrieves its own terminal outcome');
	assert.deepStrictEqual(watched, ['mine'], 'polls pass the exact ID returned by start');
	calls.apply_status = function() {
		return Promise.resolve({ id: 'newer', kind: 'apply', instance: 'main', state: 'done', result: { state: 'success' } });
	};
	var replaced = await app.runJob(function() { return Promise.resolve({ apply: { id: 'mine' } }); }, 'main', 'apply');
	assert(replaced.error, 'a newer same-kind and same-instance result is rejected');
	calls.apply_status = function(id) {
		assert.strictEqual(id, '', 'older backends are polled without an ID');
		return Promise.resolve({ kind: 'apply', instance: 'main', state: 'done', result: { state: 'success' } });
	};
	var legacy = await app.runJob(function() { return Promise.resolve({ apply: { kind: 'apply', instance: 'main' } }); }, 'main', 'apply');
	assert.strictEqual(legacy.state, 'success', 'no-ID backend remains compatible');
	calls.apply_status = function(id) { return Promise.resolve({ id: id, state: 'missing', error: 'job status is unavailable or expired' }); };
	var missing = await app.runJob(function() { return Promise.resolve({ apply: { id: 'expired' } }); }, 'main', 'apply');
	assert.strictEqual(missing.error, 'job status is unavailable or expired', 'expired own job does not become another success');
	context.window.setTimeout = originalTimer;
	// Package updater uses text nodes for server errors and disables writes while
	// a worker is running. Exercise the actual form controls and RPC arguments.
	var elements = [];
	context.dom.create = function(tag, attrs, children) {
		var el = { tag: tag, attrs: attrs || {}, children: children, value: '', style: {},
			addEventListener: function() {} };
		elements.push(el);
		return el;
	};
	var updateNotices = [];
	context.ui.addNotification = function(a, message) { updateNotices.push(message.children); };
	context.poll.add = function() {};
	context.dom.content = function(node, value) { node.text = Array.isArray(value) ? value.join('') : value; };
	calls.update_status = function() { return Promise.resolve({ state: 'idle', installed: '1.8.0-r1' }); };
	app.buildUpdater();
	await app.refreshUpdateStatus();
	assert.strictEqual(app.updateButton.disabled, false);
	var selector = elements.find(function(e) { return e.tag === 'select'; });
	var versionInput = elements.find(function(e) { return e.tag === 'input'; });
	var requested;
	calls.update_start = function(v) { requested = v; return Promise.resolve({ started: true }); };
	calls.update_status = function() { return Promise.resolve({ state: 'running', message: 'Downloading' }); };
	selector.value = 'latest';
	app.dirty = true;
	await app.updateButton.attrs.click();
	assert.strictEqual(requested, undefined, 'unsaved changes prevent updates');
	app.dirty = false;
	await app.updateButton.attrs.click();
	assert.strictEqual(requested, 'latest', 'latest selection reaches the updater');
	assert.strictEqual(app.updateButton.disabled, true, 'running update disables button');
	selector.value = 'custom'; versionInput.value = 'v1.8.0-r20261015';
	await app.updateButton.attrs.click();
	assert.strictEqual(requested, 'v1.8.0-r20261015', 'custom tag reaches the updater');
	versionInput.value = '1.8.0; id'; requested = undefined;
	await app.updateButton.attrs.click();
	assert.strictEqual(requested, undefined, 'invalid version never reaches RPC');
	calls.update_status = function() { return Promise.resolve({ state: 'error', error: '<download failed>' }); };
	await app.refreshUpdateStatus();
	assert.strictEqual(app.updateButton.disabled, false, 'failed update can be retried');
	assert(app.updateMessage.text.includes('<download failed>'), 'failure details are rendered as text');
	calls.update_status = function() { return Promise.resolve({ state: 'success', version: 'v1.8.0' }); };
	await app.refreshUpdateStatus();
	assert(app.updateMessage.text.includes('Reload this page'), 'success explains how to load the new UI');

	app.instance = 'main';
	var routingFailure = { ok: false, stage: 'reload:firewall', error: 'firewall reload failed', rollback: { ok: false } };
	assert.strictEqual(app.operationResult(routingFailure, 'main'), routingFailure, 'structured backend failure is preserved');
	assert.strictEqual(app._routingUnconfirmed.main, true, 'failed application cannot confirm saved protection preferences');
	var dnsWarning = app.dnsLine({ state: 'connected', routing: { mode: 'steered' } });
	assert(JSON.stringify(dnsWarning).includes('DNS policy is unconfirmed'), 'failed routing shows an unconfirmed DNS policy');
	app.operationResult({ ok: true, changed: false, stage: 'unchanged' }, 'other');
	assert.strictEqual(app._routingUnconfirmed.main, true, 'another instance success cannot clear the failure');
	var missingError = app.operationResult({ ok: false, stage: 'commit:network' }, 'main');
	assert(missingError.error.includes('commit:network'), 'structured failure without legacy error still reaches existing notices');
	app.operationResult({ ok: true, changed: false, stage: 'unchanged' }, 'main');
	assert.strictEqual(app._routingUnconfirmed.main, undefined, 'confirmed unchanged application clears the warning');
	app._routingUnconfirmed = {};
	assert.strictEqual(app.routingUnconfirmed({ routing_application: { confirmed: false, stage: 'applying' } }), true,
		'a fresh view uses persisted pending state after worker death or page reload');
	assert.strictEqual(app.routingUnconfirmed({ routing_application: { confirmed: true } }), false,
		'persisted confirmed installation is accepted after page reload');
	var reloadedDnsWarning = app.dnsLine({ state: 'connected', routing_application: { confirmed: false }, routing: { mode: 'auto' } });
	assert(JSON.stringify(reloadedDnsWarning).includes('DNS policy is unconfirmed'), 'reloaded view cannot claim failed DNS installation');

	var notices = [];
	app.notice = function(message) { notices.push(message); return {}; };
	app.dismiss = function() {};
	app.refreshStatus = function() { app.refreshed = true; return Promise.resolve(); };
	app.dirty = false;
	app._disableAllRunning = false;
	app.refreshed = false;
	uciWrites.length = 0;
	calls.disable_all = function() { return Promise.resolve({ ok: true, disabled: ['main'] }); };
	await app.disableAll();
	assert(app.refreshed, 'disable all refreshes status');
	assert(uciWrites.some(function(w) { return w[1] === 'main' && w[2] === 'enabled' && w[3] === '0'; }),
		'disabled state is synchronized into UCI');
	assert(notices.some(function(s) { return s.indexOf('All VPNs are disabled') === 0; }), 'success is reported');

	notices.length = 0;
	app.refreshed = false;
	calls.disable_all = function() { return Promise.resolve({ ok: false, disabled: ['main'], errors: [{ instance: 'other', error: 'busy' }] }); };
	await app.disableAll();
	assert(app.refreshed, 'partial failure refreshes status');
	assert(notices.some(function(s) { return s.indexOf('Some VPNs could not be disabled: other: busy') === 0; }),
		'partial errors are reported');

	// Refresh errors remain visible alongside the usable previous list and age.
	var cacheText = '';
	context.dom.content = function(node, children) { cacheText = Array.isArray(children) ? children.join('') : children; };
	context.poll.remove = function() {};
	app.cacheRow = {};
	app._cacheJob = 'my-refresh';
	app.rebuildPoolWidget = function() {};
	app.refreshServerList = function() {};
	calls.refresh_status = function(id) {
		assert.strictEqual(id, 'my-refresh', 'cache polls use reserved refresh identity');
		return Promise.resolve({ id: id, state: 'error', message: 'disk full' });
	};
	calls.locations = function() { return Promise.resolve({ available: true, state: 'stale', cache_info: { created: 'yesterday' } }); };
	var cacheButton = { disabled: true };
	await app.pollCacheOnce(cacheButton);
	assert(cacheText.includes('disk full') && cacheText.includes('yesterday') && cacheText.includes('stale'),
		'failed refresh displays error with previous cache availability and age');
	assert.strictEqual(cacheButton.disabled, false, 'terminal refresh failure enables retry');
	calls.refresh_status = function() { return Promise.resolve({ id: 'other-refresh', state: 'done' }); };
	cacheButton.disabled = true;
	await app.pollCacheOnce(cacheButton);
	assert.strictEqual(cacheButton.disabled, true, 'another refresh completion cannot finish this watcher');
	calls.refresh_status = function() { return Promise.resolve({ id: 'my-refresh', state: 'missing', error: 'status lost' }); };
	calls.locations = function() { return Promise.reject(new Error('RPC unavailable')); };
	await app.pollCacheOnce(cacheButton);
	assert(cacheText.includes('status lost') && cacheText.includes('RPC unavailable') && cacheText.includes('yesterday'),
		'missing status and a failed locations RPC remain visible with previous cache age');
	calls.refresh_status = function() { return Promise.resolve({ state: 'idle' }); };
	await app.pollCacheOnce(cacheButton);
	assert(cacheText.includes('refresh completion is unavailable'), 'idle after start cannot claim refresh success');
	calls.refresh_locations = function() { return Promise.resolve({ error: 'status storage unavailable' }); };
	await app.refreshCache({ target: cacheButton });
	assert(cacheText.includes('status storage unavailable') && cacheText.includes('yesterday'), 'start failure preserves previous cache context');

	notices.length = 0;
	app.status = { enabled: false };
	app.poolEntries = [{ count: 1 }];
	app.refs = {};
	app.saveBtn = {};
	app.discardBtn = {};
	app.formNode = {};
	app.optionSnapshot = function() { return {}; };
	app.collectIntoUci = function() {};
	app.clearChangeIndicator = function() {};
	app.buildFormSections = function() { return []; };
	app.refreshStatus = function() { return Promise.resolve(); };
	app.probeTargetList = function() { return []; };
	app.dirty = true;
	await app.save();
	assert(notices.some(function(s) { return s.indexOf('Settings saved. The VPN remains disabled.') === 0; }),
		'saving a disabled instance does not apply or reconnect it');
}

run().catch(function(err) {
	console.error(err);
	process.exitCode = 1;
});
