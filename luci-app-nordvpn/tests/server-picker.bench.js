'use strict';
/* global require, process, __dirname */
// Local Chromium DOM benchmark. No LuCI server, network, npm packages or router.
// Usage: node luci-app-nordvpn/tests/server-picker.bench.js [overview.js]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname,
	'../htdocs/luci-static/resources/view/nordvpn/overview.js'), 'utf8');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nordvpn-picker-'));
const browser = spawn(process.env.CHROMIUM || '/usr/bin/chromium', [ '--headless', '--no-sandbox',
	'--disable-dev-shm-usage', '--remote-debugging-port=0', '--js-flags=--expose-gc',
	'--enable-precise-memory-info', '--user-data-dir=' + profile, 'about:blank' ], { stdio: 'ignore' });
let socket, nextId = 0;
const pending = new Map();
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function command(method, params = {}) {
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(fn, ...args) {
	const r = await command('Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')',
		awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
	return r.result.value;
}
async function run() {
	let port;
	for (let i = 0; i < 100; i++) {
		try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
		catch (e) { await pause(50); }
	}
	if (!port) throw Error('Chromium did not start');
	const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
	socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	socket.onmessage = event => {
		const message = JSON.parse(event.data), task = pending.get(message.id);
		if (!task) return;
		pending.delete(message.id);
		if (message.error) task.reject(Error(JSON.stringify(message.error))); else task.resolve(message.result);
	};
	const version = await command('Browser.getVersion');
	const results = [];
	for (const viewport of [{ width: 1440, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
		await command('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1 });
		await evaluate(function(source) {
			document.head.innerHTML = '<meta name="viewport" content="width=device-width,initial-scale=1">';
			String.prototype.format = function(...args) { let i = 0; return this.replace(/%[sd]/g, () => args[i++]); };
			window._ = s => s;
			window.L = { bind: (fn, obj, ...args) => fn.bind(obj, ...args) };
			window.view = { extend: obj => obj };
			window.rpc = { declare: () => () => Promise.resolve({}) };
			window.uci = {}; window.ui = {}; window.poll = {};
			function append(node, children) {
				if (Array.isArray(children)) children.forEach(child => append(node, child));
				else if (children != null) node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
			}
			window.dom = { elem: node => node instanceof Node, create: (tag, attrs, children) => {
				const node = document.createElement(tag);
				Object.entries(attrs || {}).forEach(([key, value]) => {
					if (typeof value === 'function') node.addEventListener(key, value);
					else if (value != null) node.setAttribute(key, value);
				});
				append(node, children); return node;
			}, content: (node, children) => { node.replaceChildren(); append(node, children); } };
			window.app = new Function(source.replace('return view.extend(',
				'document.head.appendChild(dom.create("style", {}, STYLE)); return view.extend('))();
		}, source);
		for (const size of [250, 2000, 10000]) {
			results.push(await evaluate(async function(size, viewport) {
				const med = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
				const times = { index: [], open: [], filter: [], reopen: [] }, heaps = [], counts = [], rowCounts = [];
				for (let sample = -1; sample < 7; sample++) {
					document.body.replaceChildren();
					const relays = Array.from({ length: size }, (_, i) => ({ hostname: 'relay' + (size - i) + '.example',
						name: 'Server #' + (size - i), country_code: ['de', 'fr', 'us', 'nl'][i % 4],
						city: 'City ' + (i % 8), load: i % 5 ? 10 : 20, p2p: i % 2 === 0, dedicated: i % 31 === 0 }));
					const v = Object.assign({}, window.app, { _serverChosen: '', _srvFilter: '', _srvOpen: false,
						_ccNames: { de: 'Germany', fr: 'France', us: 'United States', nl: 'Netherlands' },
						status: { gateway: relays[size - 1].hostname }, srvPanel: dom.create('div', { class: 'nv-pool-panel hidden' }),
						srvTrigger: dom.create('button', {}), markConnectionDirty() {}, updateRotationAvailability() {} });
					document.body.append(v.srvTrigger, v.srvPanel);
					function timed(fn) { const start = performance.now(); fn(); v.srvPanel.getBoundingClientRect(); return performance.now() - start; }
					const index = timed(() => { v._serverData = { relays }; if (v.srvBuildIndex) v._serverIndex = v.srvBuildIndex(relays); });
					const open = timed(() => v.srvTogglePanel());
					const openNodes = v.srvPanel.querySelectorAll('*').length;
					const openRows = v.srvPanel.querySelectorAll('.nv-pool-row:not(.nv-srv-quick)').length;
					const filter = timed(() => { v._srvFilter = 'city 0'; v.srvRenderList(); });
					const filterNodes = v.srvPanel.querySelectorAll('*').length;
					const filterRows = v.srvPanel.querySelectorAll('.nv-pool-row:not(.nv-srv-quick)').length;
					v.srvClosePanel(); v._srvFilter = '';
					const reopen = timed(() => v.srvTogglePanel());
					for (let i = 0; i < 4; i++) { v.srvClosePanel(); v._srvFilter = ''; v.srvTogglePanel(); }
					await new Promise(resolve => setTimeout(resolve, 5));
					if (window.gc) window.gc();
					if (sample >= 0) {
						times.index.push(index); times.open.push(open); times.filter.push(filter); times.reopen.push(reopen);
						counts.push({ open: openNodes, filter: filterNodes, reopen: v.srvPanel.querySelectorAll('*').length });
						rowCounts.push({ open: openRows, filter: filterRows, reopen: v.srvPanel.querySelectorAll('.nv-pool-row:not(.nv-srv-quick)').length });
						heaps.push(performance.memory ? performance.memory.usedJSHeapSize : null);
					}
					v.srvClosePanel();
				}
				return { size, viewport, median_ms: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, +med(v).toFixed(2)])),
					dom_elements: counts[0], relay_rows: rowCounts[0], retained_js_heap_bytes: heaps[0] == null ? null : med(heaps), samples: times };
			}, size, viewport));
		}
	}
	const interactions = await evaluate(async function() {
		if (!window.app.srvBuildIndex) return 'Baseline: bounded picker interactions unavailable';
		function check(ok, message) { if (!ok) throw Error(message); }
		document.body.replaceChildren();
		const relays = Array.from({ length: 125 }, (_, i) => ({ hostname: 'host' + i, name: 'Server #' + i,
			country_code: 'de', city: 'Berlin', load: 10 }));
		const v = window.keyView = Object.assign({}, window.app, { _serverChosen: 'missing-pin', _srvFilter: '', _srvOpen: false,
			status: { gateway: 'host100' }, _ccNames: { de: 'Germany' }, srvPanel: dom.create('div', { class: 'nv-pool-panel hidden' }),
			srvTrigger: dom.create('button', {}), markConnectionDirty() {}, updateRotationAvailability() {} });
		document.body.append(v.srvTrigger, v.srvPanel);
		v.srvReplaceData(relays); v.srvTogglePanel();
		const filter = v._srvFilterEl;
		filter.value = 'Berlin'; filter.dispatchEvent(new Event('input')); filter.setSelectionRange(1, 4);
		v.srvReplaceData(relays);
		check(v._srvFilterEl === filter && document.activeElement === filter && filter.selectionStart === 1 && filter.selectionEnd === 4,
			'data refresh must preserve filter element, caret and focus');
		const unrelated = dom.create('input', {}); document.body.append(unrelated); unrelated.focus();
		v.srvReplaceData(relays); check(document.activeElement === unrelated, 'background acceptance must not steal focus');
		v.srvPanel.querySelector('.nv-srv-relay').focus(); const focusedHost = document.activeElement.getAttribute('data-server-key');
		v.srvReplaceData(relays); check(document.activeElement.getAttribute('data-server-key') === focusedHost, 'background refresh must retain focused relay');
		let renders = 0; const render = v.srvRenderList;
		v.srvRenderList = function(...args) { renders++; return render.apply(this, args); };
		filter.value = 'B'; filter.dispatchEvent(new Event('input')); filter.value = 'Berlin'; filter.dispatchEvent(new Event('input'));
		await new Promise(resolve => setTimeout(resolve, 150)); check(renders === 1, 'rapid typing must coalesce');
		renders = 0; filter.dispatchEvent(new Event('input')); v.srvClosePanel();
		await new Promise(resolve => setTimeout(resolve, 150)); check(renders === 0, 'closing must cancel work');
		v.srvTogglePanel(); renders = 0; v._srvFilterEl.dispatchEvent(new Event('input')); v.srvReplaceData(relays);
		await new Promise(resolve => setTimeout(resolve, 150)); check(renders === 1, 'data change must cancel old delayed work');
		const more = v.srvPanel.querySelector('.nv-srv-more'); more.focus(); more.click();
		check(v.srvPanel.querySelectorAll('.nv-srv-relay').length === 50, 'pagination must keep fifty relay rows');
		check(document.activeElement === v.srvPanel.querySelector('.nv-srv-relay'), 'paging must focus the first new row');
		check(v._serverChosen === 'missing-pin', 'render and pagination must preserve missing draft pin');
		check(v.srvPanel.textContent.includes('missing-pin') && v.srvPanel.textContent.includes('host100'), 'off-page indicators must remain visible');
		v.srvPanel.querySelector('.nv-srv-prev').click();
		v.srvPanel.querySelector('.nv-srv-relay').focus();
		return 'focus/caret, focused relay, background focus, debounce, cancellation, pagination and draft passed';
	});
	let keyboard = 'Baseline: mouse-only relay rows';
	if (await evaluate(() => !!window.keyView)) {
		await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
		await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
		await evaluate(() => {
			if (window.keyView._serverChosen !== 'host0' || window.keyView._srvOpen) throw Error('native Enter must select relay');
			window.keyView.srvTogglePanel(); window.keyView.srvPanel.querySelector('.nv-srv-quick').focus();
		});
		await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
		await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
		await evaluate(() => {
			if (window.keyView._serverChosen !== '' || window.keyView._srvOpen) throw Error('native Space must activate Automatic');
			window.keyView.srvTogglePanel();
		});
		await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
		await evaluate(() => { if (window.keyView._srvOpen || document.activeElement !== window.keyView.srvTrigger) throw Error('Escape must close and return focus'); });
		keyboard = 'native Enter, Space and Escape passed';
	}
	console.log(JSON.stringify({ interactions, keyboard, browser: version.product, repetitions: 7, warmup: 1,
		method: 'Actual overview methods; DOM + forced layout; synchronous filter render excludes debounce; exposed GC after five reopen cycles; whole-page JS heap', results }, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
	if (socket) socket.close(); browser.kill(); await pause(200); fs.rmSync(profile, { recursive: true, force: true });
});
