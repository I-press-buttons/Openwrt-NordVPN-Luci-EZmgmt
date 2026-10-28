'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require poll';
'require dom';

/* SPDX-License-Identifier: MIT
 * NordVPN WireGuard management view. Talks to the backend 'nordvpn' ubus object
 * (nordvpn-wireguard); performs no direct privileged filesystem or network ops.
 */

// LuCI's E() hands a bare string child to innerHTML. This view renders server,
// city and country names from the NordVPN API plus backend error text — none of
// it markup — so this local E() routes every string child through a text node.
// Same signatures as dom.create(): E(tag, attr, data) and E(tag, data).
// dom.content()/dom.append() calls below pass strings wrapped in an array for
// the same reason.
var E = function(html, attr, data) {
	if (!(attr instanceof Object) || Array.isArray(attr))
		data = attr, attr = null;
	if (data != null && typeof(data) !== 'function' && !Array.isArray(data) && !dom.elem(data))
		data = [ '' + data ];
	// {} rather than null: dom.create() would re-shuffle a null attr and drop data.
	return dom.create(html, attr || {}, data);
};

var callInstances = rpc.declare({ object: 'nordvpn', method: 'instances' });
var callLocations = rpc.declare({ object: 'nordvpn', method: 'locations' });
var callServers = rpc.declare({ object: 'nordvpn', method: 'servers', params: [ 'locations', 'hop_mode', 'server_group' ] });
var callUpdateStatus = rpc.declare({ object: 'nordvpn', method: 'update_status' });
var callUpdateStart = rpc.declare({ object: 'nordvpn', method: 'update_start', params: [ 'version' ] });
var callRefreshStatus = rpc.declare({ object: 'nordvpn', method: 'refresh_status', params: [ 'id' ] });
var callSetCredentials = rpc.declare({ object: 'nordvpn', method: 'set_credentials', params: [ 'token', 'instance', 'credential', 'name' ] });
var callCredentials = rpc.declare({ object: 'nordvpn', method: 'credentials' });
var callRemoveCredentials = rpc.declare({ object: 'nordvpn', method: 'remove_credentials', params: [ 'credential' ] });
// LuCI's uci.apply() arms a rollback (10s by default) and confirms it from a
// timer the returned promise does not wait for. We go on to call `apply`,
// which verifies a WireGuard handshake per candidate server at verify_timeout
// (8s) each — two silent candidates already exceed the window. rpcd is busy
// serving that call, the confirmation never lands, and the router restores the
// snapshot: the settings just saved are silently discarded while the routing
// objects the backend committed stay in place. Observed on the sibling
// protonvpn app, whose apply is slower and hit it every time.
//
// The protection was illusory anyway: what can lock an admin out is the
// routing and firewall state, which the backend commits itself, outside this
// transaction — rolling the settings file back would not restore access.
//
// Commit only this app's own config, though. `uci apply` without a rollback
// commits EVERY change staged in the session — pending network or firewall
// edits from other pages included — and those do need the rollback. rpcd's
// `commit` fires the same config-change reload trigger, for one package. It
// is refused while another session's rollback is pending; `reject` surfaces
// that as "Save failed" instead of reconnecting with the old settings.
var callUciCommit = rpc.declare({
	object: 'uci', method: 'commit', params: [ 'config' ], reject: true
});

// An apply rewrites the peer and then waits for a real WireGuard handshake per
// candidate server — verify_timeout (8 s by default) each, up to four
// candidates. Called synchronously it holds the single rpcd worker for that
// whole time, so every other LuCI page on the router stalls behind it. The page
// therefore starts the job and watches it; the synchronous `apply` stays in the
// backend for the CLI only.
var callApplyStart = rpc.declare({ object: 'nordvpn', method: 'apply_start', params: [ 'instance', 'source' ] });
var callApplyStatus = rpc.declare({ object: 'nordvpn', method: 'apply_status', params: [ 'id' ] });
// Routing-only apply: reconciles the steering/exception rules without touching
// the tunnel. Quick (no handshake wait), so it is a plain call.
var callApplyRouting = rpc.declare({ object: 'nordvpn', method: 'apply_routing', params: [ 'instance' ] });
var callRefreshLocations = rpc.declare({ object: 'nordvpn', method: 'refresh_locations' });
// A manual rotation tries up to max_retries servers at verify_timeout each, so
// it runs as a job exactly like an apply (see callApplyStart) and is watched
// through apply_status. `rotate_now` stays in the backend for the CLI only.
var callRotateStart = rpc.declare({ object: 'nordvpn', method: 'rotate_start', params: [ 'instance' ] });
var callExternalIpStatus = rpc.declare({ object: 'nordvpn', method: 'external_ip_status', params: [ 'instance', 'id' ] });
var callExternalIpStart = rpc.declare({ object: 'nordvpn', method: 'external_ip_start', params: [ 'instance' ] });
var callClients = rpc.declare({ object: 'nordvpn', method: 'clients' });
var callDisconnect = rpc.declare({ object: 'nordvpn', method: 'disconnect', params: [ 'instance' ] });
var callDisableAll = rpc.declare({ object: 'nordvpn', method: 'disable_all' });
var callCreateInstance = rpc.declare({ object: 'nordvpn', method: 'create_instance', params: [ 'instance', 'credential' ] });
var callDeleteInstance = rpc.declare({ object: 'nordvpn', method: 'delete_instance', params: [ 'instance' ] });
var callHistory = rpc.declare({ object: 'nordvpn', method: 'history', params: [ 'instance', 'limit' ] });

// Cadence of the apply watcher. The whole point of the asynchronous apply is to
// leave rpcd free, so the probe must stay rare compared to the work it watches;
// two seconds still shows the outcome as soon as it lands.
var APPLY_POLL_MS = 2000;
// Hard ceiling for that watch, derived from the backend's own worst case rather
// than picked round: apply_inner tries at most four candidates (the loop clamps
// `tries` to 4) and each one waits verify_timeout for a handshake, clamped to
// MAX_VERIFY_TIMEOUT = 30 s — 120 s of pure waiting. On top of that every
// candidate rewrites the peer and restarts the interface, and the failure path
// restores the previous peer and brings it up again, so allow the same again
// for that overhead. Anything past four minutes is a wedged job, not a slow
// one — say so instead of spinning forever.
var APPLY_TIMEOUT_MS = 240000;
// Cadence of the background status poll, kept in a constant because the apply
// watcher has to take that poller off the queue and put it back.
var STATUS_POLL_S = 5;
// Instance options a running tunnel can take without a reconnect: what is
// routed (devices, networks, domains, exceptions, kill switch, IPv6, DNS, the
// routing table) is plain firewall/rule config that the backend moves the
// tunnel onto in place, and rotation, watchdog, server order, the internet
// check and the cache location are read by the daemon or the next rotation.
// A save that changes only these adds or removes a device without dropping
// anyone's connections. The rest (server, location, hop mode, MTU,
// credentials, interface) goes through a full apply, which still keeps the
// connected server when it matches the new selection.
var NO_RECONNECT_OPTS = [
	'source_device', 'bypass_device', 'source_network', 'steer_domain', 'bypass_domain',
	'steer_ip', 'bypass_ip', 'routing_table',
	'auto_routing', 'killswitch', 'block_ipv6', 'vpn_masq', 'vpn_dns', 'use_vpn_dns', 'custom_dns',
	'rotation_enabled', 'rotation_mode', 'rotation_interval', 'rotation_time', 'selection',
	'watchdog', 'egress_probe', 'probe_target', 'verify_timeout', 'max_retries',
	'cache_dir', 'main.cache_dir', 'cache_refresh_interval'
];
// Values equivalent to an unset option, for comparing the form with the config.
var OPTION_DEFAULTS = { hop_mode: 'single', selection: 'balanced' };
// Events shown in the "Recent events" panel (the backend keeps up to 50).
var HISTORY_LIMIT = 25;
// A probe target: a dotted-quad IPv4 literal (the backend accepts nothing else).
var IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// One collator per view module, reused only when a server dataset changes.
// Older browsers without numeric collation use a deterministic natural order.
var srvCompareName = (function() {
	try {
		var collator = new Intl.Collator(undefined, { numeric: true });
		if (collator.compare('2', '10') < 0)
			return collator.compare;
	} catch (e) {}
	return function(a, b) {
		var aa = a.toLowerCase().match(/\d+|\D+/g) || [], bb = b.toLowerCase().match(/\d+|\D+/g) || [];
		for (var i = 0; i < Math.min(aa.length, bb.length); i++) {
			var x = aa[i], y = bb[i];
			if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
				x = x.replace(/^0+(?=\d)/, ''); y = y.replace(/^0+(?=\d)/, '');
				if (x.length !== y.length) return x.length - y.length;
			}
			if (x !== y) return x < y ? -1 : 1;
		}
		return aa.length - bb.length;
	};
})();
var SRV_PAGE_SIZE = 50;

