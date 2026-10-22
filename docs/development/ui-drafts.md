# Editable connection drafts

The overview view keeps a persisted connection baseline separate from its editable
draft and fetched server data. The existing pin, location, hop and group widgets
feed the draft; UCI collection still uses those widgets, so the displayed pin is
the pin that is saved. Unavailable pins remain visible and require an explicit
clear action. Returning connection values to the baseline clears connection dirty
state; ordinary form edits continue to participate in dirty tracking.

Initial load, confirmed instance changes and explicit discard initialize the
connection state. Rebuilding a clean form preserves its connection draft. Server
requests carry the instance, form generation and monotonically increasing query
generation; obsolete successes and errors are ignored. Current errors provide a
retry button. Discard invalidates pending responses before loading configuration.

Save captures its instance, form generation and draft. A successful commit makes
that snapshot the baseline without replacing later edits. A later apply or status
refresh cannot rebuild a dirty form, including ordinary routing/advanced inputs.
Failed saves preserve the draft and restore only this save's changed local UCI
values that still match its staged values, without recreating deleted sections.
Unrelated or newer configuration changes are preserved. Scheduled rotation being unchecked by a pin is
tracked as an ordinary edit, including when the temporary pin is subsequently
cleared. Apply callbacks retain the saved instance identity, including routing
fallback and routing-confirmation results.

Validation:

- `node luci-app-nordvpn/tests/overview.test.js`
- `node_modules/.bin/eslint luci-app-nordvpn`
- `node --check luci-app-nordvpn/htdocs/luci-static/resources/view/nordvpn/overview.js`
- `git diff --check`

The first focused deferred-response test fails against the previous view
(`eca3f86`): a new pin becomes the persisted pin when the initial list completes.
The VM suite executes production form, picker, UCI-collection, save, discard and
status callbacks, with deferred server, commit, configuration and status reads.
It covers pin selection/clearing, location/hop/group changes, unavailable pins,
retryable errors, obsolete successes/errors, discard, instance changes, failed
saves, edits during save and cache refresh, and nonconnection edits.

No live OpenWrt/LuCI device was available. DOM, RPC and UCI services are mocked;
actual browser focus/layout, rpcd/UCI commit failures and device interaction still
need device validation. Drafts live for the current view, not across page reloads.
Server indexing, pagination and performance measurements belong to plan 9.
