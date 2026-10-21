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
		return option ? sec[option] : sec;
	},
	set: function() { uciWrites.push(Array.prototype.slice.call(arguments)); },
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
	L: { bind: function(fn, obj) { return fn.bind(obj); } }
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

async function run() {
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