var STYLE = '' +
	'.nv-status-main{display:flex;flex-wrap:wrap;align-items:baseline;gap:.75em;font-size:1.05em}' +
	'.nv-state{font-weight:700}' +
	'.nv-status-details{color:var(--text-color-medium,#666);font-size:.9em;margin-top:.3em}' +
	'.nv-status-actions{margin-top:.7em;display:flex;gap:.5em;flex-wrap:wrap}' +
	'.nv-mono{font-family:monospace}' +
	'.nv-inline-note{font-style:italic;color:var(--text-color-medium,#666)}' +
	'.nv-inline{display:flex;align-items:center;gap:.75em;flex-wrap:wrap}' +
	'.nv-radio-group{display:flex;align-items:center;gap:1.25em;flex-wrap:wrap;min-height:1.9em}' +
	'.nv-radio-group label{display:inline-flex;align-items:center;gap:.4em;margin:0;font-weight:normal}' +
	'.nv-check{display:inline-flex;align-items:center;gap:.4em;font-weight:normal}' +
	'.nv-seg{display:inline-flex;flex-wrap:wrap;max-width:100%;border:1px solid #0069d6;border-radius:1.2em;overflow:hidden}' +
	'.nv-seg button{border:0;background:transparent;margin:0;padding:.3em 1.1em;cursor:pointer;font:inherit;color:inherit;line-height:1.3;white-space:nowrap;flex:1 1 auto}' +
	'.nv-seg button+button{border-left:1px solid #0069d6}' +
	'.nv-seg button.active{background:#0069d6;color:#fff}' +
	// Rotation pool chips: a country is filled (like the active segment), a
	// Location chips: one filled pill per country, with borderless edit/remove
	// buttons inside. A stale code (no longer in the server list) is dashed.
	'.nv-pool{display:flex;flex-direction:column;align-items:flex-start;gap:.4em;margin-top:.45em}' +
	'.nv-chip{display:inline-flex;align-items:center;gap:.35em;border:1px solid #0069d6;border-radius:1.2em;padding:.15em .55em;line-height:1.4;white-space:nowrap}' +
	'.nv-chip-country{background:#0069d6;color:#fff}' +
	'.nv-chip-click{cursor:pointer}' +
	'.nv-chip-stale{border-style:dashed;color:var(--text-color-medium,#666)}' +
	'.nv-chip button{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 .1em;margin:0;font:inherit;font-weight:700;line-height:1}' +
	'.nv-pool-count{color:var(--text-color-medium,#666);font-size:.9em}' +
	// Custom location picker: the trigger opens an inline panel that walks
	// countries -> cities (checkbox narrowing) in place. The trigger hides
	// while the panel is open, so there is no duplicate "add" affordance.
	'.nv-pool-wrap{display:block;margin-top:.5em}' +
	'.nv-pool-trigger::after{content:" \\25be"}' +
	'.nv-pool-panel{display:block;margin-top:.35em;width:320px;max-width:100%;max-height:340px;overflow:auto;background:var(--background-color-high,#fff);color:var(--text-color-high,inherit);border:1px solid var(--border-color-medium,#ccc);border-radius:.4em;box-shadow:0 4px 14px rgba(0,0,0,.18);padding:.25em}' +
	'.nv-pool-panel.hidden{display:none}' +
	'.nv-pool-head{display:flex;align-items:center;justify-content:space-between;gap:.5em;padding:.1em .3em .3em;font-weight:600}' +
	'.nv-pool-x{border:0;background:transparent;cursor:pointer;font:inherit;font-weight:700;color:inherit;padding:0 .2em}' +
	'.nv-pool-filter{width:100%;box-sizing:border-box;margin:0 0 .3em 0}' +
	'.nv-pool-row{display:flex;align-items:center;gap:.55em;padding:.34em .5em;border-radius:.3em;cursor:pointer;white-space:nowrap}' +
	'.nv-pool-row:hover{background:rgba(0,105,214,.14)}' +
	'.nv-pool-row.is-in{opacity:.55}' +
	'.nv-pool-row .grow{flex:1;overflow:hidden;text-overflow:ellipsis}' +
	'.nv-pool-row .chev{color:var(--text-color-medium,#888);font-weight:700}' +
	'.nv-pool-row .box{font-weight:700;width:1.15em;text-align:center;flex:none}' +
	'.nv-pool-back{font-weight:600}' +
	'.nv-pool-remove{color:#c0392b;font-weight:600}' +
	'.nv-pool-remove:hover{background:rgba(192,57,43,.12)}' +
	'.nv-pool-sep{border-top:1px solid var(--border-color-medium,#ddd);margin:.25em 0}' +
	'.nv-pool-label{padding:.2em .5em;font-size:.85em;font-weight:600;color:var(--text-color-medium,#666)}' +
	'.nv-chip-add{font-weight:700;padding:0 .15em}' +
	// Server picker: same panel, plus a load dot (green/amber/red), a group
	// header per country and quick "Automatic / Lowest load" rows at the top.
	'.nv-srv-trigger{max-width:100%;overflow:hidden;text-overflow:ellipsis;text-align:left}' +
	'.nv-srv-x{border:0;background:transparent;cursor:pointer;font:inherit;font-weight:700;color:inherit;padding:0 .2em;margin-left:.3em}' +
	'.nv-dot{display:inline-block;width:.7em;height:.7em;border-radius:50%;flex:none}' +
	// Per-device steering picker: collapsed by default, scrollable list.
	'details.nv-devices>summary{cursor:pointer;padding:.2em 0}' +
	'.nv-dev-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.5em;margin:.45em 0}' +
	'.nv-dev-tools .nv-dev-search{flex:1 1 14em;min-width:10em;width:auto}' +
	'.nv-dev-list{max-height:22em;overflow-y:auto;border:1px solid var(--border-color-medium,#ccc);border-radius:.3em}' +
	'.nv-dev-row{display:flex;align-items:center;gap:.6em;padding:.38em .6em;cursor:pointer;border-bottom:1px solid var(--border-color-low,rgba(0,0,0,.08))}' +
	'.nv-dev-row:last-child{border-bottom:none}' +
	'.nv-dev-row:hover{background:rgba(0,105,214,.08)}' +
	'.nv-dev-row:focus-visible{outline:2px solid rgba(0,105,214,.6);outline-offset:-2px}' +
	'.nv-dev-row.nv-dev-on{background:rgba(45,143,78,.16);box-shadow:inset 3px 0 0 #2d8f4e}' +
	'.nv-dev-row.nv-dev-locked{opacity:.5;cursor:not-allowed}' +
	'.nv-dev-row .box{font-weight:700;width:1.15em;text-align:center;flex:none}' +
	'.nv-dev-info{display:flex;flex-wrap:wrap;gap:.1em .8em;min-width:0;flex:1}' +
	'.nv-dev-name{font-weight:600}' +
	'.nv-dev-meta{color:var(--text-color-medium,#666);font-size:.9em;overflow-wrap:anywhere}' +
	'.nv-dev-online{background:#3c8c3c}' +
	'.nv-dev-offline{background:var(--border-color-medium,#bbb)}' +
	'.nv-dev-empty{padding:.6em;color:var(--text-color-medium,#666)}' +
	'.nv-disable-all{display:flex;align-items:center;gap:.7em;flex-wrap:wrap;margin-top:.8em;padding:.6em;border:1px solid var(--error-color,#c0392b);border-radius:.3em}' +
	'.nv-disable-all .cbi-value-description{color:var(--error-color,#c0392b);font-weight:600}' +
	'.nv-dot-lo{background:#3c8c3c}' +
	'.nv-dot-mid{background:#c79100}' +
	'.nv-dot-hi{background:#c0392b}' +
	'.nv-srv-load{color:var(--text-color-medium,#888);font-variant-numeric:tabular-nums;flex:none}' +
	'.nv-srv-cur{color:#3c8c3c;font-weight:600;flex:none}' +
	'.nv-srv-tag{flex:none;font-size:.8em;padding:0 .4em;border:1px solid currentColor;border-radius:3px;color:var(--text-color-medium,#888)}' +
	'.nv-srv-grp{font-weight:600;padding:.35em .5em .15em;color:var(--text-color-medium,#888)}' +
	'.nv-pool-row.nv-srv-quick{font-weight:600}' +
	'.nv-srv-action{border:0;background:transparent;font:inherit;color:inherit;text-align:left;width:100%}' +
	'.nv-srv-summary{padding:.3em .5em;overflow-wrap:anywhere}' +
	// Plain flex rows (no LuCI .table classes), so the theme's own responsive
	// table stacking can never apply; wraps naturally down to ~340 px.
	'.nv-inst-row{display:flex;align-items:center;gap:.8em;padding:.55em 0;border-bottom:1px solid var(--border-color-medium,#ccc);cursor:pointer}' +
	'.nv-inst-row:last-child{border-bottom:none}' +
	'.nv-inst-info{display:flex;flex-wrap:wrap;align-items:center;gap:.25em .8em;flex:1;min-width:0}' +
	'.nv-inst-name{font-weight:bold}' +
	'.nv-inst-dim{color:var(--text-color-medium,#666);font-size:.92em}' +
	'.nv-inst-act{flex:none;margin-left:auto}' +
	'.nv-token-field>div{display:block;width:100%}' +
	'.nv-token-field .control-group{display:flex;width:100%}' +
	'.nv-token-field .control-group input{flex:1 1 auto;width:100%}' +
	'details.nv-advanced>summary{cursor:pointer;font-weight:700;padding:.3em 0}' +
	// Recent events: flex rows like the instance list, time column first.
	'.nv-hist-row{display:flex;flex-wrap:wrap;gap:.2em .9em;padding:.35em 0;border-bottom:1px solid var(--border-color-medium,#ddd)}' +
	'.nv-hist-row:last-child{border-bottom:none}' +
	'.nv-hist-time{flex:none;min-width:10.5em;color:var(--text-color-medium,#666);font-variant-numeric:tabular-nums}' +
	'.nv-hist-what{flex:1 1 14em;min-width:0;overflow-wrap:anywhere}' +
	'.nv-hist-detail{color:var(--text-color-medium,#666);font-size:.92em}' +
	'.hidden{display:none!important}';

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load: function() {
		return Promise.all([
			uci.load('nordvpn'),
			callInstances().catch(function() { return { instances: [] }; }),
			callLocations().catch(function() { return { available: false }; }),
			callRefreshStatus().catch(function() { return { state: 'idle' }; }),
			callCredentials().catch(function() { return { credentials: [] }; })
		]);
	},

	render: function(data) {
		this.instances = (data[1] && data[1].instances) || [];
		this.instance = this.instances.length ? this.instances[0].instance : 'main';
		this.status = this.instances[0] || {};
		this.locations = data[2] || { available: false };
		this.credentials = (data[4] && data[4].credentials) || [];
		this.dirty = false;
		this._otherDirty = false;
		this._connectionState = null;
		this.refs = {};

		this.instancesNode = E('div');
		this.statusNode = E('div');
		this.historyNode = this.buildHistory();
		this.credNode = E('div');
		this.formNode = E('div');
		this.xferSamples = {};
		this.xferRates = {};
		this.trackTransfer(this.instances);
		this.updateInstancesTable();
		this.updateStatusBand();
		dom.content(this.formNode, this.buildFormSections());

		var container = E('div', {}, [
			E('style', {}, STYLE),
			E('h2', {}, _('NordVPN')),
			this.credNode,
			this.instancesNode,
			this.statusNode,
			this.historyNode,
			this.formNode,
			this.buildActions(),
			this.buildUpdater(),
			E('p', { style: 'margin-top:1.5em;text-align:center' }, [
				E('a', {
					href: 'https://github.com/I-press-buttons/Openwrt-NordVPN-Luci-EZmgmt/blob/master/docs/OPTIONS.md',
					target: '_blank',
					rel: 'noopener noreferrer'
				}, _('What do these options do? Read the options guide.'))
			])
		]);

		// The bound function is kept in a field because poll.remove() matches on
		// identity, and an apply takes this poller off the queue for its duration.
		this._applyRuns = 0;
		this._statusPoll = L.bind(this.refreshStatus, this);
		poll.add(this._statusPoll, STATUS_POLL_S);
		return container;
	},

	buildUpdater: function() {
		var select = E('select', { class: 'cbi-input-select' }, [
			E('option', { value: 'latest' }, _('Latest release')),
			E('option', { value: 'custom' }, _('Specific version'))
		]);
		var input = E('input', { type: 'text', class: 'cbi-input-text', placeholder: '1.8.0 or v1.8.0-r20261015', style: 'display:none' });
		select.addEventListener('change', function() { input.style.display = select.value === 'custom' ? '' : 'none'; });
		this.updateMessage = E('p', {}, _('Loading update status…'));
		this.updateButton = E('button', { class: 'cbi-button cbi-button-action', click: L.bind(function() {
			if (this.dirty) {
				ui.addNotification(null, E('p', {}, _('Save or discard your pending changes before updating.')), 'warning');
				return;
			}
			var version = select.value === 'latest' ? 'latest' : input.value.trim();
			if (!version || (version !== 'latest' && !/^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$/.test(version))) {
				ui.addNotification(null, E('p', {}, _('Enter a valid release version or tag.')), 'error');
				return;
			}
			this.updateButton.disabled = true;
			return callUpdateStart(version).then(L.bind(function(res) {
				if (!res || res.error) throw new Error((res && res.error) || _('Could not start update.'));
				return this.refreshUpdateStatus();
			}, this)).catch(L.bind(function(err) {
				this.updateButton.disabled = false;
				ui.addNotification(null, E('p', {}, err.message), 'error');
			}, this));
		}, this) }, _('Update packages'));
		this.refreshUpdateStatus();
		poll.add(L.bind(this.refreshUpdateStatus, this), STATUS_POLL_S);
		return E('fieldset', { class: 'cbi-section' }, [
			E('legend', {}, _('Package updates')),
			E('p', {}, _('Update both NordVPN packages from GitHub. Specific versions can also downgrade. LuCI services restart after installation; reload this page when complete.')),
			this.updateMessage, select, ' ', input, ' ', this.updateButton,
			E('button', { class: 'cbi-button', click: function() { window.location.reload(); } }, _('Reload page'))
		]);
	},

	refreshUpdateStatus: function() {
		return callUpdateStatus().then(L.bind(function(res) {
			if (!res || !res.state) throw new Error(_('Update status unavailable.'));
			this.updateButton.disabled = res.state === 'running';
			var message = _('Installed backend: ') + (res.installed || '?') + '. ';
			if (res.state === 'running') message += res.message || _('Updating…');
			else if (res.state === 'success') message += _('Installed release: ') + res.version + '. ' + _('Update complete. Reload this page.');
			else if (res.state === 'error') message += (res.error || _('Update failed.')) + (res.output ? '\n' + res.output : '');
			dom.content(this.updateMessage, [ message ]);
		}, this)).catch(L.bind(function() {
			dom.content(this.updateMessage, [ _('Update status unavailable. If an update is running, wait for LuCI services to restart, then reload this page.') ]);
		}, this));
	},

	/* ---- instances ----------------------------------------------------- */

	statusOf: function(name) {
		var found = null;
		(this.instances || []).forEach(function(st) {
			if (st.instance === name)
				found = st;
		});
		return found;
	},

	updateInstancesTable: function() {
		var rows = [];

		(this.instances || []).forEach(L.bind(function(st) {
			var info = this.stateInfo(this.dispState(st));
			var loc = st.location || {};
			var flag = this.countryFlag(loc.country);
			var selected = (st.instance === this.instance);
			var r = st.rotation || {};
			var next = '';
			if (r.enabled && r.next_run)
				next = new Date(r.next_run * 1000).toLocaleTimeString();
			else if (r.enabled)
				next = _('on schedule');

			rows.push(E('div', {
				class: 'nv-inst-row',
				click: L.bind(this.selectInstance, this, st.instance)
			}, [
				E('div', { class: 'nv-inst-info' }, [
					E('span', { class: 'nv-inst-name' }, (selected ? '▸ ' : '') + st.instance),
					E('span', { style: 'color:' + info.color }, info.label),
					E('span', {}, (flag ? flag + ' ' : '') + (st.gateway || '—')),
					next ? E('span', { class: 'nv-inst-dim' }, '⟳ ' + next) : ''
				]),
				E('span', { class: 'nv-inst-act' }, E('button', {
					class: 'cbi-button cbi-button-remove',
					click: L.bind(this.showDeleteInstanceModal, this, st.instance)
				}, st.instance === 'main' ? _('Reset') : _('Delete')))
			]));
		}, this));

		dom.content(this.instancesNode, E('fieldset', { class: 'cbi-section' }, [
			E('legend', {}, _('VPN instances')),
			E('div', { class: 'cbi-section-node' }, [
				E('div', {}, rows),
				E('div', { class: 'nv-disable-all' }, [
					E('div', { class: 'cbi-value-description' }, _('Warning: disabling all VPNs removes their kill switches. LAN traffic will route to the WAN.')),
					E('button', { class: 'cbi-button cbi-button-negative', click: L.bind(this.disableAll, this) }, _('Disable all VPNs'))
				]),
				E('div', { style: 'margin-top:.6em' }, [
					E('button', { class: 'cbi-button cbi-button-add', click: L.bind(this.showAddInstanceModal, this) },
						_('Add instance'))
				])
			])
		]));
	},

	selectInstance: function(name) {
		if (name === this.instance)
			return;
		if (this.dirty && !window.confirm(_('Discard unsaved changes?')))
			return;
		this.instance = name;
		this._connectionState = null;
		this._otherDirty = false;
		this.dirty = false;
		if (this.saveBtn) this.saveBtn.disabled = true;
		if (this.discardBtn) this.discardBtn.disabled = true;
		this.status = this.statusOf(name) || {};
		this.updateInstancesTable();
		this.updateStatusBand();
		this.refreshHistory(true);
		dom.content(this.formNode, this.buildFormSections());
	},

	showAddInstanceModal: function() {
		var input = E('input', { type: 'text', class: 'cbi-input-text', placeholder: _('e.g. media') });
		var err = E('div', { class: 'cbi-value-description', style: 'color:var(--error-color,#c0392b)' });
		// New instances use the Default credentials; offer the others only when
		// the bank has more than one entry.
		var creds = this.credentials || [];
		var credSel = (creds.length > 1) ? this.credentialSelect('default') : null;

		ui.showModal(_('Add VPN instance'), [
			E('p', {}, _('A new instance runs its own tunnel on its own WireGuard interface with its own schedule.')),
			E('div', { class: 'cbi-value' }, [ input ]),
			credSel ? E('div', { class: 'cbi-value' }, [ E('label', { class: 'nv-check' }, [ _('Credentials'), credSel ]) ]) : '',
			err,
			E('div', { class: 'right' }, [
				E('button', { class: 'cbi-button', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', { class: 'cbi-button cbi-button-action', click: L.bind(this.addInstance, this, input, credSel, err) }, _('Add'))
			])
		]);
	},

	addInstance: function(input, credSel, err) {
		var name = (input.value || '').trim();
		if (!/^[A-Za-z0-9_]{1,12}$/.test(name)) {
			dom.content(err, _('Use 1-12 letters, digits or underscores.'));
			return;
		}
		return callCreateInstance(name, credSel ? credSel.value : '').then(L.bind(function(res) {
			if (res && res.error) {
				dom.content(err, [ res.error ]);
				return;
			}
			ui.hideModal();
			uci.unload('nordvpn');
			return uci.load('nordvpn').then(L.bind(function() {
				return this.refreshCredentials();
			}, this)).then(L.bind(function() {
				return this.refreshStatus();
			}, this)).then(L.bind(function() {
				this.selectInstance(name);
				this.notice((res && res.configured)
					? _('Instance "%s" created with the "%s" credentials. Pick a country, then save.').format(name, this.credentialName(res.credential))
					: _('Instance "%s" created. Add credentials and pick a country, then save.').format(name), 'info', 6000);
			}, this));
		}, this)).catch(L.bind(function(e) {
			dom.content(err, [ '' + e ]);
		}, this));
	},

	showDeleteInstanceModal: function(name, ev) {
		if (ev)
			ev.stopPropagation();
		var main = (name === 'main');
		ui.showModal(main ? _('Reset "main" to defaults?') : _('Delete instance "%s"?').format(name), [
			E('p', {}, main
				? _('The tunnel is taken down, its interface and firewall objects are removed, and every setting of this instance returns to its default. The credentials stay in the bank, and other instances are not affected.')
				: _('The tunnel is taken down and its interface, firewall objects and settings are removed. LAN traffic routed through it will fall back to your other routes.')),
			E('div', { class: 'right' }, [
				E('button', { class: 'cbi-button', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', { class: 'cbi-button cbi-button-negative', click: L.bind(this.deleteInstance, this, name) },
					main ? _('Reset') : _('Delete'))
			])
		]);
	},

	deleteInstance: function(name) {
		ui.hideModal();
		var n = this.notice(_('Deleting instance "%s"…').format(name), 'info');
		return callDeleteInstance(name).then(L.bind(function(res) {
			res = this.operationResult(res, name);
			this.dismiss(n);
			if (res && res.error) {
				this.notice(_('Delete failed: %s').format(res.error), 'error');
				return;
			}
			this.notice(res && res.reset
				? _('Instance "main" reset to defaults.')
				: _('Instance "%s" deleted.').format(name), 'info', 4000);
			uci.unload('nordvpn');
			return uci.load('nordvpn').then(L.bind(function() {
				if (this.instance === name) {
					this.instance = 'main';
					this._connectionState = null;
					this._otherDirty = false;
					this.dirty = false;
				}
				return this.refreshStatus().then(L.bind(function() {
					this.status = this.statusOf(this.instance) || {};
					this.updateStatusBand();
					if (!this.dirty && !this._saving)
						dom.content(this.formNode, this.buildFormSections());
				}, this));
			}, this));
		}, this)).catch(L.bind(function(e) {
			this.dismiss(n);
			this.notice(_('Delete failed: %s').format(e), 'error');
		}, this));
	},

	/* ---- runtime status band ------------------------------------------ */

	stateInfo: function(state) {
		var map = {
			connected:      { label: _('Connected'),      color: 'var(--success-color,#2d8f4e)' },
			connecting:     { label: _('Connecting'),     color: 'var(--warning-color,#b8860b)' },
			degraded:       { label: _('Degraded'),       color: 'var(--warning-color,#b8860b)' },
			no_egress:      { label: _('No internet'),    color: 'var(--warning-color,#b8860b)' },
			disconnected:   { label: _('Disconnected'),   color: 'var(--error-color,#c0392b)' },
			disabled:       { label: _('Disabled'),       color: 'var(--text-color-medium,#666)' },
			error:          { label: _('Error'),          color: 'var(--error-color,#c0392b)' },
			not_configured: { label: _('Not configured'), color: 'var(--text-color-medium,#666)' }
		};
		return map[state] || { label: _('Unknown'), color: 'var(--text-color-medium,#666)' };
	},

	// Runtime state to display: an administratively disabled but configured
	// instance reads as "Disabled" (deliberate), not "Disconnected" (a fault).
	dispState: function(s) {
		if (s && s.configured && s.enabled === false)
			return 'disabled';
		return (s && s.state) || 'not_configured';
	},

	fmtHandshake: function(sec) {
		if (sec == null)
			return null;
		if (sec < 90)
			return _('Handshake %d seconds ago').format(sec);
		return _('Handshake %d minutes ago').format(Math.floor(sec / 60));
	},

	// Compact duration: "45 s", "12 min", "3 h 5 min", "2 d 4 h".
	fmtDuration: function(sec) {
		sec = Math.max(0, Math.floor(sec));
		if (sec < 60)
			return _('%d s').format(sec);
		if (sec < 3600)
			return _('%d min').format(Math.floor(sec / 60));
		if (sec < 86400)
			return _('%d h %d min').format(Math.floor(sec / 3600), Math.floor(sec % 3600 / 60));
		return _('%d d %d h').format(Math.floor(sec / 86400), Math.floor(sec % 86400 / 3600));
	},

	fmtBytes: function(n) {
		var units = [ 'B', 'KB', 'MB', 'GB', 'TB' ];
		var i = 0;
		n = Math.max(0, n || 0);
		while (n >= 1024 && i < units.length - 1) {
			n /= 1024;
			i++;
		}
		return (i ? n.toFixed(n < 10 ? 1 : 0) : '' + n) + ' ' + units[i];
	},

	// Remember each instance's byte counters between polls and derive a rate
	// from consecutive samples. A new server, a restarted interface (counters
	// went backwards) or a long gap starts over instead of showing nonsense.
	trackTransfer: function(list) {
		var now = Date.now();
		(list || []).forEach(L.bind(function(st) {
			var x = st.transfer;
			var name = st.instance;
			if (!x) {
				delete this.xferSamples[name];
				delete this.xferRates[name];
				return;
			}
			var prev = this.xferSamples[name];
			var dt = prev ? (now - prev.t) / 1000 : 0;
			if (prev && prev.gw === st.gateway && dt >= 1 && dt <= 60 &&
			    x.rx_bytes >= prev.rx && x.tx_bytes >= prev.tx)
				this.xferRates[name] = {
					rx: (x.rx_bytes - prev.rx) / dt,
					tx: (x.tx_bytes - prev.tx) / dt
				};
			else if (!prev || prev.gw !== st.gateway || dt > 60)
				delete this.xferRates[name];
			this.xferSamples[name] = { t: now, gw: st.gateway, rx: x.rx_bytes, tx: x.tx_bytes };
		}, this));
	},

	// Resolve a country code and a city slug to display names from the loaded
	// locations tree, falling back to the raw codes when the list is missing.
	locationNames: function(cc, citySlug) {
		var l = this.locations || {};
		var countries = Array.isArray(l.countries) ? l.countries : [];
		var country = cc, city = citySlug;
		countries.forEach(function(c) {
			if (c.code !== cc)
				return;
			country = c.name || cc;
			(c.cities || []).forEach(function(ct) {
				if (ct.code === citySlug)
					city = ct.name || citySlug;
			});
		});
		return [ country, city ];
	},

	// Action buttons for the status band, chosen by state so structurally
	// inapplicable actions are hidden (not greyed): only Refresh until
	// configured, a single Enable/Disable toggle by administrative state, and
	// "Rotate now" only for a live, non-pinned tunnel (greyed while not live).
	actionButtons: function(s) {
		var btns = [ E('button', { class: 'cbi-button', click: L.bind(this.refreshStatus, this) }, _('Refresh')) ];

		if (!s.configured)
			return btns;

		if (s.enabled === false) {
			btns.push(E('button', {
				class: 'cbi-button cbi-button-apply',
				click: L.bind(this.reconnect, this, 'enable')
			}, _('Enable')));
			return btns;
		}

		btns.push(E('button', {
			class: 'cbi-button cbi-button-apply',
			click: L.bind(this.reconnect, this, 'reconnect')
		}, _('Reconnect')));

		if (!s.fixed) {
			var live = (s.state === 'connected' || s.state === 'degraded' || s.state === 'no_egress');
			btns.push(E('button', {
				class: 'cbi-button',
				disabled: !live || null,
				click: L.bind(this.rotateNow, this)
			}, _('Rotate now')));
		}

		btns.push(E('button', {
			class: 'cbi-button cbi-button-remove',
			click: L.bind(this.disconnect, this)
		}, _('Disable')));

		return btns;
	},

	updateStatusBand: function() {
		var s = this.status || {};
		var loc = s.location || {};
		var info = this.stateInfo(this.dispState(s));

		var locText = this.locationNames(loc.country, loc.city).filter(Boolean).join(' / ');
		if (s.gateway)
			locText = locText ? (locText + ' / ' + s.gateway) : s.gateway;
		var flag = this.countryFlag(loc.country);
		if (flag && locText)
			locText = flag + ' ' + locText;

		var details = [];
		var hs = this.fmtHandshake(s.latest_handshake_seconds);
		if (hs)
			details.push(hs);
		if (s.endpoint)
			details.push(_('Endpoint: %s').format(s.endpoint));
		if (s.uptime != null && s.state !== 'disconnected')
			details.push(_('Up %s').format(this.fmtDuration(s.uptime)));
		if (s.transfer) {
			var xfer = _('Traffic ↓ %s ↑ %s').format(this.fmtBytes(s.transfer.rx_bytes), this.fmtBytes(s.transfer.tx_bytes));
			var rate = this.xferRates && this.xferRates[this.instance];
			if (rate && (rate.rx >= 1 || rate.tx >= 1))
				xfer += ' ' + _('(↓ %s/s ↑ %s/s)').format(this.fmtBytes(rate.rx), this.fmtBytes(rate.tx));
			details.push(xfer);
		}
		var eg = s.egress || {};
		if (eg.enabled && s.configured && s.enabled !== false) {
			if (eg.ok === true)
				details.push(_('Internet check OK'));
			else if (eg.ok === false)
				details.push(_('Internet check failed %d times in a row').format(eg.fails || 0));
			else if (s.state === 'connected')
				details.push(_('Internet check pending'));
		}
		if (s.gateway && /^[a-z]{2}-onion/.test(s.gateway))
			details.push(_('🧅 Onion over VPN'));
		if (this.routingUnconfirmed(s))
			details.push(_('Routing protection is unconfirmed. Retry Apply and check any reported errors.'));
		else if (s.state !== 'connected' && s.state !== 'no_egress' && s.routing && s.routing.killswitch)
			details.push(_('Kill switch is blocking LAN traffic'));
		var protLine = null;
		if (s.state === 'connected') {
			var ipKey = this.externalIpKey();
			protLine = this.externalIpLine(ipKey);
			this.maybeFetchExternalIp(ipKey);
		}
		if (s.rotation && s.rotation.enabled)
			details.push(_('Automatic rotation is on'));

		var legend = _('VPN status');
		if ((this.instances || []).length > 1)
			legend += ' — ' + this.instance;
		dom.content(this.statusNode, E('fieldset', { class: 'cbi-section' }, [
			E('legend', {}, legend),
			E('div', { class: 'cbi-section-node' }, [
				E('div', { 'aria-live': 'polite' }, [
					E('div', { class: 'nv-status-main' }, [
						E('span', { class: 'nv-state', style: 'color:' + info.color }, info.label),
						E('span', {}, locText || '')
					]),
					E('div', { class: 'nv-status-details' }, details.join(' · ')),
					protLine,
					this.dnsLine(s),
					E('div', { class: 'nv-status-actions' }, this.actionButtons(s))
				])
			])
		]));
	},

	externalIpKey: function() {
		return this.instance + '|' + ((this.status || {}).probe_generation || '');
	},

	// A pending, expired or failed observation never retains protected styling.
	externalIpLine: function(key) {
		var observation = this.extIp && this.extIp.key === key ? this.extIp.observation : null;
		var state = observation ? observation.state : 'pending';
		if (state === 'fresh' && Date.now() < this.extIp.expires)
			return this.protectionLine(observation.result);
		if (state === 'fresh') state = 'stale';
		var text = state === 'failed' ? _('Protection check failed: %s').format(observation.error || _('unknown error')) :
			(state === 'pending' ? _('Protection check pending') : _('Protection check is stale'));
		return E('div', { class: 'nv-status-details' }, text);
	},

	// Only local cache/status and launch RPCs. Normal status polling drives
	// exact-ID probe polling independently; no remote timeout holds rpcd or UI.
	maybeFetchExternalIp: function(key) {
		var instance = this.instance, form = this._formGeneration, now = Date.now();
		if (this._extIpPending && this._extIpPending.key === key && this._extIpPending.form === form)
			return this._extIpPending.promise;
		if (this._extIpLastCheck && this._extIpLastCheck.key === key && now - this._extIpLastCheck.at < 4000)
			return Promise.resolve();
		var request = { key: key, form: form }, self = this;
		this._extIpPending = request;
		this._extIpLastCheck = { key: key, at: now };
		function current() {
			return self._extIpPending === request && instance === self.instance && form === self._formGeneration &&
				key === self.externalIpKey() && (self.status || {}).state === 'connected';
		}
		function accept(res) {
			if (!current()) return false;
			if (res && res.generation && res.generation !== (self.status || {}).probe_generation) {
				self.extIp = { key: key, observation: { state: 'stale' } };
				return false;
			}
			res = res || { state: 'failed', error: _('Protection check unavailable') };
			self.extIp = { key: key, observation: res, expires: Date.now() + Math.max(0, res.ttl_seconds || 0) * 1000 };
			return true;
		}
		var previous = this.extIp && this.extIp.key === key ? this.extIp.observation : null;
		var id = previous && previous.state === 'pending' ? previous.id : null;
		request.promise = callExternalIpStatus(instance, id).then(function(res) {
			if (id && (!res || res.id !== id)) {
				accept({ state: 'failed', error: _('Protection check returned another job') });
				return;
			}
			if (!accept(res)) return;
			var writable = !L.hasViewPermission || L.hasViewPermission();
			if (writable && (!self._extIpRetryAt || Date.now() >= self._extIpRetryAt) &&
				(res.state === 'stale' || res.state === 'missing' || (res.state === 'failed' && !res.retry_after_seconds)))
				return callExternalIpStart(instance).then(function(started) { accept(started); });
		}).catch(function(error) {
			if (!current()) return;
			self._extIpRetryAt = Date.now() + 30000;
			accept({ state: 'failed', error: String(error) });
		}).then(function() {
			if (!current()) return;
			self._extIpPending = null;
			self.updateStatusBand();
		});
		return request.promise;
	},

	// NordVPN's own verdict on the tunnel's exit (and, with "Route all LAN
	// traffic", on the path LAN traffic takes), or null before an answer.
	protectionLine: function(r) {
		if (!r)
			return null;
		var good = 'color:var(--success-color,#2d8f4e);font-weight:600';
		var bad = 'color:var(--error-color,#c0392b);font-weight:600';
		var kids = [];
		if (r.protected === true)
			kids.push(E('span', { style: good }, _('🛡 Protected by NordVPN')));
		else if (r.protected === false)
			kids.push(E('span', { style: bad }, _('⚠ NordVPN does not see this exit as one of its servers')));
		var info = [
			[ r.city, r.country ].filter(Boolean).join(', '),
			r.ip ? _('Public IP: %s').format(r.ip) : '',
			r.isp || ''
		].filter(Boolean).join(' · ');
		if (info)
			kids.push((kids.length ? ' · ' : '') + info);
		if (r.lan_path && r.lan_path.protected === false)
			kids.push(E('div', { style: bad },
				_('⚠ LAN traffic is not going through the VPN: NordVPN sees it coming from %s.')
					.format(r.lan_path.isp || r.lan_path.ip || _('your normal connection'))));
		return kids.length ? E('div', { class: 'nv-status-details' }, kids) : null;
	},

	// Which resolver clients use while this instance routes traffic: NordVPN's
	// (through the tunnel), or the router's upstream, usually the ISP's, which
	// sees every name looked up. Only shown while the tunnel carries traffic.
	dnsLine: function(s) {
		if (this.routingUnconfirmed(s))
			return E('div', { class: 'nv-status-details', style: 'color:var(--warning-color,#b8860b)' },
				_('DNS policy is unconfirmed. Retry Apply and check any reported errors.'));
		var rt = s.routing || {};
		if (s.enabled === false || (s.state !== 'connected' && s.state !== 'no_egress') ||
		    (rt.mode !== 'auto' && rt.mode !== 'steered'))
			return null;
		var mode = uci.get('nordvpn', this.instance, 'vpn_dns');
		if (mode !== 'off' && mode !== 'standard' && mode !== 'threat' && mode !== 'custom')
			mode = (uci.get('nordvpn', this.instance, 'use_vpn_dns') === '1') ? 'standard' : 'off';
		if (mode === 'custom')
			return E('div', { class: 'nv-status-details' }, _('DNS: your custom servers, through the tunnel'));
		if (mode === 'off')
			return E('div', { class: 'nv-status-details', style: 'color:var(--warning-color,#b8860b)' },
				_('DNS: the router\'s upstream resolver (usually your ISP), which can see every site looked up. Choose NordVPN DNS under Traffic routing to change that.'));
		return E('div', { class: 'nv-status-details' }, (mode === 'threat')
			? _('DNS: NordVPN Threat Protection, through the tunnel')
			: _('DNS: NordVPN, through the tunnel'));
	},

	/* ---- event history ---------------------------------------------- */

	// Built once: the status poll repaints the band every few seconds, and a
	// <details> inside it would snap shut on every repaint. The list is only
	// fetched while the panel is open.
	buildHistory: function() {
		this.histBody = E('div', {}, E('em', {}, _('Loading…')));
		this.histDetails = E('details', {
			class: 'nv-advanced cbi-section',
			toggle: L.bind(function() { this.refreshHistory(true); }, this)
		}, [
			E('summary', {}, _('Recent events')),
			E('div', { class: 'cbi-section-node' }, this.histBody)
		]);
		return this.histDetails;
	},

	// Fetch and render the selected instance's events when the panel is open.
	// `reset` shows the loading placeholder first (another instance selected),
	// so a slow answer never leaves the previous instance's events on screen.
	refreshHistory: function(reset) {
		if (!this.histDetails || !this.histDetails.open)
			return Promise.resolve();
		var inst = this.instance;
		if (reset)
			dom.content(this.histBody, E('em', {}, _('Loading…')));
		return callHistory(inst, HISTORY_LIMIT).then(L.bind(function(res) {
			if (inst !== this.instance)
				return;
			var events = (res && Array.isArray(res.events)) ? res.events : [];
			if (!events.length) {
				dom.content(this.histBody, E('em', {}, _('No events recorded since the router started.')));
				return;
			}
			dom.content(this.histBody, events.map(L.bind(function(ev) {
				var d = this.describeEvent(ev);
				var what = [ E('span', { style: d.color ? ('color:' + d.color) : null }, d.text) ];
				if (d.detail)
					what.push(E('span', { class: 'nv-hist-detail' }, ' — ' + d.detail));
				return E('div', { class: 'nv-hist-row' }, [
					E('span', { class: 'nv-hist-time' }, new Date(ev.ts * 1000).toLocaleString()),
					E('span', { class: 'nv-hist-what' }, what)
				]);
			}, this)));
		}, this)).catch(L.bind(function(e) {
			if (inst === this.instance)
				dom.content(this.histBody, E('em', {}, _('Could not load events: %s').format(e)));
		}, this));
	},

	// One history entry as { text, detail, color }. Backend errors and
	// details arrive in English, like every other backend error on this page.
	describeEvent: function(ev) {
		var ok = 'var(--success-color,#2d8f4e)';
		var warn = 'var(--warning-color,#b8860b)';
		var bad = 'var(--error-color,#c0392b)';
		var server = ev.server || '?';
		var why = {
			schedule: _('scheduled'),
			watchdog: _('watchdog'),
			manual: _('manual')
		}[ev.reason] || ev.reason || '';
		// What started an apply; entries recorded before this was tracked
		// carry none and keep their plain wording.
		var via = {
			reconnect: _('reconnect'),
			enable: _('enabled'),
			save: _('settings saved'),
			external: _('external')
		}[ev.reason] || ev.reason || '';
		var detail = [ ev.error, ev.detail ].filter(Boolean).join(' — ');
		switch (ev.type) {
		case 'connect':
			return { text: via
				? _('Connected to %s (%s)').format(server, via)
				: _('Connected to %s').format(server), color: ok };
		case 'connect_failed':
			return { text: via ? _('Connect failed (%s)').format(via) : _('Connect failed'),
				detail: detail, color: bad };
		case 'rotate':
			return { text: ev.from
				? _('Rotated (%s): %s → %s').format(why, ev.from, server)
				: _('Rotated (%s) to %s').format(why, server), color: ok };
		case 'rotate_failed':
			return { text: _('Rotation failed (%s)').format(why), detail: detail, color: bad };
		case 'rotate_skipped':
			return { text: _('Rotation skipped (%s)').format(why), detail: detail };
		case 'watchdog':
			return { text: _('Watchdog: %s, switching servers').format({
				connecting: _('stuck connecting'),
				degraded: _('handshake went stale'),
				disconnected: _('tunnel down'),
				no_egress: _('no internet through the tunnel')
			}[ev.reason] || ev.reason || '?'), detail: detail, color: warn };
		case 'egress_lost':
			return { text: _('No internet through %s').format(server), detail: detail, color: warn };
		case 'egress_restored':
			return { text: _('Internet through %s is back').format(server), detail: detail, color: ok };
		case 'disabled':
			return { text: _('Instance disabled') };
		case 'credentials_set':
			return { text: _('Credentials set') };
		case 'credentials_cleared':
			return { text: _('Credentials removed') };
		}
		return { text: ev.type || _('Unknown'), detail: detail };
	},

	refreshStatus: function() {
		return callInstances().then(L.bind(function(res) {
			this.instances = (res && res.instances) || [];
			this.trackTransfer(this.instances);
			this.status = this.statusOf(this.instance) || {};
			this.updateInstancesTable();
			this.updateStatusBand();
			this.refreshHistory();
			if (this.rotNextSpan)
				dom.content(this.rotNextSpan, [ this.nextRotationText() ]);
			// If the detected routing mode changed underneath an idle form (no
			// unsaved edits), rebuild it — the panel's shape depends on the mode,
			// so it must not go stale until a manual page refresh.
			var mode = (this.status.routing || {}).mode;
			if (!this.dirty && !this._saving && this._routingMode != null && mode !== this._routingMode)
				dom.content(this.formNode, this.buildFormSections());
			this._routingMode = mode;
		}, this)).catch(function() {});
	},

	// The background status poll is suspended while an apply runs: two pollers
	// compete for the one rpcd worker the apply itself needs, and a band
	// repainted from half-applied state contradicts the "Reconnecting…" banner
	// still on screen. Both apply call sites refresh once on their own when they
	// end. Counted, because a second apply may be started from another button
	// before the first watcher has resolved.
	pauseStatusPoll: function() {
		this._applyRuns = (this._applyRuns || 0) + 1;
		if (this._applyRuns === 1 && this._statusPoll)
			poll.remove(this._statusPoll);
	},

	resumeStatusPoll: function() {
		this._applyRuns = Math.max(0, (this._applyRuns || 0) - 1);
		if (this._applyRuns === 0 && this._statusPoll)
			poll.add(this._statusPoll, STATUS_POLL_S);
	},

	routingUnconfirmed: function(s) {
		return !!((s && s.routing_application && s.routing_application.confirmed === false) ||
			(this._routingUnconfirmed && this._routingUnconfirmed[this.instance]));
	},

	// Remember a failed application until this instance has a confirmed result.
	// Saved preferences alone must not be displayed as installed DNS/protection.
	operationResult: function(res, instance) {
		instance = instance || this.instance;
		this._routingUnconfirmed = this._routingUnconfirmed || {};
		if (res && (res.error || res.ok === false)) {
			this._routingUnconfirmed[instance] = true;
			if (!res.error)
				res = Object.assign({}, res, { error: _('Application failed at %s.').format(res.stage || _('an unknown stage')) });
		} else if (res && (res.ok === true || res.state === 'success')) {
			delete this._routingUnconfirmed[instance];
		}
		return res;
	},

	// Starts an apply and resolves with the very object the old synchronous
	// `apply` returned, so every call site keeps its result handling unchanged.
	// Never rejects on a backend-reported failure — only on a watcher that cannot
	// reach the router at all. `source` labels the history entry: 'reconnect',
	// 'enable' or 'save'.
	applyAsync: function(instance, source) {
		return this.runJob(function(inst) { return callApplyStart(inst, source); }, instance, 'apply')
			.then(L.bind(function(res) { return this.operationResult(res, instance); }, this));
	},

	// Runs one backend job (`kind` 'apply' or 'rotate') through `start` and
	// resolves with its result. The backend runs one job at a time and reports
	// it through apply_status. New backends return an immutable ID; older
	// backends remain compatible through kind/instance matching.
	runJob: function(start, instance, kind) {
		var deadline = Date.now() + APPLY_TIMEOUT_MS;
		var jobId = null;
		var mine = function(st) {
			return !!st && (jobId ? st.id === jobId :
				(st.kind || 'apply') === kind && st.instance === instance);
		};
		// A rotation may outlast an apply by far (max_retries candidates); the
		// job record states its own ceiling.
		var extend = function(st) {
			if (st && typeof st.max_runtime === 'number')
				deadline = Math.max(deadline, Date.now() + (st.max_runtime + 30) * 1000);
		};
		this.pauseStatusPoll();
		return start(instance).then(L.bind(function(res) {
			if (!res || !res.error) {
				jobId = res && res.apply && res.apply.id;
				extend(res && res.apply);
				return this.waitForApply(deadline, mine, jobId);
			}
			return { error: res.error };
		}, this)).then(L.bind(function(result) {
			this.resumeStatusPoll();
			return result;
		}, this), L.bind(function(e) {
			// The banner is the caller's to dismiss, but the poll must come back
			// no matter how this ended, or the page goes permanently static.
			this.resumeStatusPoll();
			throw e;
		}, this));
	},

	// Probes apply_status until the job leaves 'running'. Anything that is not a
	// finished job is turned into an `error` result rather than an optimistic
	// success: a banner claiming a tunnel that never came up is worse than an
	// honest "no idea". `mine` tells this job's record from another one's.
	waitForApply: function(deadline, mine, jobId) {
		var since = Date.now();
		return new Promise(function(resolve, reject) {
			var probe = function() {
				callApplyStatus(jobId || '').then(function(st) {
					var state = st && st.state;
					if ((state === 'done' || state === 'failed' || state === 'running') && !mine(st))
						// Another job ran after ours, so our own result is gone.
						return resolve({ error: _('another operation replaced this one; check the recent events') });
					if (state === 'done' || state === 'failed')
						return resolve((st && st.result) ||
							{ error: (st && st.error) || _('the operation finished without reporting a result') });
					if (state !== 'running')
						// 'idle' after a successful start means the job record is
						// gone — an rpcd restart, or the backend died mid-apply.
						return resolve({ error: (st && st.error) || _('the operation stopped reporting progress') });
					if (Date.now() >= deadline)
						return resolve({ error: _('the operation is still running after %d seconds — check the system log')
							.format(Math.round((Date.now() - since) / 1000)) });
					window.setTimeout(probe, APPLY_POLL_MS);
				}, function(e) {
					// One lost probe is not a failed apply: rpcd may just be busy
					// with the apply itself. Keep trying until the deadline, then
					// reject so the call site's catch reports the real transport
					// error instead of inventing an outcome.
					if (Date.now() >= deadline)
						return reject(e);
					window.setTimeout(probe, APPLY_POLL_MS);
				});
			};
			// The worker may already be finished when the start call returns.
			window.setTimeout(probe, APPLY_POLL_MS);
		});
	},

	reconnect: function(source) {
		var n = this.notice(_('Reconnecting…'), 'info');
		return this.applyAsync(this.instance, source).then(L.bind(function(res) {
			this.dismiss(n);
			if (res && res.error)
				this.notice(_('Reconnect failed: %s').format(res.error), 'error');
			else if (res && res.state === 'success')
				this.notice(_('Connected to %s').format(res.gateway || ''), 'info', 4000);
			else if (res && res.state === 'partial_failure')
				this.notice(_('Interface is up, but the server did not respond.'), 'error');
			else
				this.notice(_('Could not connect: %s').format((res && res.error) || _('unknown error')), 'error');
			return this.refreshStatus();
		}, this)).catch(L.bind(function(e) {
			this.dismiss(n);
			this.notice(_('Reconnect failed: %s').format(e), 'error');
		}, this));
	},

	disconnect: function() {
		var n = this.notice(_('Disabling…'), 'info');
		var instance = this.instance;
		return callDisconnect(instance).then(L.bind(function(res) {
			res = this.operationResult(res, instance);
			this.dismiss(n);
			if (res && res.error)
				this.notice(_('Disable failed: %s').format(res.error), 'error');
			else
				this.notice(_('Instance disabled: its networks are back on normal routing (IPv6 included). Reconnect restores the VPN.'), 'info', 6000);
			return this.refreshStatus();
		}, this)).catch(L.bind(function(e) {
			this.dismiss(n);
			this.notice(_('Disable failed: %s').format(e), 'error');
		}, this));
	},

	disableAll: function(ev) {
		var btn = ev && ev.currentTarget;
		if (this._disableAllRunning)
			return Promise.resolve();
		this._disableAllRunning = true;
		if (btn) btn.disabled = true;
		var n = this.notice(_('Disabling all VPNs…'), 'info');
		return callDisableAll().then(L.bind(function(res) {
			this.dismiss(n);
			var errors = (res && res.errors) || [];
			if (res && res.error)
				errors.push({ instance: '', error: res.error });
			var disabled = (res && res.disabled) || [];
			disabled.forEach(function(name) {
				uci.set('nordvpn', name, 'enabled', '0');
			});
			if (res && res.ok !== true && !errors.length)
				errors.push({ instance: '', error: _('backend did not confirm disabling the VPNs') });
			if (errors.length || !res || res.ok !== true) {
				var detail = errors.map(function(e) {
					return (e.instance ? e.instance + ': ' : '') + (e.error || _('unknown error'));
				}).join('; ');
				this.notice(_('Some VPNs could not be disabled: %s').format(detail || _('unknown error')), 'error', 8000);
			}
			else
				this.notice(_('All VPNs are disabled. Kill switches are off and LAN traffic routes to the WAN.'), 'info', 6000);
			// Reload committed UCI when the form is clean. Preserve staged form edits
			// otherwise; enabled=0 is already merged above for every successful one.
			var reload = this.dirty ? Promise.resolve() : Promise.resolve().then(function() {
				uci.unload('nordvpn');
				return uci.load('nordvpn');
			});
			return reload.then(L.bind(this.refreshStatus, this));
		}, this)).catch(L.bind(function(e) {
			this.dismiss(n);
			this.notice(_('Could not disable all VPNs: %s').format(e), 'error', 8000);
			return this.refreshStatus();
		}, this)).finally(L.bind(function() {
			this._disableAllRunning = false;
			if (btn) btn.disabled = false;
		}, this));
	},

	rotateNow: function() {
		var n = this.notice(_('Rotating to another server…'), 'info');
		return this.runJob(callRotateStart, this.instance, 'rotate').then(L.bind(function(res) {
			this.dismiss(n);
			if (res && res.ok)
				this.notice(_('Rotated to %s').format(res.server), 'info', 4000);
			else if (res && res.skipped)
				this.notice(_('Rotation skipped: %s').format(res.reason || ''), 'info', 4000);
			else
				this.notice(_('Rotation failed: %s').format((res && res.error) || _('unknown error')), 'error');
			return this.refreshStatus();
		}, this)).catch(L.bind(function(e) {
			this.dismiss(n);
			this.notice(_('Rotation failed: %s').format(e), 'error');
		}, this));
	},

	/* ---- form sections ------------------------------------------------ */

	buildFormSections: function() {
		this.srvCancelFilter();
		this._formGeneration = (this._formGeneration || 0) + 1;
		this._serversReq = (this._serversReq || 0) + 1;
		this.ensureConnectionState();
		this.refs = {};
		// Building the form fires the same change paths as user input; the
		// guard keeps programmatic construction from marking the form dirty.
		this._building = true;
		// Credentials sit at the top of the page, apart from the form, but follow
		// the selected instance, so they are rebuilt with it.
		dom.content(this.credNode, this.buildCredentials());
		var sections = [ this.buildConnection(), this.buildRoutingSection(), this.buildRotation(), this.buildAdvanced() ];
		this.srvRenderTrigger();
		this.updateRotationAvailability();
		this._building = false;
		return sections;
	},

	row: function(labelText, fieldNodes, descText) {
		var field = E('div', { class: 'cbi-value-field' }, fieldNodes);
		if (descText)
			field.appendChild(E('div', { class: 'cbi-value-description' }, descText));
		return E('div', { class: 'cbi-value' }, [
			E('label', { class: 'cbi-value-title' }, labelText),
			field
		]);
	},

	input: function(key, type, value, attrs) {
		var el = E('input', Object.assign({
			type: type || 'text',
			class: 'cbi-input-text',
			value: (value != null ? value : '')
		}, attrs || {}));
		el.addEventListener('input', L.bind(this.markDirty, this));
		el.addEventListener('change', L.bind(this.markDirty, this));
		this.refs[key] = el;
		return el;
	},

	// The credential bank: named NordVPN credentials shared by the instances.
	// Every instance uses Default unless its Connection settings pick another.
	buildCredentials: function() {
		var creds = this.credentials || [];
		var rows = creds.map(L.bind(function(c) {
			var isDefault = (c.id === 'default');
			return E('tr', { class: 'tr' }, [
				E('td', { class: 'td' }, c.name),
				E('td', { class: 'td' }, c.configured ? _('Configured') : _('Not configured')),
				E('td', { class: 'td' }, (c.instances && c.instances.length) ? c.instances.join(', ') : _('not used')),
				E('td', { class: 'td nv-inline' }, [
					E('button', { class: 'cbi-button', click: L.bind(this.showCredentialModal, this, c) },
						c.configured ? _('Replace token') : _('Set token')),
					(isDefault && !c.configured) ? '' : E('button', {
						class: 'cbi-button cbi-button-remove',
						click: L.bind(this.showClearCredentialsModal, this, c)
					}, isDefault ? _('Remove key') : _('Remove'))
				])
			]);
		}, this));

		return E('fieldset', { class: 'cbi-section' }, [
			E('legend', {}, _('Credentials')),
			E('div', { class: 'cbi-section-node' }, [
				E('table', { class: 'table' }, [
					E('tr', { class: 'tr table-titles' }, [
						E('th', { class: 'th' }, _('Name')),
						E('th', { class: 'th' }, _('Status')),
						E('th', { class: 'th' }, _('Used by')),
						E('th', { class: 'th' }, '')
					])
				].concat(rows)),
				E('div', { class: 'cbi-value-description' },
					_('All instances use the Default credentials unless an instance picks another set under Connection.')),
				E('div', {}, [
					E('button', { class: 'cbi-button cbi-button-add', click: L.bind(this.showCredentialModal, this, null) },
						'+ ' + _('Add credentials'))
				])
			])
		]);
	},

	// A <select> over the credential bank, `value` preselected.
	credentialSelect: function(value) {
		return E('select', { class: 'cbi-input-select' }, (this.credentials || []).map(function(c) {
			return E('option', { value: c.id, selected: (c.id === value) ? '' : null },
				c.configured ? c.name : _('%s (not configured)').format(c.name));
		}));
	},

	credentialName: function(id) {
		var found = (this.credentials || []).filter(function(c) { return c.id === id; })[0];
		return found ? found.name : id;
	},

	refreshCredentials: function() {
		return callCredentials().then(L.bind(function(res) {
			this.credentials = (res && res.credentials) || [];
			dom.content(this.credNode, this.buildCredentials());
		}, this)).catch(function() {});
	},

	buildConnection: function() {
		var draft = this.ensureConnectionState().draft;
		// Widget fields mirror the draft; fetched server data never owns edits.
		this._serverChosen = draft.fixed_server;
		this._srvOpen = false;
		this.srvReplaceData(null);
		this._srvFilter = '';
		this.srvTrigger = E('button', { type: 'button', class: 'cbi-button nv-pool-trigger nv-srv-trigger',
			click: L.bind(function(ev) { ev.preventDefault(); ev.stopPropagation(); this.srvTogglePanel(); }, this) },
			_('Automatic server'));
		this.srvPanel = E('div', { class: 'nv-pool-panel hidden',
			click: function(ev) { ev.stopPropagation(); } });
		this.srvError = E('div', { class: 'cbi-value-description', role: 'alert' });
		this.srvWrap = E('span', { class: 'nv-pool-wrap' }, [ this.srvTrigger, this.srvPanel, this.srvError ]);
		if (!this._srvOutsideBound) {
			this._srvOutsideBound = true;
			document.addEventListener('click', L.bind(function(ev) {
				if (this._srvOpen && this.srvWrap && !this.srvWrap.contains(ev.target))
					this.srvClosePanel();
			}, this));
		}

		var hop = draft.hop_mode;
		this.hopValue = (hop === 'multihop' || hop === 'onion') ? hop : 'single';
		this.hopButtons = {};
		var seg = E('div', { class: 'nv-seg' }, [
			[ 'single', _('Single hop') ],
			[ 'multihop', _('Multihop') ],
			[ 'onion', _('Onion over VPN') ]
		].map(L.bind(function(o) {
			var b = E('button', { type: 'button', click: L.bind(this.setHopMode, this, o[0]) }, o[1]);
			this.hopButtons[o[0]] = b;
			return b;
		}, this)));
		this.hopNote = E('div', { class: 'cbi-value-description' });

		// Server group (single hop only): P2P-optimised servers.
		this.p2pBox = E('input', { type: 'checkbox', change: L.bind(this.onHopChange, this) });
		this.p2pBox.checked = (draft.server_group === 'p2p');
		this.p2pRow = this.row(_('Server type'), [
			E('label', { class: 'nv-check' }, [ this.p2pBox, _('P2P servers only') ])
		], _('Limits this instance to NordVPN servers optimised for peer-to-peer (file sharing). Single hop only.'));
		this.updateHopButtons();

		// Location set editor: a combined country/city picker feeding removable
		// chips. The set drives BOTH the initial connect and the rotation. A
		// legacy country_code/city_code selection seeds the chips so upgraded
		// configs see their choice here. Codes no longer in the server list
		// are kept and shown dashed, never silently dropped.
		this.poolEntries = [];
		var seed = draft.locations;
		seed.forEach(L.bind(function(code) {
			var e = this.poolResolve(code);
			if (e)
				this.poolEntries.push(e);
		}, this));
		// Custom picker: a trigger opens a panel that walks countries -> cities
		// in place, with an explicit "back" step. No native <select>, so the
		// navigation and the reset-after-add feel like a small wizard.
		this._poolOpen = false;
		this._poolLevel = 'country';
		this._poolCountry = null;
		this._poolFilter = '';
		this.poolTrigger = E('button', { type: 'button', class: 'cbi-button nv-pool-trigger',
			click: L.bind(function(ev) { ev.preventDefault(); ev.stopPropagation(); this.poolTogglePanel(); }, this) },
			'+ ' + _('Add a location'));
		this.poolPanel = E('div', { class: 'nv-pool-panel hidden',
			click: function(ev) { ev.stopPropagation(); } });
		this.poolWrap = E('span', { class: 'nv-pool-wrap' }, [ this.poolTrigger, this.poolPanel ]);
		// One document-level closer for the whole view (guarded so form rebuilds
		// do not stack listeners); it reads the current poolWrap at click time.
		if (!this._poolOutsideBound) {
			this._poolOutsideBound = true;
			document.addEventListener('click', L.bind(function(ev) {
				if (this._poolOpen && this.poolWrap && !this.poolWrap.contains(ev.target))
					this.poolClosePanel();
			}, this));
		}
		this.poolChips = E('span', { class: 'nv-pool' });
		this.poolCount = E('span', { class: 'nv-pool-count' });
		this.poolNote = E('div', { class: 'cbi-value-description' });
		this.rebuildPoolWidget();

		// Which credentials this instance uses; offered once there is a choice.
		this.credSel = null;
		var credRow = '';
		if ((this.credentials || []).length > 1) {
			var cur = uci.get('nordvpn', this.instance, 'credential') || 'default';
			if (!(this.credentials || []).some(function(c) { return c.id === cur; }))
				cur = 'default';
			this.credSel = this.credentialSelect(cur);
			this.credSel.addEventListener('change', L.bind(this.markDirty, this));
			credRow = this.row(_('Credentials'), [ this.credSel ],
				_('The credentials this instance connects with. Takes effect on save.'));
		}

		var section = E('fieldset', { class: 'cbi-section' }, [
			E('legend', {}, _('Connection')),
			E('div', { class: 'cbi-section-node' }, [
				credRow,
				this.row(_('Hop mode'), [ seg, this.hopNote ]),
				this.p2pRow,
				this.row(_('Locations'), [
					E('div', {}, [ this.poolChips ]),
					this.poolWrap,
					this.poolNote
				], _('Countries this instance connects between. Picking a country adds the whole country; open its chip to narrow it to specific cities. The initial connect and the rotation both pick within this set.')),
				this.row(_('Server'), [
					this.srvWrap
				], _('Automatic picks a server from the set (rotation-friendly). Pin a specific one to lock it; pinning disables automatic rotation.'))
			])
		]);

		this.refreshServerList();
		return section;
	},

	// Traffic-routing panel. In a detected manual scheme it is purely
	// informational; otherwise it drives the backend's stamped auto-routing.
	buildRoutingSection: function() {
		var self = this;
		var g = function(o, d) { return uci.get('nordvpn', self.instance, o) || d; };
		var rt = (this.status || {}).routing || {};
		var body = E('div', { class: 'cbi-section-node' });
		this.autoRouting = null;
		this.steerBoxes = {};
		this.steerRow = null;
		this.devRow = null;
		this.domRow = null;
		this.bypDevRow = null;
		this.bypDomRow = null;
		this.pickers = {};
		this.domEds = {};

		// Read-only context: the interface and table this instance uses, so the
		// firewall/routing wiring is visible right here — not only in Advanced.
		var iface = (this.status || {}).interface || g('interface', 'nordvpn');
		var tbl = g('routing_table', '') || iface;
		body.appendChild(this.row(_('Interface / table'), [
			E('span', { class: 'nv-inline-note' },
				_('Interface %s · routing table %s — edit under Advanced settings.').format(iface, tbl))
		]));

		if (rt.mode === 'manual') {
			var what = [];
			if (rt.user_routes)
				what.push(_('%d custom route(s)/rule(s)').format(rt.user_routes));
			var table = g('routing_table', '');
			if (table)
				what.push(_('routing table "%s"').format(table));
			body.appendChild(this.row(_('Mode'), [
				E('div', {}, [
					E('span', {}, _('Manual — %s detected. The app leaves routing and firewall untouched.')
						.format(what.join(' + ') || _('custom configuration'))),
					E('div', { class: 'cbi-value-description' },
						_('Remove your own routes/rules that reference this interface to manage routing from here.'))
				])
			]));
			if (rt.ipv6_wan)
				body.appendChild(this.row('', [ E('span', { class: 'nv-inline-note' },
					_('⚠ IPv6 is active on the WAN and bypasses the VPN unless your rules cover it.')) ]));
		} else {
			this.autoRouting = E('input', { type: 'checkbox', change: L.bind(this.onRoutingToggle, this) });
			this.autoRouting.checked = (g('auto_routing', '0') === '1');
			this.ksBox = E('input', { type: 'checkbox', change: L.bind(this.markDirty, this) });
			this.ksBox.checked = (g('killswitch', '0') === '1');
			this.v6Box = E('input', { type: 'checkbox', change: L.bind(this.onRoutingToggle, this) });
			this.v6Box.checked = (g('block_ipv6', '1') === '1');
			this.masqBox = E('input', { type: 'checkbox', change: L.bind(this.markDirty, this) });
			this.masqBox.checked = (g('vpn_masq', '1') === '1');
			// DNS mode: prefer the enum, fall back to the legacy boolean.
			var dnsMode = g('vpn_dns', '');
			if (dnsMode !== 'off' && dnsMode !== 'standard' && dnsMode !== 'threat' && dnsMode !== 'custom')
				dnsMode = (g('use_vpn_dns', '0') === '1') ? 'standard' : 'off';
			this.dnsSel = E('select', { class: 'cbi-input-select', change: L.bind(function() {
				this.dnsCustom.classList.toggle('hidden', this.dnsSel.value !== 'custom');
				this.markDirty();
			}, this) }, [
				E('option', { value: 'off' }, _('Off — use system DNS')),
				E('option', { value: 'standard' }, _('NordVPN — standard')),
				E('option', { value: 'threat' }, _('NordVPN Threat Protection — blocks ads & malware')),
				E('option', { value: 'custom' }, _('Custom — your own DNS servers'))
			]);
			this.dnsSel.value = dnsMode;
			var customDns = L.toArray(uci.get('nordvpn', this.instance, 'custom_dns'));
			this.dnsCustom = E('input', { type: 'text', class: 'cbi-input-text', style: 'margin-top:.4em',
				placeholder: '9.9.9.9 149.112.112.112', value: customDns.join(' '),
				input: L.bind(this.markDirty, this) });
			this.dnsCustom.classList.toggle('hidden', dnsMode !== 'custom');
			this.v6Warn = E('div', { class: 'cbi-value-description nv-inline-note hidden' },
				_('⚠ IPv6 stays outside the tunnel and can leak your address.'));

			this.steerBoxes = {};
			var current = uci.get('nordvpn', this.instance, 'source_network');
			var currentList = Array.isArray(current) ? current : (current ? [ current ] : []);
			var nets = rt.networks || [];
			this.steerWrap = E('div', { class: 'nv-inline', style: 'gap:1em' }, nets.map(L.bind(function(n) {
				var cb = E('input', { type: 'checkbox', change: L.bind(this.onRoutingToggle, this) });
				cb.checked = currentList.indexOf(n) >= 0;
				this.steerBoxes[n] = cb;
				return E('label', { class: 'nv-check' }, [ cb, n ]);
			}, this)));

			// Only one instance can route all LAN traffic (the backend enforces
			// it too): elsewhere the box is locked, and a leftover conflict is
			// flagged so it can be cleared.
			var holder = this.allLanOwner(true);
			var owner = this.allLanOwner(false);
			var routeNote = null;
			if (holder && !this.autoRouting.checked) {
				this.autoRouting.disabled = true;
				routeNote = E('div', { class: 'cbi-value-description' },
					_('Already enabled on instance "%s". Only one instance can route all LAN traffic; route chosen networks, devices or domains through this one instead.').format(holder));
			} else if (owner) {
				routeNote = E('div', { class: 'cbi-value-description nv-inline-note' },
					_('⚠ Not active: instance "%s" already routes all LAN traffic. Turn it off here or there.').format(owner));
			}
			body.appendChild(this.row(_('Traffic routing'), [
				E('label', { class: 'nv-check' }, [ this.autoRouting, _('Route all LAN traffic through the VPN') ]),
				routeNote || ''
			], _('Routes every network of the LAN zone through the tunnel, using the tunnel\'s own routing table; other networks (a guest network) and the router itself keep the normal connection. Disabling removes exactly what was created.')));
			this.steerRow = this.row(_('Steered networks'), [ this.steerWrap ],
				_('Or route only these networks through this instance — policy rules send their traffic into its routing table.'));
			if (nets.length)
				body.appendChild(this.steerRow);
			this.devRow = this.buildDevicePicker('steer');
			body.appendChild(this.devRow);
			this.domRow = this.buildDomainEditor(rt, 'steer');
			body.appendChild(this.domRow);
			// Exceptions: shown whenever traffic is routed (all-LAN or steered).
			this.bypDevRow = this.buildDevicePicker('bypass');
			body.appendChild(this.bypDevRow);
			this.bypDomRow = this.buildDomainEditor(rt, 'bypass');
			body.appendChild(this.bypDomRow);
			this.ksRow = this.row(_('Kill switch'), [
				E('label', { class: 'nv-check' }, [ this.ksBox, _('Block LAN internet access while the VPN is down') ])
			]);
			this.v6Row = this.row(_('IPv6'), [
				E('label', { class: 'nv-check' }, [ this.v6Box, _('Block direct IPv6 to prevent leaks') ]),
				this.v6Warn
			]);
			this.masqRow = this.row(_('IP masquerading'), [
				E('label', { class: 'nv-check' }, [ this.masqBox, _('Hide LAN addresses behind the tunnel address (NAT)') ])
			], _('Leave this on unless the VPN provider can route replies back to your LAN. Turning it off usually breaks internet access through NordVPN.'));
			this.dnsRow = this.row(_('DNS'), [ this.dnsSel, this.dnsCustom ],
				_('Which resolver to use while connected. Custom takes up to 4 IPv4 addresses separated by spaces, for example Quad9 or your own Pi-hole; they are reached through the tunnel. Threat Protection blocks ads and malware at the DNS level; both NordVPN options only work through the tunnel. With "Route all LAN traffic", the router then forwards every lookup only to NordVPN (so none leak to your provider\'s resolver), and lookups fail while the tunnel is down. When steering, only the steered devices and networks use it (their IPv4 DNS is redirected to it); every other client keeps the router\'s normal DNS.'));
			body.appendChild(this.ksRow);
			body.appendChild(this.masqRow);
			body.appendChild(this.v6Row);
			body.appendChild(this.dnsRow);
			this.onRoutingToggle(true);
		}

		return E('fieldset', { class: 'cbi-section' }, [
			E('legend', {}, _('Traffic routing')),
			body
		]);
	},

	/* ---- per-domain steering ------------------------------------------- */

	// Mirror of the backend's validate_domain(): lower-case, drop a leading
	// '*.'/'.' and a trailing '.'; null when it is not a plain DNS name.
	normDomain: function(s) {
		var d = String(s || '').trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
		if (!d || d.length > 253)
			return null;
		return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(d) ? d : null;
	},

	// Mirror of the backend's validate_cidr4(): 'a.b.c.d' or 'a.b.c.d/1-32'.
	normIp: function(s) {
		var m = String(s || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
		if (!m || m.slice(1, 5).some(function(o) { return +o > 255; }))
			return null;
		if (m[5] != null && (+m[5] < 1 || +m[5] > 32))
			return null;
		return m[0];
	},

	// Split an editor's text into { valid (domains), ips (addresses and
	// networks), invalid } entries; each list is deduped and capped at 64.
	parseDomains: function(ed) {
		var valid = [], ips = [], invalid = [];
		var raw = (ed && ed.area) ? (ed.area.value || '').split(/[\s,]+/).filter(Boolean) : [];
		raw.forEach(L.bind(function(x) {
			var ip = this.normIp(x), d = ip ? null : this.normDomain(x);
			if (!ip && !d)
				invalid.push(x);
			else if (ip && ips.indexOf(ip) < 0)
				ips.push(ip);
			else if (d && valid.indexOf(d) < 0)
				valid.push(d);
		}, this));
		return { valid: valid.slice(0, 64), ips: ips.slice(0, 64), invalid: invalid,
			capped: valid.length > 64 || ips.length > 64 };
	},

	steeredDomains: function() {
		return this.parseDomains((this.domEds || {}).steer).valid;
	},

	steeredIps: function() {
		return this.parseDomains((this.domEds || {}).steer).ips;
	},

	excludedDomains: function() {
		return this.parseDomains((this.domEds || {}).bypass).valid;
	},

	excludedIps: function() {
		return this.parseDomains((this.domEds || {}).bypass).ips;
	},

	updateDomainNote: function(ed) {
		if (!ed || !ed.note)
			return;
		var p = this.parseDomains(ed);
		var msgs = [];
		if (p.invalid.length)
			msgs.push(_('Ignored (not a domain name or IPv4 address): %s').format(p.invalid.join(' ')));
		if (p.capped)
			msgs.push(_('Only the first 64 domains and 64 addresses are used.'));
		// Array-wrapped: a bare string goes to innerHTML, and the ignored
		// entries are raw editor/UCI text (see the E() note at the top).
		dom.content(ed.note, [ msgs.join(' ') ]);
		ed.note.classList.toggle('hidden', !msgs.length);
	},

	// One domain editor per list: 'steer' (steer_domain) or 'bypass'
	// (bypass_domain, always the normal connection).
	buildDomainEditor: function(rt, kind) {
		var ed = { kind: kind };
		var cur = L.toArray(uci.get('nordvpn', this.instance, (kind === 'bypass') ? 'bypass_domain' : 'steer_domain'))
			.concat(L.toArray(uci.get('nordvpn', this.instance, (kind === 'bypass') ? 'bypass_ip' : 'steer_ip')));
		ed.area = E('textarea', { class: 'cbi-input-textarea', rows: 3, style: 'width:100%;max-width:420px',
			placeholder: (kind === 'bypass') ? 'bank.example.com\n203.0.113.0/24' : 'example.com\nvideo.example.org\n198.51.100.0/24',
			input: L.bind(function() { this.updateDomainNote(ed); this.onRoutingToggle(); }, this) }, cur.join('\n'));
		ed.note = E('div', { class: 'cbi-value-description nv-inline-note hidden' });
		this.domEds[kind] = ed;
		var unsupported = (rt.domain_steering === 'unsupported' && cur.some(function(x) { return !this.normIp(x); }, this))
			? E('div', { class: 'cbi-value-description nv-inline-note' },
				_('⚠ The installed dnsmasq cannot fill nftables sets, so these domains are ignored. Install dnsmasq-full (replacing dnsmasq) and save again.'))
			: '';
		if (kind === 'bypass')
			return this.row(_('Excluded domains and addresses'), [ ed.area, ed.note, unsupported ],
				_('Traffic to these domains (and their subdomains) or IPv4 addresses and networks (for example 203.0.113.0/24) always uses your normal connection, for example a bank or a streaming site that blocks VPNs. One per line. Domains work for clients that use this router for DNS and need dnsmasq-full; addresses need neither.'));
		return this.row(_('Steered domains and addresses'), [ ed.area, ed.note, unsupported ],
			_('Route only traffic to these domains (and their subdomains) or IPv4 addresses and networks (for example 198.51.100.0/24) through this instance, one per line. Domains work for clients that use this router for DNS (apps with their own encrypted DNS bypass it) and need dnsmasq-full; addresses need neither. IPv4 only.'));
	},

	/* ---- per-device steering picker ------------------------------------ */

	// 'AA-BB-CC-DD-EE-FF' / 'aabbccddeeff' / 'aa:bb:…' -> 'aa:bb:cc:dd:ee:ff',
	// the form the backend stores; null when it is not a MAC.
	normMac: function(s) {
		var hex = String(s || '').toLowerCase().replace(/[:.-]/g, '');
		if (!/^[0-9a-f]{12}$/.test(hex))
			return null;
		return hex.match(/../g).join(':');
	},

	// MAC -> name of another *enabled* instance already steering it. The
	// backend gives a device to one tunnel only, so those rows are locked.
	deviceOwners: function() {
		var owners = {}, self = this;
		uci.sections('nordvpn').forEach(function(sec) {
			var name = sec['.name'];
			if (name === self.instance || name === 'globals' || sec.enabled !== '1')
				return;
			var l = sec.source_device;
			(Array.isArray(l) ? l : (l ? [ l ] : [])).forEach(function(m) {
				m = self.normMac(m);
				if (m && !owners[m])
					owners[m] = name;
			});
		});
		return owners;
	},

	// One device picker per list: 'steer' (source_device, routed through this
	// instance) or 'bypass' (bypass_device, always the normal connection). A
	// MAC selected in one list is taken out of the other.
	buildDevicePicker: function(kind) {
		var p = { kind: kind, sel: {} };
		L.toArray(uci.get('nordvpn', this.instance, (kind === 'bypass') ? 'bypass_device' : 'source_device'))
			.forEach(L.bind(function(m) {
				m = this.normMac(m);
				if (m)
					p.sel[m] = true;
			}, this));
		// Devices another instance steers are locked in the steering list only;
		// excluding a device is always possible.
		p.owners = (kind === 'bypass') ? {} : this.deviceOwners();
		this.pickers[kind] = p;
		this._pickOpen = this._pickOpen || {};

		p.summary = E('summary', {});
		p.search = E('input', { type: 'search', class: 'cbi-input-text nv-dev-search',
			placeholder: _('Search name, MAC or IP'), 'aria-label': _('Search devices'),
			input: L.bind(this.renderDevices, this, p) });
		p.onlySel = E('input', { type: 'checkbox', change: L.bind(this.renderDevices, this, p) });
		p.status = E('span', { class: 'nv-inline-note' });
		p.list = E('div', { class: 'nv-dev-list', role: 'listbox', 'aria-multiselectable': 'true' });
		var refresh = E('button', { type: 'button', class: 'cbi-button', title: _('Reload the client list'),
			click: L.bind(function(ev) { ev.preventDefault(); this.loadDevices(true); }, this) }, '↻');

		p.details = E('details', { class: 'nv-devices', toggle: L.bind(function() {
			this._pickOpen[kind] = p.details.open;
			if (p.details.open)
				this.loadDevices(false);
		}, this) }, [
			p.summary,
			E('div', { class: 'nv-dev-tools' }, [
				p.search,
				E('label', { class: 'nv-check' }, [ p.onlySel, _('Selected only') ]),
				refresh,
				p.status
			]),
			p.list
		]);
		// Keep the section open across form rebuilds (save, discard).
		if (this._pickOpen[kind])
			p.details.open = true;
		this.updateDevSummary(p);

		if (kind === 'bypass')
			return this.row(_('Excluded devices'), [ p.details ],
				_('These devices always use your normal internet connection, even while the kill switch blocks the rest, for example a TV, a console or a work laptop. Matched by MAC address. With NordVPN DNS on, they keep your provider\'s DNS over IPv4 (lookups they make over IPv6 still go to NordVPN).'));
		return this.row(_('Steered devices'), [ p.details ],
			_('Or route individual devices through this instance, matched by MAC address so a new DHCP lease keeps them on the tunnel. A device choice takes precedence over its network.'));
	},

	// Fetch the client list once per page (↻ forces a reload); both pickers
	// share it.
	loadDevices: function(force) {
		var pickers = this.pickers || {};
		if (this.clients && !force) {
			for (var k in pickers)
				this.renderDevices(pickers[k]);
			return Promise.resolve();
		}
		for (var j in pickers)
			dom.content(pickers[j].status, [ _('Loading…') ]);
		return callClients().then(L.bind(function(res) {
			this.clients = (res && Array.isArray(res.clients)) ? res.clients : [];
			for (var k in pickers)
				this.renderDevices(pickers[k]);
		}, this)).catch(L.bind(function(e) {
			this.clients = null;
			for (var k in pickers)
				dom.content(pickers[k].status, [ _('Could not load clients: %s').format(e) ]);
		}, this));
	},

	pickedDevices: function(kind) {
		var p = (this.pickers || {})[kind];
		return Object.keys(p ? p.sel : {}).sort();
	},

	steeredDevices: function() {
		return this.pickedDevices('steer');
	},

	otherPicker: function(p) {
		return (this.pickers || {})[(p.kind === 'bypass') ? 'steer' : 'bypass'];
	},

	updateDevSummary: function(p) {
		var n = Object.keys(p.sel).length;
		dom.content(p.summary, [ n
			? _('%d device(s) selected').format(n)
			: _('No devices selected') ]);
	},

	// Case-insensitive match on name and IP; MACs match with or without
	// separators ('AABB', 'aa:bb', 'aa-bb' all hit aa:bb:…).
	deviceMatches: function(c, q) {
		if (!q)
			return true;
		if ((c.name || '').toLowerCase().indexOf(q) >= 0)
			return true;
		if ((c.ips || []).some(function(ip) { return ip.toLowerCase().indexOf(q) >= 0; }))
			return true;
		if (c.mac.indexOf(q) >= 0)
			return true;
		var hex = q.replace(/[:.-]/g, '');
		return /^[0-9a-f]+$/.test(hex) && c.mac.replace(/:/g, '').indexOf(hex) >= 0;
	},

	renderDevices: function(p) {
		if (!p || !p.list)
			return;
		var q = (p.search.value || '').trim().toLowerCase();
		var onlySel = p.onlySel.checked;
		var sel = p.sel;

		// Known clients plus selected MACs not currently seen, so a device that
		// is offline (or gone) can still be deselected.
		var rows = [], known = {};
		(this.clients || []).forEach(function(c) {
			known[c.mac] = true;
			rows.push(c);
		});
		Object.keys(sel).forEach(function(m) {
			if (!known[m])
				rows.push({ mac: m, name: null, ips: [], network: null, online: false, notSeen: true });
		});

		var total = rows.length;
		rows = rows.filter(L.bind(function(c) {
			return (!onlySel || sel[c.mac]) && this.deviceMatches(c, q);
		}, this));
		rows.sort(function(a, b) {
			if (!!sel[a.mac] !== !!sel[b.mac]) return sel[a.mac] ? -1 : 1;
			if (!!a.online !== !!b.online) return a.online ? -1 : 1;
			return (a.name || '\uffff' + a.mac).localeCompare(b.name || '\uffff' + b.mac, undefined,
				{ numeric: true, sensitivity: 'base' });
		});

		var nodes = rows.map(L.bind(this.deviceRow, this, p));
		// A typed MAC that is not in the list can be added by hand.
		var typed = this.normMac(q);
		if (typed && !known[typed] && !sel[typed])
			nodes.push(E('div', { class: 'nv-dev-row', role: 'option', tabindex: '0',
				click: L.bind(this.addTypedDevice, this, p, typed),
				keydown: L.bind(function(ev) {
					if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.addTypedDevice(p, typed); }
				}, this) }, [
				E('span', { class: 'box' }, '+'),
				E('span', { class: 'nv-dev-name' }, _('Add %s').format(typed))
			]));
		if (!nodes.length)
			nodes.push(E('div', { class: 'nv-dev-empty' }, this.clients
				? _('No devices match.') : _('Client list not loaded.')));
		dom.content(p.list, nodes);
		dom.content(p.status, [ this.clients
			? _('%d of %d shown').format(rows.length, total) : '' ]);
	},

	deviceRow: function(p, c) {
		var on = !!p.sel[c.mac];
		var owner = p.owners[c.mac];
		var locked = !!owner && !on;
		var other = this.otherPicker(p);
		var meta = [ c.mac ];
		if ((c.ips || []).length)
			meta.push(c.ips.join(', '));
		if (c.network)
			meta.push(c.network);
		if (c.notSeen)
			meta.push(_('not seen'));
		if (owner)
			meta.push(_('in %s').format(owner));
		if (other && other.sel[c.mac])
			meta.push((p.kind === 'bypass') ? _('steered') : _('excluded'));
		var row = E('div', {
			class: 'nv-dev-row' + (on ? ' nv-dev-on' : '') + (locked ? ' nv-dev-locked' : ''),
			role: 'option', 'aria-selected': on ? 'true' : 'false',
			'aria-disabled': locked ? 'true' : null,
			tabindex: locked ? null : '0',
			title: locked ? _('Already routed through instance %s').format(owner) : null
		}, [
			E('span', { class: 'box' }, on ? '☑' : '☐'),
			E('span', { class: 'nv-dot ' + (c.online ? 'nv-dev-online' : 'nv-dev-offline'),
				title: c.online ? _('Online') : _('Offline') }),
			E('span', { class: 'nv-dev-info' }, [
				E('span', { class: 'nv-dev-name' }, c.name || _('(unnamed)')),
				E('span', { class: 'nv-dev-meta' }, meta.join(' · '))
			])
		]);
		if (!locked) {
			row.addEventListener('click', L.bind(this.toggleDevice, this, p, c.mac, row));
			row.addEventListener('keydown', L.bind(function(ev) {
				if (ev.key === 'Enter' || ev.key === ' ') {
					ev.preventDefault();
					this.toggleDevice(p, c.mac, row);
				}
			}, this));
		}
		return row;
	},

	// Selecting a MAC in one list takes it out of the other (a device is
	// either steered or excluded), and refreshes that list.
	releaseFromOther: function(p, mac) {
		var other = this.otherPicker(p);
		if (!other || !other.sel[mac])
			return;
		delete other.sel[mac];
		this.updateDevSummary(other);
		this.renderDevices(other);
	},

	// Toggle in place (no re-sort), so the list does not jump under the
	// pointer while working through it; the next search/open re-sorts.
	toggleDevice: function(p, mac, row) {
		if (p.sel[mac])
			delete p.sel[mac];
		else
			p.sel[mac] = true;
		var on = !!p.sel[mac];
		if (on)
			this.releaseFromOther(p, mac);
		row.classList.toggle('nv-dev-on', on);
		row.setAttribute('aria-selected', on ? 'true' : 'false');
		dom.content(row.firstChild, [ on ? '☑' : '☐' ]);
		this.updateDevSummary(p);
		this.onRoutingToggle();
	},

	addTypedDevice: function(p, mac) {
		p.sel[mac] = true;
		this.releaseFromOther(p, mac);
		p.search.value = '';
		this.updateDevSummary(p);
		this.onRoutingToggle();
		this.renderDevices(p);
	},

	steeredNetworks: function() {
		var out = [];
		for (var k in (this.steerBoxes || {}))
			if (this.steerBoxes[k].checked)
				out.push(k);
		return out;
	},

	// Another enabled instance with "Route all LAN traffic" on, or null.
	// `any` false: only one ahead of the selected instance, i.e. the one the
	// backend lets win (the first, main first). `any` true: any other one.
	allLanOwner: function(any) {
		var list = this.instances || [];
		for (var i = 0; i < list.length; i++) {
			var n = list[i].instance;
			if (n === this.instance) {
				if (any)
					continue;
				return null;
			}
			if (list[i].enabled !== false && uci.get('nordvpn', n, 'auto_routing') === '1')
				return n;
		}
		return null;
	},

	onRoutingToggle: function(init) {
		if (init !== true)
			this.markDirty();
		var auto = this.autoRouting && this.autoRouting.checked;
		var on = auto || this.steeredNetworks().length > 0 || this.steeredDevices().length > 0 ||
			this.steeredDomains().length > 0 || this.steeredIps().length > 0;
		if (this.steerRow) this.steerRow.classList.toggle('hidden', !!auto);
		if (this.devRow) this.devRow.classList.toggle('hidden', !!auto);
		if (this.domRow) this.domRow.classList.toggle('hidden', !!auto);
		if (this.bypDevRow) this.bypDevRow.classList.toggle('hidden', !on);
		if (this.bypDomRow) this.bypDomRow.classList.toggle('hidden', !on);
		if (this.ksRow) this.ksRow.classList.toggle('hidden', !on);
		if (this.v6Row) this.v6Row.classList.toggle('hidden', !on);
		if (this.dnsRow) this.dnsRow.classList.toggle('hidden', !on);
		var rt = (this.status || {}).routing || {};
		if (this.v6Warn)
			this.v6Warn.classList.toggle('hidden', !(on && this.v6Box && !this.v6Box.checked && rt.ipv6_wan));
	},

	buildRotation: function() {
		var enabled = (uci.get('nordvpn', this.instance, 'rotation_enabled') === '1');
		var mode = uci.get('nordvpn', this.instance, 'rotation_mode') || 'interval';
		var interval = uci.get('nordvpn', this.instance, 'rotation_interval') || '360';
		var time = uci.get('nordvpn', this.instance, 'rotation_time') || '04:30';

		this.rotEnable = E('input', { type: 'checkbox', change: L.bind(this.onRotationToggle, this) });
		this.rotEnable.checked = enabled;

		this.rotModeInterval = E('input', { type: 'radio', name: 'nv-rotmode', value: 'interval', change: L.bind(this.onRotationToggle, this) });
		this.rotModeTime = E('input', { type: 'radio', name: 'nv-rotmode', value: 'time', change: L.bind(this.onRotationToggle, this) });
		(mode === 'time' ? this.rotModeTime : this.rotModeInterval).checked = true;

		this.rotInterval = E('select', { class: 'cbi-input-select', change: L.bind(this.markDirty, this) });
		[ [ '60', _('Every hour') ], [ '180', _('Every 3 hours') ], [ '360', _('Every 6 hours') ],
		  [ '720', _('Every 12 hours') ], [ '1440', _('Every 24 hours') ] ].forEach(L.bind(function(o) {
			this.rotInterval.appendChild(E('option', { value: o[0], selected: (o[0] === interval) || null }, o[1]));
		}, this));

		this.rotTime = E('input', { type: 'time', class: 'cbi-input-text', value: time, style: 'width:auto', change: L.bind(this.markDirty, this) });
		this.refs.rotation_interval = this.rotInterval;
		this.refs.rotation_time = this.rotTime;

		this.rotFixedNote = E('div', { class: 'cbi-value-description nv-inline-note hidden' }, _('Automatic rotation is unavailable while a specific server is selected.'));
		this.rotModeRow = this.row(_('Schedule'), [
			E('div', { class: 'nv-radio-group' }, [
				E('label', {}, [ this.rotModeInterval, _('Every N hours') ]),
				E('label', {}, [ this.rotModeTime, _('At specific time') ])
			])
		]);
		this.rotIntervalRow = this.row(_('Rotation interval'), [ this.rotInterval ]);
		this.rotTimeRow = this.row(_('Rotation time'), [ this.rotTime ], _('Router local time'));
		this.rotNextSpan = E('span', {}, this.nextRotationText());
		this.rotNextRow = this.row(_('Next rotation'), [ this.rotNextSpan ]);

		var section = E('fieldset', { class: 'cbi-section', id: 'nv-rotation' }, [
			E('legend', {}, _('Automatic rotation')),
			E('div', { class: 'cbi-section-node' }, [
				this.row(_('Automatic rotation'), [
					E('label', { class: 'nv-check' }, [ this.rotEnable, _('Change server automatically on a schedule') ]),
					this.rotFixedNote
				]),
				this.rotModeRow, this.rotIntervalRow, this.rotTimeRow, this.rotNextRow
			])
		]);

		this.onRotationToggle();
		return section;
	},

	nextRotationText: function() {
		var s = this.status || {};
		var r = s.rotation || {};
		if (!r.enabled)
			return _('Disabled');
		if (!r.next_run)
			return _('On schedule');
		var d = new Date(r.next_run * 1000);
		var diff = Math.floor((d.getTime() - Date.now()) / 1000);
		if (diff < 90)
			return '%s (%s)'.format(d.toLocaleString(), _('due now'));
		var h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60);
		var rel = h > 0 ? _('in %dh %dm').format(h, m) : _('in %dm').format(m);
		return '%s (%s)'.format(d.toLocaleString(), rel);
	},

	/* ---- rotation pool -------------------------------------------------- */

	// Resolve a pool code to display metadata against the current locations
	// tree and hop mode. A code that is not in the tree (removed by NordVPN,
	// or empty for the current hop mode) resolves with name/count null so the
	// chip renders dashed instead of disappearing.
	poolResolve: function(code) {
		if (typeof code !== 'string' || !code)
			return null;
		var key = this.hopCountKey();
		var isCountry = /^[A-Za-z]{2}$/.test(code);
		var flag = this.countryFlag(code.slice(0, 2));
		var countries = this.filteredCountries();
		for (var i = 0; i < countries.length; i++) {
			var c = countries[i];
			if (isCountry && c.code === code)
				return { code: code, kind: 'country', name: c.name, count: c.gateway_count || 0, flag: flag };
			var cities = isCountry ? [] : (c.cities || []);
			for (var j = 0; j < cities.length; j++)
				if (cities[j].code === code)
					return { code: code, kind: 'city', name: cities[j].name, count: cities[j][key] || 0, flag: flag };
		}
		return { code: code, kind: isCountry ? 'country' : 'city', name: null, count: null, flag: flag };
	},

	/* ---- country-first set mutations ---------------------------------- */

	poolCitiesOf: function(cc) {
		return (((this._ccData || {})[cc]) || {}).cities || [];
	},

	// Current state of a country in the set: whole, or a map of picked cities.
	poolCountryHas: function(cc) {
		var whole = false, cities = {};
		(this.poolEntries || []).forEach(function(e) {
			if (e.code === cc) whole = true;
			else if (e.kind === 'city' && e.code.indexOf(cc + '-') === 0) cities[e.code] = true;
		});
		return { whole: whole, cities: cities, has: whole || Object.keys(cities).length > 0 };
	},

	poolStripCountry: function(cc) {
		this.poolEntries = (this.poolEntries || []).filter(function(e) {
			return !(e.code === cc || (e.kind === 'city' && e.code.indexOf(cc + '-') === 0));
		});
	},

	_poolCommit: function() {
		this.markConnectionDirty();
		this.rebuildPoolWidget();
		this.refreshServerList();
	},

	// Whole country in the set (stored as the bare country code).
	poolSetWhole: function(cc) {
		this.poolStripCountry(cc);
		var e = this.poolResolve(cc);
		if (e)
			this.poolEntries.push(e);
		this._poolCommit();
	},

	poolRemoveCountry: function(cc) {
		this.poolStripCountry(cc);
		this._poolCommit();
	},

	// Narrow a country to specific city codes. All cities selected collapses
	// back to the whole country; none removes it entirely.
	poolSetCities: function(cc, codes) {
		var all = this.poolCitiesOf(cc).map(function(c) { return c.code; });
		if (!codes.length)
			return this.poolRemoveCountry(cc);
		if (all.length && codes.length >= all.length)
			return this.poolSetWhole(cc);
		this.poolStripCountry(cc);
		codes.forEach(L.bind(function(code) {
			var e = this.poolResolve(code);
			if (e)
				this.poolEntries.push(e);
		}, this));
		this._poolCommit();
	},

	// Toggle one city. From a whole country, the first uncheck expands to
	// "every city except this one".
	poolToggleCity: function(cc, code) {
		var st = this.poolCountryHas(cc);
		var all = this.poolCitiesOf(cc).map(function(c) { return c.code; });
		var sel;
		if (st.whole) {
			sel = all.filter(function(x) { return x !== code; });
		} else {
			sel = Object.keys(st.cities);
			if (sel.indexOf(code) >= 0)
				sel = sel.filter(function(x) { return x !== code; });
			else
				sel.push(code);
		}
		this.poolSetCities(cc, sel);
	},

	// The "whole country" master toggle.
	poolToggleWhole: function(cc) {
		if (this.poolCountryHas(cc).whole)
			this.poolRemoveCountry(cc);
		else
			this.poolSetWhole(cc);
	},

	// Repaint the cascade picker, chips and the counter. Re-resolves entries,
	// so it is also the hop-mode/locations change hook. Also maintains the
	// country-code → name/data maps used by the cascade and server labels.
	rebuildPoolWidget: function() {
		if (!this.poolChips)
			return;
		this.poolEntries = (this.poolEntries || []).map(L.bind(function(e) {
			return this.poolResolve(e.code);
		}, this)).filter(function(e) { return e != null; });

		this._ccNames = {};
		this._ccData = {};
		this.filteredCountries().forEach(L.bind(function(c) {
			this._ccNames[c.code] = c.name;
			this._ccData[c.code] = c;
		}, this));
		// Keep an open panel in sync with the set (✓ marks, counts, city lists).
		if (this._poolOpen)
			this.poolRenderPanel();

		dom.content(this.poolChips, '');
		// One chip per country (country-first model). A whole-country chip shows
		// just the country; a narrowed one lists its picked cities. Remove drops
		// the whole country; the pencil opens its city checklist.
		// Entries not available in the current hop mode are hidden (shown as "not
		// selected") rather than as broken raw codes; switching modes therefore
		// reads as an empty set until valid locations are picked. They stay in
		// poolEntries so a round-trip mode switch does not lose them, and are
		// dropped from what gets saved (collectIntoUci filters the same way).
		var groups = [], byCc = {};
		this.poolEntries.forEach(function(e) {
			if (e.count == null)
				return;
			var cc = e.kind === 'country' ? e.code : e.code.split('-')[0];
			var g = byCc[cc];
			if (!g) {
				g = { cc: cc, flag: e.flag, whole: null, cities: [] };
				byCc[cc] = g;
				groups.push(g);
			}
			if (e.kind === 'country')
				g.whole = e;
			else
				g.cities.push(e);
		});

		var total = 0;
		groups.forEach(function(g) {
			if (g.whole) {
				if (g.whole.count != null) total += g.whole.count;
			} else {
				g.cities.forEach(function(e) { if (e.count != null) total += e.count; });
			}
		});

		groups.forEach(L.bind(function(g) {
			var cname = this._ccNames[g.cc] || (g.whole && g.whole.name) || g.cc.toUpperCase();
			var flag = g.flag || '';
			var label, stale;
			if (g.whole) {
				stale = g.whole.name == null;
				label = (flag ? flag + ' ' : '') + cname +
					(g.whole.count != null ? ' (%d)'.format(g.whole.count) : '');
			} else {
				stale = g.cities.some(function(e) { return e.name == null; });
				var cities = g.cities.map(function(e) { return e.name || e.code; }).join(', ');
				label = (flag ? flag + ' ' : '') + cname + ' · ' + cities;
			}
			// The whole chip opens this country's editor (cities + remove); no
			// separate ×/pencil buttons.
			this.poolChips.appendChild(E('span', {
				class: 'nv-chip nv-chip-country nv-chip-click' + (stale ? ' nv-chip-stale' : ''),
				title: _('Edit or remove'),
				click: L.bind(function(ev) { ev.stopPropagation(); this.poolOpenCountry(g.cc, true); }, this) },
				label));
		}, this));

		var summary = '';
		if (groups.length)
			summary = total ? _('set: %d countries, ~%d servers').format(groups.length, total)
				: _('set: %d countries').format(groups.length);
		this.poolChips.appendChild(this.poolCount);
		dom.content(this.poolCount, [ summary ]);

		// Guidance: the server list drives the picker, and the set must not be
		// empty — the connection picks within it.
		var note = '';
		if (!(this.locations || {}).available)
			note = _('Loading server list… use "Refresh server list" in Advanced settings if it does not appear.');
		else if (!groups.length)
			note = _('Add at least one country or city.');
		dom.content(this.poolNote, [ note ]);
		this.poolNote.classList.toggle('hidden', !note);
		if (this.poolTrigger)
			this.poolTrigger.disabled = !(this.locations || {}).available;
	},

	/* ---- location picker panel --------------------------------------- */

	poolTogglePanel: function() {
		if (this._poolOpen)
			return this.poolClosePanel();
		this._poolLevel = 'country';
		this._poolCountry = null;
		this._poolFilter = '';
		this._poolOpen = true;
		if (this.poolTrigger) this.poolTrigger.classList.add('hidden');
		this.poolPanel.classList.remove('hidden');
		this.poolRenderPanel();
	},

	poolClosePanel: function() {
		this._poolOpen = false;
		if (this.poolPanel) this.poolPanel.classList.add('hidden');
		if (this.poolTrigger) this.poolTrigger.classList.remove('hidden');
	},

	// Open a country's city checklist. Entering a country selects it whole
	// ("pick a country = whole country in the set"); checkboxes then narrow it.
	// edit=true means we came from a chip (editing that country): no "back to
	// countries", but a "remove this country" action instead. edit=false is the
	// add flow from the country list (keeps a back step).
	poolOpenCountry: function(cc, edit) {
		if (!this.poolCountryHas(cc).has)
			this.poolSetWhole(cc);
		this._poolLevel = 'city';
		this._poolCountry = cc;
		this._poolEdit = !!edit;
		this._poolFilter = '';
		this._poolOpen = true;
		if (this.poolTrigger) this.poolTrigger.classList.add('hidden');
		this.poolPanel.classList.remove('hidden');
		this.poolRenderPanel();
	},

	// City level: a back row, a "Whole country" master toggle, then a checkbox
	// per city. Country level: a header with close, a filter, the country list.
	poolRenderPanel: function() {
		var panel = this.poolPanel;
		if (!panel)
			return;
		dom.content(panel, '');

		if (this._poolLevel === 'city') {
			var cc = this._poolCountry;
			var c = (this._ccData || {})[cc];
			if (this._poolEdit) {
				var cflag = this.countryFlag(cc);
				panel.appendChild(E('div', { class: 'nv-pool-head' }, [
					E('span', {}, (cflag ? cflag + ' ' : '') + (this._ccNames[cc] || cc.toUpperCase())),
					E('button', { type: 'button', class: 'nv-pool-x', title: _('Done'),
						click: L.bind(function(ev) { ev.stopPropagation(); this.poolClosePanel(); }, this) }, '✕')
				]));
			} else {
				panel.appendChild(E('div', { class: 'nv-pool-head' }, [
					E('span', { class: 'nv-pool-back', style: 'cursor:pointer',
						click: L.bind(function(ev) {
							ev.stopPropagation();
							this._poolLevel = 'country';
							this._poolCountry = null;
							this._poolFilter = '';
							this.poolRenderPanel();
						}, this) }, '‹ ' + _('Back to countries')),
					E('button', { type: 'button', class: 'nv-pool-x', title: _('Close'),
						click: L.bind(function(ev) { ev.stopPropagation(); this.poolClosePanel(); }, this) }, '✕')
				]));
			}
			panel.appendChild(E('div', { class: 'nv-pool-sep' }));
			if (!c) {
				panel.appendChild(E('div', { class: 'nv-pool-row is-in' }, _('No cities available')));
				return;
			}
			var st = this.poolCountryHas(cc);
			panel.appendChild(E('div', { class: 'nv-pool-row',
				click: L.bind(function(ev) { ev.stopPropagation(); this.poolToggleWhole(cc); }, this) }, [
					E('span', { class: 'box' }, st.whole ? '☑' : '☐'),
					E('span', { class: 'grow' }, _('Whole country (%d)').format(c.gateway_count || 0))
				]));
			panel.appendChild(E('div', { class: 'nv-pool-sep' }));
			var key = this.hopCountKey();
			(c.cities || []).forEach(L.bind(function(city) {
				var on = st.whole || !!st.cities[city.code];
				panel.appendChild(E('div', { class: 'nv-pool-row',
					click: L.bind(function(ev) { ev.stopPropagation(); this.poolToggleCity(cc, city.code); }, this) }, [
						E('span', { class: 'box' }, on ? '☑' : '☐'),
						E('span', { class: 'grow' }, '%s (%d)'.format(city.name, city[key] || 0))
					]));
			}, this));
			if (this._poolEdit) {
				panel.appendChild(E('div', { class: 'nv-pool-sep' }));
				panel.appendChild(E('div', { class: 'nv-pool-row nv-pool-remove',
					click: L.bind(function(ev) {
						ev.stopPropagation();
						this.poolRemoveCountry(cc);
						this.poolClosePanel();
					}, this) }, [
						E('span', { class: 'box' }, '🗑'),
						E('span', { class: 'grow' }, _('Remove this country'))
					]));
			}
			return;
		}

		panel.appendChild(E('div', { class: 'nv-pool-head' }, [
			E('span', {}, _('Add a location')),
			E('button', { type: 'button', class: 'nv-pool-x', title: _('Close'),
				click: L.bind(function(ev) { ev.stopPropagation(); this.poolClosePanel(); }, this) }, '✕')
		]));
		var filt = E('input', { type: 'text', class: 'cbi-input-text nv-pool-filter',
			placeholder: _('Search countries or cities') + '…', value: this._poolFilter });
		filt.addEventListener('input', L.bind(function() {
			this._poolFilter = filt.value;
			this.poolRenderCountryList();
		}, this));
		filt.addEventListener('click', function(ev) { ev.stopPropagation(); });
		panel.appendChild(filt);
		this._poolListEl = E('div', {});
		panel.appendChild(this._poolListEl);
		this.poolRenderCountryList();
		// The panel re-renders after every pick; keep typing where it left off.
		setTimeout(function() {
			try {
				filt.focus();
				filt.setSelectionRange(filt.value.length, filt.value.length);
			} catch (e) {}
		}, 0);
	},

	// Country rows, filtered. Mark: whole = check, partial = half, none = blank.
	// Clicking a row opens that country (adding it whole, then narrow-able).
	poolRenderCountryList: function() {
		var el = this._poolListEl;
		if (!el)
			return;
		dom.content(el, '');
		var f = (this._poolFilter || '').toLowerCase();
		var any = false;
		this.filteredCountries().forEach(L.bind(function(c) {
			if (f && c.name.toLowerCase().indexOf(f) < 0 && c.code.toLowerCase().indexOf(f) < 0)
				return;
			any = true;
			var st = this.poolCountryHas(c.code);
			var mark = st.whole ? '☑' : (st.has ? '◐' : '');
			var flag = this.countryFlag(c.code);
			el.appendChild(E('div', { class: 'nv-pool-row' + (st.has ? ' is-in' : ''),
				click: L.bind(function(ev) { ev.stopPropagation(); this.poolOpenCountry(c.code); }, this) }, [
					E('span', { class: 'box' }, mark),
					E('span', { class: 'grow' }, (flag ? flag + ' ' : '') +
						'%s (%d)'.format(c.name, c.gateway_count || 0)),
					E('span', { class: 'chev' }, '›')
				]));
		}, this));

		// While filtering, cities match too, across every country, so a city can
		// be found without knowing its country. Clicking one adds just that city
		// (or drops it again); the panel stays open for more picks.
		var cityRows = [];
		if (f) {
			var key = this.hopCountKey();
			this.filteredCountries().forEach(L.bind(function(c) {
				var st = this.poolCountryHas(c.code);
				var flag = this.countryFlag(c.code);
				(c.cities || []).forEach(L.bind(function(city) {
					if ((city.name || '').toLowerCase().indexOf(f) < 0)
						return;
					var on = st.whole || !!st.cities[city.code];
					cityRows.push(E('div', { class: 'nv-pool-row',
						click: L.bind(function(ev) { ev.stopPropagation(); this.poolToggleCity(c.code, city.code); }, this) }, [
							E('span', { class: 'box' }, on ? '☑' : '☐'),
							E('span', { class: 'grow' }, (flag ? flag + ' ' : '') +
								'%s, %s (%d)'.format(city.name, c.name, city[key] || 0))
						]));
				}, this));
			}, this));
		}
		if (cityRows.length) {
			if (any)
				el.appendChild(E('div', { class: 'nv-pool-sep' }));
			el.appendChild(E('div', { class: 'nv-pool-label' }, _('Cities')));
			cityRows.forEach(function(r) { el.appendChild(r); });
			any = true;
		}
		if (!any)
			el.appendChild(E('div', { class: 'nv-pool-row is-in' }, _('No matches')));
	},

	// "hr" -> 🇭🇷 via regional-indicator codepoints. Returns '' for anything
	// that is not two ASCII letters, so malformed codes fall back to the
	// plain name.
	countryFlag: function(code) {
		if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code))
			return '';
		var c = code.toLowerCase();
		return String.fromCodePoint(
			0x1F1E6 + (c.charCodeAt(0) - 97),
			0x1F1E6 + (c.charCodeAt(1) - 97));
	},

	buildAdvanced: function() {
		var self = this;
		var g = function(o, d) { return uci.get('nordvpn', self.instance, o) || d; };
		// The server-list cache is shared between instances (owned by 'main').
		var gm = function(o, d) { return uci.get('nordvpn', 'main', o) || d; };
		this.cacheRow = E('span', {}, this.cacheSummary());

		// MTU with a WAN-derived recommendation (backend computes WAN_MTU - 80).
		var rtx = (this.status || {}).routing || {};
		var recMtu = rtx.recommended_mtu;
		var curMtu = g('mtu', '');
		var atRec = recMtu && curMtu !== '' && parseInt(curMtu, 10) === recMtu;
		var mtuInput = this.input('mtu', 'number', g('mtu', ''),
			{ min: 1280, max: 1500, style: 'width:90px', placeholder: recMtu ? ('' + recMtu) : '1420' });
		var mtuCtl = [ mtuInput ];
		if (atRec) {
			mtuCtl.push(' ');
			mtuCtl.push(E('span', { style: 'color:var(--success-color-medium,#3c8c3c);font-weight:600' },
				_('✓ recommended value')));
		} else if (recMtu) {
			mtuCtl.push(' ');
			mtuCtl.push(E('button', { class: 'cbi-button', click: L.bind(function(ev) {
				ev.preventDefault();
				mtuInput.value = recMtu;
				this.markDirty();
			}, this) }, _('Use recommended')));
		}
		var mtuDesc = atRec
			? _('You are on the recommended MTU for your WAN (MTU %d). Empty = the netifd default (1420).').format(rtx.wan_mtu || 0)
			: (recMtu
				? _('Recommended %d for your WAN (MTU %d). Empty = the default (1420). Lower it if sites/Gmail hang or throughput is poor — LTE/5G often need less.').format(recMtu, rtx.wan_mtu || 0)
				: _('WireGuard interface MTU. Empty = the netifd default (1420).'));

		this.selSel = E('select', { class: 'cbi-input-select', change: L.bind(this.markDirty, this) }, [
			E('option', { value: 'balanced' }, _('Balanced — prefer lightly loaded servers')),
			E('option', { value: 'least_load' }, _('Lowest load first')),
			E('option', { value: 'random' }, _('Random'))
		]);
		this.selSel.value = g('selection', 'balanced');
		if (!this.selSel.value)
			this.selSel.value = 'balanced';

		this.wdBox = E('input', { type: 'checkbox', change: L.bind(this.markDirty, this) });
		this.wdBox.checked = (g('watchdog', '0') === '1');

		this.probeBox = E('input', { type: 'checkbox', change: L.bind(function() {
			this.markDirty();
			this.probeTargetsRow.classList.toggle('hidden', !this.probeBox.checked);
		}, this) });
		this.probeBox.checked = (g('egress_probe', '0') === '1');
		var targets = L.toArray(uci.get('nordvpn', this.instance, 'probe_target'));

		var body = E('div', { class: 'cbi-section-node' }, [
			this.row(_('Interface name'), [ this.input('interface', 'text', g('interface', 'nordvpn')) ],
				_('Name of the managed WireGuard interface. ⚠ Changing it after setup recreates the tunnel under the new name and orphans the old interface’s firewall/routing objects.')),
			this.row(_('Routing table'), [ this.input('routing_table', 'text', g('routing_table', ''), { placeholder: 'main' }) ],
				_('Custom routing table (empty = the interface name when steering or routing all LAN traffic, otherwise the main table). Changing it does not reconnect the tunnel.')),
			this.row(_('MTU'), mtuCtl, mtuDesc),
			this.row(_('Connection wait (seconds)'), [ this.input('verify_timeout', 'number', g('verify_timeout', '8'), { min: 2, max: 30, style: 'width:80px' }) ],
				_('How long to wait for a WireGuard handshake before giving up on a server')),
			this.maxRetriesRow = this.row(_('Max server attempts'), [ this.input('max_retries', 'number', g('max_retries', '10'), { min: 1, max: 50, style: 'width:80px' }) ],
				_('How many candidate servers a rotation may try')),
			this.selRow = this.row(_('Server selection'), [ this.selSel ],
				_('Order in which automatic connects and rotations try servers. Balanced favours lightly loaded servers but still spreads out; load figures come from the cached server list.')),
			this.wdRow = this.row(_('Auto-reconnect (watchdog)'), [
				E('label', { class: 'nv-check' }, [ this.wdBox, _('Reconnect automatically when the tunnel goes stale') ])
			], _('Switches to another server when the handshake goes stale — or, with the internet check on, when the tunnel stops forwarding traffic. Off when a specific server is pinned.')),
			this.row(_('Internet check'), [
				E('label', { class: 'nv-check' }, [ this.probeBox, _('Ping through the tunnel every 30 seconds') ])
			], _('Catches a tunnel whose handshake is alive but which forwards nothing. After 3 failed checks in a row it shows as "No internet", and the watchdog (when on) switches servers.')),
			this.probeTargetsRow = this.row(_('Check targets'), [
				this.input('probe_target', 'text', targets.join(' '), { placeholder: '1.1.1.1 8.8.8.8', style: 'width:240px' })
			], _('IPv4 addresses to ping through the tunnel, separated by spaces; a reply from any of them counts. Empty = 1.1.1.1 and 8.8.8.8.')),
			this.row(_('Cache directory'), [ this.input('cache_dir', 'text', gm('cache_dir', ''), { placeholder: '/tmp' }) ],
				_('Where to store the downloaded server list, shared by all instances (leave empty for /tmp)')),
			this.row(_('Server cache'), [
				E('div', { class: 'nv-inline' }, [
					this.cacheRow,
					E('button', { class: 'cbi-button', click: L.bind(this.refreshCache, this) }, _('Refresh server list'))
				])
			])
		]);

		// The connection section is built (and may restore a pinned server)
		// before this row exists — sync the initial visibility.
		if (this._serverChosen) {
			this.maxRetriesRow.classList.add('hidden');
			this.selRow.classList.add('hidden');
			this.wdRow.classList.add('hidden');
		}
		if (!this.probeBox.checked)
			this.probeTargetsRow.classList.add('hidden');

		return E('details', { class: 'nv-advanced cbi-section' }, [
			E('summary', {}, _('Advanced settings')),
			body
		]);
	},

	cacheSummary: function() {
		var l = this.locations || {};
		if (!l.available)
			return _('Server list not loaded');
		var when = (l.cache_info && l.cache_info.created) ? l.cache_info.created : '';
		var count = (l.stats && l.stats.gateways) ? l.stats.gateways : 0;
		var txt = _('%d servers').format(count);
		if (when)
			txt += ' · ' + _('updated %s').format(when);
		if (l.state === 'stale')
			txt += ' · ' + _('stale');
		return txt;
	},

	buildActions: function() {
		this.saveBtn = E('button', {
			class: 'cbi-button cbi-button-save',
			disabled: true,
			click: L.bind(this.save, this)
		}, _('Save'));
		this.discardBtn = E('button', {
			class: 'cbi-button',
			disabled: true,
			click: L.bind(this.discard, this)
		}, _('Discard changes'));
		return E('div', { class: 'cbi-page-actions' }, [ this.saveBtn, ' ', this.discardBtn ]);
	},

	/* ---- selection ---------------------------------------------------- */

	hopMode: function() {
		return this.hopValue || 'single';
	},

	// Server group the instance is limited to ('p2p' or ''); single hop only.
	serverGroup: function() {
		return (this.hopMode() === 'single' && this.p2pBox && this.p2pBox.checked) ? 'p2p' : '';
	},

	// Key of the per-mode gateway counters in the locations tree.
	hopCountKey: function() {
		var m = this.hopMode();
		if (m === 'single' && this.serverGroup() === 'p2p')
			return 'p2p';
		return m === 'multihop' ? 'multi' : (m === 'onion' ? 'onion' : 'single');
	},

	setHopMode: function(mode) {
		if (this.hopValue === mode)
			return;
		this.hopValue = mode;
		this.onHopChange();
	},

	updateHopButtons: function() {
		var mode = this.hopMode();
		for (var k in this.hopButtons)
			this.hopButtons[k].classList.toggle('active', k === mode);
		if (this.hopNote) {
			var notes = {
				multihop: _('Country is the exit country (your visible IP); traffic enters through the partner country shown in the server name.'),
				onion: _('Traffic leaves the VPN server through the Tor network. Noticeably slower, and some sites block Tor exits.')
			};
			dom.content(this.hopNote, [ notes[mode] || '' ]);
			this.hopNote.classList.toggle('hidden', !notes[mode]);
		}
		if (this.p2pRow)
			this.p2pRow.classList.toggle('hidden', mode !== 'single');
	},

	filteredCountries: function() {
		var l = this.locations || {};
		if (!Array.isArray(l.countries))
			return [];
		var key = this.hopCountKey();
		var out = [];
		l.countries.forEach(function(c) {
			var cities = (c.cities || []).filter(function(city) {
				return (city[key] || 0) > 0;
			});
			var count = c[key] || 0;
			if (cities.length && count > 0)
				out.push(Object.assign({}, c, { cities: cities, gateway_count: count }));
		});
		return out;
	},

	// Fetch the union server list for the location set (ubus `servers` with the
	// locations argument) and repaint the picker. A pinned server no longer in
	// the set is kept, never dropped.
	refreshServerList: function() {
		if (!this.srvTrigger)
			return;
		var codes = (this.poolEntries || []).map(function(e) { return e.code; });
		var req = this._serversReq = (this._serversReq || 0) + 1;
		var instance = this.instance, form = this._formGeneration;
		var active = L.bind(function() {
			return req === this._serversReq && instance === this.instance && form === this._formGeneration;
		}, this);
		if (this.srvError) dom.content(this.srvError, '');
		this.srvReplaceData(null);
		this.srvTrigger.disabled = !codes.length && !this._serverChosen;
		this.srvRenderTrigger();
		if (!codes.length) return Promise.resolve();
		return callServers(codes, this.hopMode(), this.serverGroup()).then(L.bind(function(res) {
			if (!active())
				return;
			if (!res || res.error || !Array.isArray(res.relays))
				throw new Error((res && res.error) || _('Server list unavailable.'));
			this.srvReplaceData(res.relays);
			this.srvRenderTrigger();
		}, this)).catch(L.bind(function(err) {
			if (!active() || !this.srvError) return;
			dom.content(this.srvError, [ _('Could not read server list: %s').format(err), ' ',
				E('button', { type: 'button', class: 'cbi-button', click: L.bind(this.refreshServerList, this) }, _('Retry')) ]);
		}, this));
	},

	srvLoadClass: function(load) {
		if (typeof load !== 'number')
			return '';
		return load < 50 ? 'nv-dot-lo' : (load < 80 ? 'nv-dot-mid' : 'nv-dot-hi');
	},

	// The gateway the tunnel is on right now (live status), to flag it.
	srvCurrentGateway: function() {
		return (this.status && this.status.gateway) || '';
	},

	srvBuildIndex: function(relays) {
		var names = this._ccNames || {}, groups = [], byCode = Object.create(null), byHost = Object.create(null), best = null;
		function compare(a, b) {
			var al = typeof a.load === 'number' ? a.load : 999, bl = typeof b.load === 'number' ? b.load : 999;
			return al - bl || srvCompareName(a.name || a.hostname || '', b.name || b.hostname || '') ||
				srvCompareName(a.hostname || '', b.hostname || '');
		}
		relays.forEach(L.bind(function(value) {
			var r = Object.freeze(Object.assign({}, value));
			byHost[r.hostname] = r;
			if (typeof r.load === 'number' && !r.dedicated && (!best || compare(r, best) < 0)) best = r;
			var code = r.country_code || '', name = names[code] || code.toUpperCase();
			var g = byCode[code];
			if (!g) {
				g = byCode[code] = { name: name, flag: this.countryFlag(code), rows: [] };
				groups.push(g);
			}
			g.rows.push(Object.freeze({ relay: r,
				search: (name + ' / ' + (r.city || '') + ' / ' + (r.name || '') + ' / ' + (r.hostname || '')).toLowerCase() }));
		}, this));
		groups.sort(function(a, b) { return srvCompareName(a.name, b.name); });
		groups.forEach(function(g) {
			g.rows.sort(function(a, b) { return compare(a.relay, b.relay); });
			Object.freeze(g.rows); Object.freeze(g);
		});
		return Object.freeze({ byHost: Object.freeze(byHost), groups: Object.freeze(groups), lowest: best });
	},

	srvCancelFilter: function() {
		if (this._srvFilterTimer != null) clearTimeout(this._srvFilterTimer);
		this._srvFilterTimer = null;
	},

	srvReplaceData: function(relays) {
		this.srvCancelFilter();
		this._srvDataGeneration = (this._srvDataGeneration || 0) + 1;
		this._serverData = relays ? { relays: relays.slice() } : null;
		this._serverIndex = relays ? this.srvBuildIndex(relays) : null;
		this._srvOffset = 0;
		if (this._srvOpen) this.srvRenderList();
	},

	srvRelayByHost: function(host) {
		return (this._serverIndex && this._serverIndex.byHost[host]) || null;
	},

	srvLowestLoad: function() {
		return (this._serverIndex && this._serverIndex.lowest) || null;
	},

	// The trigger shows the current pin richly (load dot / flag / city / name),
	// or "Automatic server", with an inline clear when pinned.
	srvRenderTrigger: function() {
		var t = this.srvTrigger;
		if (!t)
			return;
		var host = this._serverChosen;
		if (!host) {
			dom.content(t, _('Automatic server'));
			return;
		}
		var r = this.srvRelayByHost(host);
		var names = this._ccNames || {};
		var kids;
		if (r) {
			var flag = this.countryFlag(r.country_code);
			kids = [
				E('span', { class: 'nv-dot ' + this.srvLoadClass(r.load) }),
				E('span', {}, ' ' + (flag ? flag + ' ' : '') +
					'%s / %s'.format(r.city || '?', r.name || r.hostname) +
					(r.load != null ? ' (%d%%)'.format(r.load) : ''))
			];
		} else {
			kids = [ E('span', {}, host + ' ' + _('(not in the set)')) ];
		}
		kids.push(E('button', { type: 'button', class: 'nv-srv-x', title: _('Clear (back to automatic)'),
			click: L.bind(function(ev) { ev.preventDefault(); ev.stopPropagation(); this.srvSetChosen(''); }, this) }, '×'));
		dom.content(t, kids);
	},

	srvTogglePanel: function() {
		if (this._srvOpen)
			return this.srvClosePanel();
		this._srvOffset = 0;
		this._srvOpen = true;
		if (this.srvTrigger) this.srvTrigger.classList.add('hidden');
		this.srvPanel.classList.remove('hidden');
		this.srvRenderPanel();
	},

	srvClosePanel: function() {
		this.srvCancelFilter();
		this._srvOpen = false;
		if (this.srvPanel) this.srvPanel.classList.add('hidden');
		if (this.srvTrigger) {
			this.srvTrigger.classList.remove('hidden');
			if (this.srvTrigger.focus) this.srvTrigger.focus();
		}
	},

	srvSetChosen: function(host) {
		this._serverChosen = host || '';
		this.markConnectionDirty();
		this.updateRotationAvailability();
		this.srvRenderTrigger();
		this.srvClosePanel();
	},

	// Keep the filter DOM stable during data refreshes and page changes.
	srvRenderPanel: function() {
		var panel = this.srvPanel;
		if (!panel) return;
		this.srvCancelFilter();
		var filt = this._srvFilterEl = E('input', { type: 'text', class: 'cbi-input-text nv-pool-filter',
			'aria-label': _('Filter servers'), placeholder: _('Filter servers') + '…', value: this._srvFilter || '' });
		filt.addEventListener('input', L.bind(function() {
			this._srvFilter = filt.value;
			this._srvOffset = 0;
			this.srvCancelFilter();
			var generation = this._srvDataGeneration, panel = this.srvPanel;
			this._srvFilterTimer = setTimeout(L.bind(function() {
				this._srvFilterTimer = null;
				if (this._srvOpen && generation === this._srvDataGeneration && panel === this.srvPanel)
					this.srvRenderList();
			}, this), 100);
		}, this));
		filt.addEventListener('click', function(ev) { ev.stopPropagation(); });
		panel.addEventListener('keydown', this._srvEscapeHandler || (this._srvEscapeHandler = L.bind(function(ev) {
			if (ev.key === 'Escape') { ev.stopPropagation(); this.srvClosePanel(); }
		}, this)));
		this._srvListEl = E('div', {});
		dom.content(panel, [ E('div', { class: 'nv-pool-head' }, [ E('span', {}, _('Pick a server')),
			E('button', { type: 'button', class: 'nv-pool-x', title: _('Close'),
				click: L.bind(function(ev) { ev.stopPropagation(); this.srvClosePanel(); }, this) }, '✕') ]), filt, this._srvListEl ]);
		this.srvRenderList();
		filt.focus();
	},

	srvRenderList: function(focusPage) {
		var el = this._srvListEl;
		if (!el) return;
		var names = this._ccNames || {}, chosen = this._serverChosen, current = this.srvCurrentGateway();
		var f = (this._srvFilter || '').toLowerCase(), groups = (this._serverIndex && this._serverIndex.groups) || [];
		var kids = [], firstRow = null, offset = this._srvOffset || 0, total = 0, shown = 0;
		var active = document.activeElement;
		var focusKey = active && el.contains && el.contains(active) ? active.getAttribute('data-server-key') : null;
		var action = L.bind(function(host, attrs, children) {
			return E('button', Object.assign({ type: 'button', class: 'nv-pool-row nv-srv-action', 'data-server-key': 'relay:' + host,
				click: L.bind(function(ev) { ev.stopPropagation(); this.srvSetChosen(host); }, this) }, attrs), children);
		}, this);
		kids.push(action('', { class: 'nv-pool-row nv-srv-action nv-srv-quick', 'data-server-key': 'automatic' }, [
			E('span', { class: 'box' }, chosen ? '' : '☑'), E('span', { class: 'grow' }, _('Automatic (rotation picks)')) ]));
		var best = this.srvLowestLoad();
		kids.push(action(best ? best.hostname : '', { class: 'nv-pool-row nv-srv-action nv-srv-quick', 'data-server-key': 'lowest', disabled: best ? null : '' }, [
			E('span', { class: 'box' }, '⚡'), E('span', { class: 'grow' }, _('Lowest load') + (best ? ' · ' +
				(best.city || names[best.country_code] || best.country_code || '') + ' (%d%%)'.format(best.load) : '')) ]));
		// Fixed text summaries keep off-page and filtered-out pins/current gateways visible.
		if (chosen) kids.push(E('div', { class: 'nv-srv-summary' }, _('Selected: %s').format(chosen) +
			(this.srvRelayByHost(chosen) ? '' : ' ' + _('(not in the set)'))));
		if (current) kids.push(E('div', { class: 'nv-srv-summary' }, _('Current: %s').format(current)));
		kids.push(E('div', { class: 'nv-pool-sep' }));
		groups.forEach(L.bind(function(g) {
			var header = false;
			g.rows.forEach(L.bind(function(entry) {
				if (f && entry.search.indexOf(f) < 0) return;
				var position = total++;
				if (position < offset || shown >= SRV_PAGE_SIZE) return;
				if (!header) { kids.push(E('div', { class: 'nv-srv-grp' }, (g.flag ? g.flag + ' ' : '') + g.name)); header = true; }
				var r = entry.relay, isPin = r.hostname === chosen;
				var row = action(r.hostname, { class: 'nv-pool-row nv-srv-action nv-srv-relay' + (isPin ? ' is-in' : ''),
					'aria-pressed': isPin ? 'true' : 'false' }, [
					E('span', { class: 'nv-dot ' + this.srvLoadClass(r.load) }),
					E('span', { class: 'grow' }, '%s / %s'.format(r.city || '?', r.name || r.hostname)),
					r.p2p ? E('span', { class: 'nv-srv-tag' }, _('P2P')) : '',
					r.dedicated ? E('span', { class: 'nv-srv-tag', title: _('Only works for the account this Dedicated IP is assigned to') }, _('Dedicated IP')) : '',
					current && r.hostname === current ? E('span', { class: 'nv-srv-cur' }, '● ' + _('current')) : '',
					E('span', { class: 'nv-srv-load' }, r.load != null ? '%d%%'.format(r.load) : '') ]);
				kids.push(row); if (!firstRow) firstRow = row; shown++;
			}, this));
		}, this));
		this._srvMatchCount = total;
		kids.push(E('div', { class: 'nv-srv-summary', role: 'status' }, _('%d–%d of %d matches').format(total ? offset + 1 : 0, offset + shown, total)));
		if (!total) kids.push(E('div', { class: 'nv-srv-summary' }, _('No matches')));
		var page = L.bind(function(delta) {
			// A click before the debounce expires belongs to the newly typed filter.
			var pendingFilter = this._srvFilterTimer != null;
			this.srvCancelFilter();
			this._srvOffset = pendingFilter ? 0 : Math.max(0, offset + delta * SRV_PAGE_SIZE);
			this.srvRenderList(true);
		}, this);
		if (offset) kids.push(E('button', { type: 'button', class: 'cbi-button nv-srv-prev', 'data-server-key': 'previous', click: function(ev) { ev.stopPropagation(); page(-1); } }, _('Previous')));
		if (offset + shown < total) kids.push(E('button', { type: 'button', class: 'cbi-button nv-srv-more', 'data-server-key': 'more', click: function(ev) { ev.stopPropagation(); page(1); } }, _('Show more')));
		// Build the whole page off-DOM, then replace it in one batch.
		dom.content(el, kids);
		if (focusPage && firstRow) firstRow.focus();
		else if (focusKey) {
			var replacement = Array.prototype.find.call(el.querySelectorAll('[data-server-key]'), function(node) {
				return node.getAttribute('data-server-key') === focusKey;
			});
			(replacement && !replacement.disabled ? replacement : this._srvFilterEl).focus();
		}
	},

	onHopChange: function() {
		this.markConnectionDirty();
		this.updateHopButtons();
		this.rebuildPoolWidget();
		this.refreshServerList();
	},

	updateRotationAvailability: function() {
		var fixed = this._serverChosen;
		if (this.rotEnable) {
			this.rotEnable.disabled = !!fixed;
			if (fixed && this.rotEnable.checked) {
				this.rotEnable.checked = false;
				this.markDirty();
			}
		}
		if (this.rotFixedNote)
			this.rotFixedNote.classList.toggle('hidden', !fixed);
		// With a pinned server there are no candidates to try.
		if (this.maxRetriesRow)
			this.maxRetriesRow.classList.toggle('hidden', !!fixed);
		if (this.selRow)
			this.selRow.classList.toggle('hidden', !!fixed);
		// The watchdog never fires with a pinned server either.
		if (this.wdRow)
			this.wdRow.classList.toggle('hidden', !!fixed);
		var building = this._building;
		this._building = true;
		this.onRotationToggle();
		this._building = building;
	},

	onRotationToggle: function() {
		this.markDirty();
		var on = this.rotEnable && this.rotEnable.checked && !this._serverChosen;
		var timeMode = this.rotModeTime && this.rotModeTime.checked;
		if (this.rotModeRow) this.rotModeRow.classList.toggle('hidden', !on);
		if (this.rotIntervalRow) this.rotIntervalRow.classList.toggle('hidden', !on || timeMode);
		if (this.rotTimeRow) this.rotTimeRow.classList.toggle('hidden', !on || !timeMode);
		if (this.rotNextRow) this.rotNextRow.classList.toggle('hidden', !on);
	},

	/* ---- dirty / save / discard --------------------------------------- */

	// Persisted values and editable values have separate lifetimes. Keep the
	// existing picker fields as widget adapters, never as RPC response targets.
	ensureConnectionState: function() {
		if (this._connectionState && this._connectionState.instance === this.instance)
			return this._connectionState;
		var loc = uci.get('nordvpn', this.instance, 'locations') || [];
		if (typeof loc === 'string') loc = [ loc ];
		if (!Array.isArray(loc)) loc = [];
		if (!loc.length) {
			var legacy = uci.get('nordvpn', this.instance, 'city_code') || uci.get('nordvpn', this.instance, 'country_code');
			if (legacy) loc = [ legacy ];
		}
		var baseline = {
			fixed_server: uci.get('nordvpn', this.instance, 'fixed_server') || '',
			locations: loc.slice(),
			hop_mode: uci.get('nordvpn', this.instance, 'hop_mode') || 'single',
			server_group: uci.get('nordvpn', this.instance, 'server_group') || ''
		};
		this._connectionState = { instance: this.instance, baseline: baseline,
			draft: JSON.parse(JSON.stringify(baseline)) };
		return this._connectionState;
	},

	markConnectionDirty: function() {
		if (this._building) return;
		var state = this.ensureConnectionState();
		state.draft = { fixed_server: this._serverChosen || '',
			locations: (this.poolEntries || []).map(function(e) { return e.code; }),
			hop_mode: this.hopMode(), server_group: this.serverGroup() };
		this._editGeneration = (this._editGeneration || 0) + 1;
		this.updateDirty();
	},

	updateDirty: function() {
		var state = this._connectionState;
		var comparable = function(value) {
			return JSON.stringify([ value.fixed_server, value.locations.slice().sort(), value.hop_mode, value.server_group ]);
		};
		this.dirty = !!this._otherDirty || !!(state && comparable(state.draft) !== comparable(state.baseline));
		if (this.saveBtn) this.saveBtn.disabled = !!this._saving || !this.dirty;
		if (this.discardBtn) this.discardBtn.disabled = !!this._saving || !this.dirty;
	},

	markDirty: function() {
		if (this._building) return;
		this._otherDirty = true;
		this._otherEditGeneration = (this._otherEditGeneration || 0) + 1;
		this._editGeneration = (this._editGeneration || 0) + 1;
		this.updateDirty();
	},

	discard: function() {
		this.srvCancelFilter();
		// Invalidate synchronously: an already pending response cannot restore
		// an edit while the config load below is still outstanding.
		this._serversReq = (this._serversReq || 0) + 1;
		this._formGeneration = (this._formGeneration || 0) + 1;
		var instance = this.instance, generation = this._formGeneration, edits = this._editGeneration;
		return uci.load('nordvpn').then(L.bind(function() {
			if (instance !== this.instance || generation !== this._formGeneration || edits !== this._editGeneration) return;
			this._connectionState = null;
			this._otherDirty = false;
			dom.content(this.formNode, this.buildFormSections());
			this.updateDirty();
		}, this));
	},

	collectIntoUci: function() {
		var inst = this.instance;
		var setv = function(o, v, section) {
			var sec = section || inst;
			if (v == null || v === '')
				uci.unset('nordvpn', sec, o);
			else
				uci.set('nordvpn', sec, o, v);
		};
		[ 'interface', 'routing_table', 'verify_timeout', 'max_retries', 'mtu' ].forEach(L.bind(function(k) {
			if (this.refs[k]) setv(k, (this.refs[k].value || '').trim());
		}, this));
		// The cache directory is shared and lives on the 'main' section.
		if (this.refs.cache_dir)
			setv('cache_dir', (this.refs.cache_dir.value || '').trim(), 'main');

		if (this.credSel)
			setv('credential', this.credSel.value === 'default' ? '' : this.credSel.value);
		setv('hop_mode', this.hopMode());
		setv('server_group', this.serverGroup());
		if (this.selSel)
			setv('selection', this.selSel.value === 'balanced' ? '' : this.selSel.value);

		// The location set is the single source of truth; the legacy
		// country/city options are cleared so both paths agree.
		var codes = (this.poolEntries || []).map(function(e) { return e.code; });
		if (codes.length)
			uci.set('nordvpn', inst, 'locations', codes);
		else
			uci.unset('nordvpn', inst, 'locations');
		uci.unset('nordvpn', inst, 'country_code');
		uci.unset('nordvpn', inst, 'city_code');

		var fixed = this._serverChosen || '';
		setv('fixed_server', fixed);

		// Routing toggles exist only when no manual scheme was detected; a
		// manual setup's options are never written.
		if (this.autoRouting) {
			var autoOn = this.autoRouting.checked;
			var steered = autoOn ? [] : this.steeredNetworks();
			var devices = autoOn ? [] : this.steeredDevices();
			uci.set('nordvpn', inst, 'auto_routing', autoOn ? '1' : '0');
			uci.set('nordvpn', inst, 'killswitch', (this.ksBox && this.ksBox.checked) ? '1' : '0');
			uci.set('nordvpn', inst, 'block_ipv6', (this.v6Box && this.v6Box.checked) ? '1' : '0');
			uci.set('nordvpn', inst, 'vpn_masq', (this.masqBox && this.masqBox.checked) ? '1' : '0');
			var dnsVal = (this.dnsSel && this.dnsSel.value) || 'off';
			var customList = (dnsVal === 'custom' && this.dnsCustom)
				? this.dnsCustom.value.split(/[\s,]+/).filter(function(x) {
					return /^(\d{1,3}\.){3}\d{1,3}$/.test(x) && x.split('.').every(function(o) { return +o <= 255; });
				}).slice(0, 4) : [];
			if (dnsVal === 'custom' && !customList.length)
				dnsVal = 'off';
			uci.set('nordvpn', inst, 'vpn_dns', dnsVal);
			if (customList.length)
				uci.set('nordvpn', inst, 'custom_dns', customList);
			else
				uci.unset('nordvpn', inst, 'custom_dns');
			// Drop the legacy boolean so it cannot contradict the enum.
			uci.unset('nordvpn', inst, 'use_vpn_dns');
			if (devices.length)
				uci.set('nordvpn', inst, 'source_device', devices);
			else
				uci.unset('nordvpn', inst, 'source_device');
			if (steered.length)
				uci.set('nordvpn', inst, 'source_network', steered);
			else
				uci.unset('nordvpn', inst, 'source_network');
			var ips = autoOn ? [] : this.steeredIps();
			if (ips.length)
				uci.set('nordvpn', inst, 'steer_ip', ips);
			else if (this.domEds.steer)
				uci.unset('nordvpn', inst, 'steer_ip');
			var bypIps = this.excludedIps();
			if (bypIps.length)
				uci.set('nordvpn', inst, 'bypass_ip', bypIps);
			else if (this.domEds.bypass)
				uci.unset('nordvpn', inst, 'bypass_ip');
			var domains = autoOn ? [] : this.steeredDomains();
			if (domains.length)
				uci.set('nordvpn', inst, 'steer_domain', domains);
			else if (this.domEds.steer)
				uci.unset('nordvpn', inst, 'steer_domain');
			// Exceptions. With "Route all LAN traffic" the backend supplies a
			// routing table itself (the interface name) and drops it again once
			// the list is empty, so none is written here for that case.
			var bypDevs = this.pickedDevices('bypass');
			if (bypDevs.length)
				uci.set('nordvpn', inst, 'bypass_device', bypDevs);
			else
				uci.unset('nordvpn', inst, 'bypass_device');
			var bypDoms = this.excludedDomains();
			if (bypDoms.length)
				uci.set('nordvpn', inst, 'bypass_domain', bypDoms);
			else if (this.domEds.bypass)
				uci.unset('nordvpn', inst, 'bypass_domain');
			if (steered.length || devices.length || domains.length || ips.length) {
				// Steering needs a routing table; default to the interface name.
				var rtb = this.refs.routing_table ? (this.refs.routing_table.value || '').trim()
					: (uci.get('nordvpn', inst, 'routing_table') || '');
				if (!rtb) {
					var ifn = this.refs.interface ? (this.refs.interface.value || '').trim() : '';
					ifn = ifn || uci.get('nordvpn', inst, 'interface') || 'nordvpn';
					uci.set('nordvpn', inst, 'routing_table', ifn);
					if (this.refs.routing_table)
						this.refs.routing_table.value = ifn;
				}
			}
		}

		var rotOn = this.rotEnable && this.rotEnable.checked && !fixed;
		uci.set('nordvpn', inst, 'rotation_enabled', rotOn ? '1' : '0');
		if (rotOn) {
			var timeMode = this.rotModeTime && this.rotModeTime.checked;
			setv('rotation_mode', timeMode ? 'time' : 'interval');
			setv('rotation_interval', this.rotInterval ? this.rotInterval.value : '360');
			setv('rotation_time', this.rotTime ? this.rotTime.value : '04:30');
		}

		// Written unconditionally (not tied to the routing block); the backend
		// ignores it while a server is pinned.
		uci.set('nordvpn', inst, 'watchdog', (this.wdBox && this.wdBox.checked) ? '1' : '0');

		// The probe also feeds the status page, so it is independent of the
		// watchdog and of a pinned server.
		uci.set('nordvpn', inst, 'egress_probe', (this.probeBox && this.probeBox.checked) ? '1' : '0');
		var targets = this.probeTargetList();
		if (targets.length)
			uci.set('nordvpn', inst, 'probe_target', targets);
		else
			uci.unset('nordvpn', inst, 'probe_target');
	},

	probeTargetList: function() {
		var el = this.refs.probe_target;
		return el ? (el.value || '').split(/[\s,]+/).filter(Boolean) : [];
	},

	// The instance's options as committed (plus the shared cache directory),
	// taken before collectIntoUci() so save() can tell what the form changed.
	// Empty values and the backend defaults the form writes back as "unset"
	// are left out, so the shipped `option routing_table ''` style entries do
	// not read as changes on the first save.
	optionSnapshot: function() {
		var sec = uci.get('nordvpn', this.instance) || {}, snap = {};
		var put = function(k, v) {
			if (v == null || v === '' || (Array.isArray(v) && !v.length) || OPTION_DEFAULTS[k] === v)
				return;
			snap[k] = JSON.stringify(v);
		};
		Object.keys(sec).forEach(function(k) {
			if (k.charAt(0) !== '.')
				put(k, sec[k]);
		});
		put('main.cache_dir', uci.get('nordvpn', 'main', 'cache_dir'));
		return snap;
	},

	// True when every option that differs between two snapshots is one the
	// tunnel can take without reconnecting.
	routingOnlyChange: function(before, after) {
		var keys = Object.keys(before).concat(Object.keys(after));
		return keys.every(function(k) {
			return before[k] === after[k] || NO_RECONNECT_OPTS.indexOf(k) >= 0;
		});
	},

	// Resolves with the same shape applyAsync() does. Tries the routing-only
	// update first when the change allows it; the backend still refuses (and
	// this falls back to a full apply) when the tunnel is not up with matching
	// interface settings, e.g. the instance was disabled.
	applySaved: function(routingOnly, p, instance) {
		instance = instance || this.instance;
		if (!routingOnly) {
			this.dismiss(p);
			p = this.notice(_('Applying and reconnecting…'), 'info');
			return this.applyAsync(instance, 'save').then(L.bind(function(res) {
				this.dismiss(p);
				return res;
			}, this), L.bind(function(e) {
				this.dismiss(p);
				throw e;
			}, this));
		}
		this.dismiss(p);
		p = this.notice(_('Applying routing changes…'), 'info');
		return callApplyRouting(instance).then(L.bind(function(res) {
			if (res && res.needs_reconnect)
				return this.applySaved(false, p, instance);
			this.dismiss(p);
			return this.operationResult(res || { error: _('no response') }, instance);
		}, this), L.bind(function(e) {
			this.dismiss(p);
			throw e;
		}, this));
	},

	save: function() {
		if (this._saving) return Promise.resolve();
		// Require at least one location valid for the current hop mode; entries
		// carried over from another mode (count null) do not count.
		var validCount = (this.poolEntries || []).filter(function(e) { return e.count != null; }).length;
		if (!validCount) {
			this.notice(_('Please add at least one country or city for this hop mode.'), 'error');
			return Promise.resolve();
		}
		var badTarget = this.probeTargetList().filter(function(t) { return !IPV4_RE.test(t); })[0];
		if (badTarget) {
			this.notice(_('Internet check target "%s" is not an IPv4 address.').format(badTarget), 'error');
			return Promise.resolve();
		}
		var instance = this.instance, state = this.ensureConnectionState();
		var form = this._formGeneration, edits = this._editGeneration, otherEdits = this._otherEditGeneration;
		var savedDraft = JSON.parse(JSON.stringify(state.draft));
		var previous = JSON.parse(JSON.stringify(uci.get('nordvpn', instance) || {}));
		var previousCache = uci.get('nordvpn', 'main', 'cache_dir');
		var committed = false, disabled = this.status && this.status.enabled === false;
		var active = L.bind(function() {
			return this.instance === instance && this._formGeneration === form && this._connectionState === state;
		}, this);
		var before = this.optionSnapshot();
		this.collectIntoUci();
		var staged = JSON.parse(JSON.stringify(uci.get('nordvpn', instance) || {}));
		var stagedCache = uci.get('nordvpn', 'main', 'cache_dir');
		var routingOnly = this.routingOnlyChange(before, this.optionSnapshot());
		this._saving = true;
		this.saveBtn.disabled = true;
		this.discardBtn.disabled = true;
		var p = this.notice(_('Saving configuration…'), 'info');

		return uci.save()
			.then(function() { return callUciCommit('nordvpn'); })
			.then(L.bind(function() {
				committed = true;
				if (active()) {
					state.baseline = savedDraft;
					if (otherEdits === this._otherEditGeneration) this._otherDirty = false;
					this.updateDirty();
				}
				this.clearChangeIndicator();
				var q = p;
				p = null;
				// Saving options on a disabled instance must not turn its tunnel back on.
				if (disabled) {
					this.dismiss(q);
					return { saved_disabled: true };
				}
				return this.applySaved(routingOnly, q, instance);
			}, this))
			.then(L.bind(function(res) {
				if (res && res.error)
					this.notice(_('Apply failed: %s').format(res.error), 'error');
				else if (res && res.routing_only)
					this.notice(_('Settings applied without reconnecting.'), 'info', 4000);
				else if (res && res.saved_disabled)
					this.notice(_('Settings saved. The VPN remains disabled.'), 'info', 4000);
				else if (res && res.state === 'disabled')
					this.notice(_('Settings saved. The VPN remains disabled.'), 'info', 4000);
				else if (res && res.state === 'success' && res.restarted === false)
					this.notice(_('Settings applied; still connected to %s without reconnecting.').format(res.gateway || ''), 'info', 4000);
				else if (res && res.state === 'success')
					this.notice(_('Connected to %s').format(res.gateway || ''), 'info', 4000);
				else if (res && res.state === 'partial_failure')
					this.notice(_('Configuration saved, but the server did not respond.'), 'error');
				else
					this.notice(_('Could not connect: %s').format((res && res.error) || _('unknown error')), 'error');
				// Rebuild the form, not just the status band: a saved change may
				// have flipped the detected routing mode (e.g. clearing the table
				// leaves manual), and the panel's shape depends on it.
				if (!active()) return;
				return this.refreshStatus().then(L.bind(function() {
					if (active() && !this.dirty && edits === this._editGeneration)
						dom.content(this.formNode, this.buildFormSections());
				}, this));
			}, this))
			.catch(L.bind(function(e) {
				this.dismiss(p);
				if (!committed) {
					// Undo only this save's staging, and only while the value is
					// still ours. Other actions may have loaded, changed or deleted
					// the instance while this request was pending.
					var equal = function(a, b) { return JSON.stringify(a) === JSON.stringify(b); };
					var current = uci.get('nordvpn', instance);
					if (current) {
						Object.keys(previous).concat(Object.keys(staged)).forEach(function(k) {
							if (k.charAt(0) === '.' || equal(previous[k], staged[k]) || !equal(current[k], staged[k])) return;
							if (previous[k] == null) uci.unset('nordvpn', instance, k);
							else uci.set('nordvpn', instance, k, previous[k]);
						});
					}
					if (uci.get('nordvpn', 'main') && !equal(previousCache, stagedCache) &&
					    equal(uci.get('nordvpn', 'main', 'cache_dir'), stagedCache)) {
						if (previousCache == null) uci.unset('nordvpn', 'main', 'cache_dir');
						else uci.set('nordvpn', 'main', 'cache_dir', previousCache);
					}
				}
				this.notice(_('Save failed: %s').format(e), 'error');
			}, this)).finally(L.bind(function() {
				this._saving = false;
				this.updateDirty();
			}, this));
	},

	/* ---- credentials -------------------------------------------------- */

	// Add a named set (`entry` null) or replace the token of `entry`.
	showCredentialModal: function(entry) {
		// LuCI's password Textfield renders the input with an inline reveal
		// button in one control-group row.
		var field = new ui.Textfield('', {
			password: true,
			placeholder: _('64-character hexadecimal token')
		});
		var nameInput = entry ? null : E('input', { type: 'text', class: 'cbi-input-text', maxlength: 32,
			placeholder: _('Name, e.g. Family plan') });
		var err = E('div', { class: 'cbi-value-description', style: 'color:var(--error-color,#c0392b)' });

		ui.showModal(entry ? _('Credentials "%s"').format(entry.name) : _('Add credentials'), [
			E('p', {}, _('Paste your 64-character NordVPN access token. It is used once to derive the WireGuard private key and is never stored or shown again.')),
			(entry && entry.instances && entry.instances.length)
				? E('p', {}, _('Used by: %s. Their tunnels switch to the new key.').format(entry.instances.join(', '))) : '',
			nameInput ? E('div', { class: 'cbi-value' }, [ nameInput ]) : '',
			E('div', { class: 'cbi-value nv-token-field' }, [ field.render() ]),
			err,
			E('div', { class: 'right' }, [
				E('button', { class: 'cbi-button', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', { class: 'cbi-button cbi-button-action', click: L.bind(this.submitCredentials, this, entry, nameInput, field, err) }, _('Save credentials'))
			])
		]);
	},

	showClearCredentialsModal: function(entry) {
		var isDefault = (entry.id === 'default');
		var used = (entry.instances || []).join(', ');
		ui.showModal(isDefault ? _('Remove the Default key?') : _('Remove credentials "%s"?').format(entry.name), [
			E('p', {}, isDefault
				? _('The stored WireGuard key is deleted and every instance using Default goes down (%s). Their settings are kept; set a new token to reconnect.').format(used || _('none'))
				: (used
					? _('These credentials are still used by %s. Switch those instances to other credentials first.').format(used)
					: _('The stored WireGuard key and its name are deleted.'))),
			E('div', { class: 'right' }, [
				E('button', { class: 'cbi-button', click: ui.hideModal }, _('Cancel')),
				' ',
				(!isDefault && used) ? '' : E('button', { class: 'cbi-button cbi-button-negative', click: L.bind(this.clearCredentials, this, entry) }, _('Remove'))
			])
		]);
	},

	clearCredentials: function(entry) {
		ui.hideModal();
		var n = this.notice(_('Removing credentials…'), 'info');
		return callRemoveCredentials(entry.id).then(L.bind(function(res) {
			this.dismiss(n);
			if (res && res.error) {
				this.notice(_('Failed: %s').format(res.error), 'error');
				return;
			}
			this.notice(_('Credentials removed.'), 'info', 4000);
			return this.afterCredentialChange();
		}, this)).catch(L.bind(function(e) {
			this.dismiss(n);
			this.notice(_('Failed: %s').format(e), 'error');
		}, this));
	},

	submitCredentials: function(entry, nameInput, field, err, ev) {
		var name = nameInput ? (nameInput.value || '').trim() : '';
		if (nameInput && !name) {
			dom.content(err, _('Enter a name for these credentials.'));
			return;
		}
		var token = (field.getValue() || '').trim();
		if (!token.match(/^[0-9a-fA-F]{64}$/)) {
			dom.content(err, _('Enter a valid 64-character hexadecimal token.'));
			return;
		}
		var btn = ev.target;
		btn.disabled = true;
		dom.content(err, _('Verifying…'));
		return callSetCredentials(token, '', entry ? entry.id : '', name).then(L.bind(function(res) {
			if (res && res.error) {
				btn.disabled = false;
				dom.content(err, [ res.error ]);
				return;
			}
			ui.hideModal();
			this.notice(_('Credentials "%s" saved.').format(res.name || name), 'info');
			return this.afterCredentialChange();
		}, this)).catch(function(e) {
			btn.disabled = false;
			dom.content(err, [ '' + e ]);
		});
	},

	// A bank change can flip several instances' state; refresh everything
	// that shows it. The form is rebuilt only when it has no unsaved edits.
	afterCredentialChange: function() {
		return this.refreshCredentials().then(L.bind(function() {
			return this.refreshStatus();
		}, this)).then(L.bind(function() {
			if (!this.dirty && !this._saving)
				dom.content(this.formNode, this.buildFormSections());
		}, this));
	},

	/* ---- cache -------------------------------------------------------- */

	refreshCache: function(ev) {
		var btn = ev.target;
		btn.disabled = true;
		dom.content(this.cacheRow, _('Refreshing…'));
		return callRefreshLocations().then(L.bind(function(result) {
			if (result && result.error) throw new Error(result.error);
			this._cacheJob = result && result.job;
			this._cachePoll = L.bind(this.pollCacheOnce, this, btn);
			poll.add(this._cachePoll, 2);
		}, this)).catch(L.bind(function(e) {
			btn.disabled = false;
			dom.content(this.cacheRow, [ _('Refresh failed: %s').format(e), ' · ', this.cacheSummary() ]);
			this.notice(_('Refresh failed: %s').format(e), 'error');
		}, this));
	},

	pollCacheOnce: function(btn) {
		return callRefreshStatus(this._cacheJob || '').then(L.bind(function(st) {
			if (this._cacheJob && st && st.id && st.id !== this._cacheJob) return;
			var state = st ? st.state : 'idle';
			if (state === 'running') {
				dom.content(this.cacheRow, [ _('Loading… %d servers so far').format((st && st.gateways) || 0), ' · ', this.cacheSummary() ]);
				return;
			}
			poll.remove(this._cachePoll);
			btn.disabled = false;
			var error = state !== 'done';
			var message = error ? _('Refresh failed: %s').format((st && (st.message || st.error)) || _('refresh completion is unavailable')) : '';
			// Render the terminal result immediately: a failed locations read
			// must not hide it or remove the previous usable-cache context.
			dom.content(this.cacheRow, [ message ? message + ' · ' : '', this.cacheSummary() ]);
			if (error) this.notice(message, 'error');
			return callLocations().then(L.bind(function(loc) {
				this.locations = loc || { available: false };
				dom.content(this.cacheRow, [ message ? message + ' · ' : '', this.cacheSummary() ]);
				this.rebuildPoolWidget();
				this.refreshServerList();
			}, this)).catch(L.bind(function(e) {
				var readError = _('Could not read server list: %s').format(e);
				dom.content(this.cacheRow, [ message ? message + ' · ' : '', readError, ' · ', this.cacheSummary() ]);
				this.notice(readError, 'error');
			}, this));
		}, this));
	},

	/* ---- helpers ------------------------------------------------------ */

	notice: function(text, kind, timeout) {
		var node = ui.addNotification(null, E('p', {}, text), kind || 'info');
		if (timeout)
			setTimeout(L.bind(this.dismiss, this, node), timeout);
		return node;
	},

	dismiss: function(node) {
		try {
			if (node && node.parentNode)
				node.parentNode.removeChild(node);
		} catch (e) {}
	},

	// Our custom save commits directly (the framework's apply would reload the
	// page and abort the reconnect), so refresh the global "Unsaved Changes"
	// indicator ourselves once our commit has gone through. Re-read rather
	// than zeroed: changes staged on other pages are still pending.
	clearChangeIndicator: function() {
		try {
			if (L.ui && L.ui.changes)
				Promise.resolve(L.ui.changes.init()).catch(function() {});
		} catch (e) {}
	}
});
