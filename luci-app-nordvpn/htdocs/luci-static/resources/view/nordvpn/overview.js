Warning: truncated output (original token count: 35116)
Total output lines: 3245

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
var callRefreshStatus = rpc.declare({ object: 'nordvpn', method: 'refresh_status' });
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
var callApplyStatus = rpc.declare({ object: 'nordvpn', method: 'apply_status' });
// Routing-only apply: reconciles the steering/exception rules without touching
// the tunnel. Quick (no handshake wait), so it is a plain call.
var callApplyRouting = rpc.declare({ object: 'nordvpn', method: 'apply_routing', params: [ 'instance' ] });
var callRefreshLocations = rpc.declare({ object: 'nordvpn', method: 'refresh_locations' });
// A manual rotation tries up to max_retries servers at verify_timeout each, so
// it runs as a job exactly like an apply (see callApplyStart) and is watched
// through apply_status. `rotate_now` stays in the backend for the CLI only.
var callRotateStart = rpc.declare({ object: 'nordvpn', method: 'rotate_start', params: [ 'instance' ] });
var callExternalIp = rpc.declare({ object: 'nordvpn', method: 'external_ip', params: [ 'instance' ] });
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
		var credSel = (creds.lengt…23116 tokens truncated…rvOpen = false;
		if (this.srvPanel) this.srvPanel.classList.add('hidden');
		if (this.srvTrigger) this.srvTrigger.classList.remove('hidden');
	},

	srvSetChosen: function(host) {
		this._serverChosen = host || '';
		this.markDirty();
		this.updateRotationAvailability();
		this.srvRenderTrigger();
		this.srvClosePanel();
	},

	// Panel: header + filter, quick "Automatic" and "Lowest load" rows, then
	// servers grouped by country and sorted by load (lowest first).
	srvRenderPanel: function() {
		var panel = this.srvPanel;
		if (!panel)
			return;
		dom.content(panel, '');
		panel.appendChild(E('div', { class: 'nv-pool-head' }, [
			E('span', {}, _('Pick a server')),
			E('button', { type: 'button', class: 'nv-pool-x', title: _('Close'),
				click: L.bind(function(ev) { ev.stopPropagation(); this.srvClosePanel(); }, this) }, '✕')
		]));
		var filt = E('input', { type: 'text', class: 'cbi-input-text nv-pool-filter',
			placeholder: _('Filter servers') + '…', value: this._srvFilter });
		filt.addEventListener('input', L.bind(function() {
			this._srvFilter = filt.value;
			this.srvRenderList();
		}, this));
		filt.addEventListener('click', function(ev) { ev.stopPropagation(); });
		panel.appendChild(filt);
		this._srvListEl = E('div', {});
		panel.appendChild(this._srvListEl);
		this.srvRenderList();
		setTimeout(function() { try { filt.focus(); } catch (e) {} }, 0);
	},

	srvRenderList: function() {
		var el = this._srvListEl;
		if (!el)
			return;
		dom.content(el, '');
		var names = this._ccNames || {};
		var chosen = this._serverChosen;
		var current = this.srvCurrentGateway();
		var f = (this._srvFilter || '').toLowerCase();

		el.appendChild(E('div', { class: 'nv-pool-row nv-srv-quick',
			click: L.bind(function(ev) { ev.stopPropagation(); this.srvSetChosen(''); }, this) }, [
				E('span', { class: 'box' }, chosen ? '' : '☑'),
				E('span', { class: 'grow' }, _('Automatic (rotation picks)'))
			]));
		var best = this.srvLowestLoad();
		if (best) {
			var bn = names[best.country_code] || (best.country_code || '').toUpperCase();
			el.appendChild(E('div', { class: 'nv-pool-row nv-srv-quick',
				click: L.bind(function(ev) { ev.stopPropagation(); this.srvSetChosen(best.hostname); }, this) }, [
					E('span', { class: 'box' }, '⚡'),
					E('span', { class: 'grow' }, _('Lowest load') + ' · ' + (best.city || bn) +
						(best.load != null ? ' (%d%%)'.format(best.load) : '')),
					E('span', { class: 'nv-dot ' + this.srvLoadClass(best.load) })
				]));
		}
		el.appendChild(E('div', { class: 'nv-pool-sep' }));

		var groups = [], byCode = {};
		((this._serverData && this._serverData.relays) || []).forEach(L.bind(function(r) {
			var cname = names[r.country_code] || (r.country_code || '').toUpperCase();
			var hay = (cname + ' / ' + (r.city || '') + ' / ' + (r.name || r.hostname)).toLowerCase();
			if (f && r.hostname !== chosen && hay.indexOf(f) < 0)
				return;
			var g = byCode[r.country_code];
			if (!g) {
				g = { name: cname, flag: this.countryFlag(r.country_code), rows: [] };
				byCode[r.country_code] = g;
				groups.push(g);
			}
			g.rows.push(r);
		}, this));
		groups.forEach(L.bind(function(g) {
			// Numeric-aware tiebreak on purpose: a plain string compare puts
			// de#1027 before de#95, which reads as broken when a whole page of
			// servers shares the same load — and at low load that is most of
			// them.
			g.rows.sort(function(a, b) {
				var al = typeof a.load === 'number' ? a.load : 999;
				var bl = typeof b.load === 'number' ? b.load : 999;
				if (al !== bl)
					return al - bl;
				return (a.name || a.hostname || '').localeCompare(
					b.name || b.hostname || '', undefined, { numeric: true });
			});
			el.appendChild(E('div', { class: 'nv-srv-grp' }, (g.flag ? g.flag + ' ' : '') +
				'%s (%d)'.format(g.name, g.rows.length)));
			g.rows.forEach(L.bind(function(r) {
				var isCur = current && r.hostname === current;
				var isPin = r.hostname === chosen;
				el.appendChild(E('div', { class: 'nv-pool-row' + (isPin ? ' is-in' : ''),
					click: L.bind(function(ev) { ev.stopPropagation(); this.srvSetChosen(r.hostname); }, this) }, [
						E('span', { class: 'nv-dot ' + this.srvLoadClass(r.load) }),
						E('span', { class: 'grow' }, '%s / %s'.format(r.city || '?', r.name || r.hostname)),
						r.p2p ? E('span', { class: 'nv-srv-tag' }, _('P2P')) : '',
						r.dedicated ? E('span', { class: 'nv-srv-tag', title: _('Only works for the account this Dedicated IP is assigned to') }, _('Dedicated IP')) : '',
						isCur ? E('span', { class: 'nv-srv-cur' }, '● ' + _('current')) : '',
						E('span', { class: 'nv-srv-load' }, r.load != null ? '%d%%'.format(r.load) : '')
					]));
			}, this));
		}, this));

		if (chosen && !this.srvRelayByHost(chosen))
			el.appendChild(E('div', { class: 'nv-pool-row is-in' }, chosen + ' ' + _('(not in the set)')));
		else if (!groups.length)
			el.appendChild(E('div', { class: 'nv-pool-row is-in' }, _('No matches')));
	},

	onHopChange: function() {
		this.markDirty();
		this.updateHopButtons();
		this.rebuildPoolWidget();
		this.refreshServerList();
	},

	updateRotationAvailability: function() {
		var fixed = this._serverChosen;
		if (this.rotEnable) {
			this.rotEnable.disabled = !!fixed;
			if (fixed)
				this.rotEnable.checked = false;
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
		this.onRotationToggle();
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

	markDirty: function() {
		if (this._building)
			return;
		this.dirty = true;
		if (this.saveBtn) this.saveBtn.disabled = false;
		if (this.discardBtn) this.discardBtn.disabled = false;
	},

	discard: function() {
		return uci.load('nordvpn').then(L.bind(function() {
			dom.content(this.formNode, this.buildFormSections());
			this.dirty = false;
			if (this.saveBtn) this.saveBtn.disabled = true;
			if (this.discardBtn) this.discardBtn.disabled = true;
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
	applySaved: function(routingOnly, p) {
		if (!routingOnly) {
			this.dismiss(p);
			p = this.notice(_('Applying and reconnecting…'), 'info');
			return this.applyAsync(this.instance, 'save').then(L.bind(function(res) {
				this.dismiss(p);
				return res;
			}, this), L.bind(function(e) {
				this.dismiss(p);
				throw e;
			}, this));
		}
		this.dismiss(p);
		p = this.notice(_('Applying routing changes…'), 'info');
		return callApplyRouting(this.instance).then(L.bind(function(res) {
			if (res && res.needs_reconnect)
				return this.applySaved(false, p);
			this.dismiss(p);
			return res || { error: _('no response') };
		}, this), L.bind(function(e) {
			this.dismiss(p);
			throw e;
		}, this));
	},

	save: function() {
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
		var before = this.optionSnapshot();
		this.collectIntoUci();
		var routingOnly = this.routingOnlyChange(before, this.optionSnapshot());
		this.saveBtn.disabled = true;
		this.discardBtn.disabled = true;
		var p = this.notice(_('Saving configuration…'), 'info');

		return uci.save()
			.then(function() { return callUciCommit('nordvpn'); })
			.then(L.bind(function() {
				this.dirty = false;
				this.clearChangeIndicator();
				var q = p;
				p = null;
				// Saving options on a disabled instance must not turn its tunnel back on.
				if (this.status && this.status.enabled === false) {
					this.dismiss(q);
					return { saved_disabled: true };
				}
				return this.applySaved(routingOnly, q);
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
				return this.refreshStatus().then(L.bind(function() {
					dom.content(this.formNode, this.buildFormSections());
				}, this));
			}, this))
			.catch(L.bind(function(e) {
				this.dismiss(p);
				this.notice(_('Save failed: %s').format(e), 'error');
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
			if (!this.dirty)
				dom.content(this.formNode, this.buildFormSections());
		}, this));
	},

	/* ---- cache -------------------------------------------------------- */

	refreshCache: function(ev) {
		var btn = ev.target;
		btn.disabled = true;
		dom.content(this.cacheRow, _('Refreshing…'));
		return callRefreshLocations().then(L.bind(function() {
			this._cachePoll = L.bind(this.pollCacheOnce, this, btn);
			poll.add(this._cachePoll, 2);
		}, this)).catch(L.bind(function(e) {
			btn.disabled = false;
			this.notice(_('Refresh failed: %s').format(e), 'error');
		}, this));
	},

	pollCacheOnce: function(btn) {
		return callRefreshStatus().then(L.bind(function(st) {
			var state = st ? st.state : 'idle';
			if (state === 'running') {
				dom.content(this.cacheRow, [ _('Loading… %d servers so far').format((st && st.gateways) || 0) ]);
				return;
			}
			poll.remove(this._cachePoll);
			btn.disabled = false;
			return callLocations().then(L.bind(function(loc) {
				this.locations = loc || { available: false };
				dom.content(this.cacheRow, [ this.cacheSummary() ]);
				this.rebuildPoolWidget();
				this.refreshServerList();
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
