# Routing plans, execution and confirmation

Routing enforcement now builds desired state in a detached cursor. `enforce()`
changes only that cursor and its in-memory routing-table registry. It does not
commit, reload, or write `/etc/iproute2/rt_tables`. `routing_plan()` returns
section additions, option updates, section deletions, touched packages and
ordered reloads. The planner runs under `mutation.configuration()` with a fresh
UCI cursor; per-instance ownership still spans the complete operation.

`routing_transaction.execute()` stages and checks every required UCI mutation
and package commit before runtime reloads. Firewall reload precedes network and
DNS reloads, so nft sets exist before dnsmasq uses them. Required command exits,
element restoration, and runtime installation checks must all succeed. The
runtime adapters are explicit dependencies; missing router tools never mean
success. A missing `wg` also fails handshake verification.

An unchanged routing apply performs installation checks without committing or
reloading packages. An explicit reconnect still runs `ifup` when the selected
peer/configuration is unchanged. Interface activation records actual prior
netifd state; autostart `auto=0` is not used as evidence of runtime state. Delete
runs required `ifdown` before removing the interface configuration, while netifd
still knows the interface. Successful empty `ubus list` distinguishes an absent
interface from unavailable ubus.

## Results and callers

The execution result contains:

- `ok`: all required steps completed and installation was confirmed.
- `changed`: the desired plan has configuration or registry changes; explicit
  activation can run with `changed: false`.
- `stage`: `unchanged`, `complete`, or the failing step, such as
  `commit:network`, `reload:firewall`, `ifdown:nv_media`, `verify:runtime`, or a
  confirmation-record publication stage.
- `error`: legacy RPC-compatible error text, including the failed stage and
  any incomplete restoration. `original_error` retains the first failure.
- `rollback`: null or `{ ok, errors, runtime_attempted }`. Restoration failures
  do not replace the original stage/error.

Routing-only apply, full apply preparation, disable and delete/reset consume
these results. Full apply and rotation also consume structured peer commit and
activation results. The legacy internal `connect_one()` boolean wrapper remains
available; current application/rotation code uses `connect_one_result()`.
Success history is written only after the corresponding operation succeeds.
Failed connection restoration no longer reports `restored: true` just because
a peer snapshot existed. Full apply's routing preparation and later candidate
connection attempts are separate transactions: verified routing protections can
remain installed when no server completes a handshake.

## Scoped restoration and ordering

Each changed section retains its prior type, existence, values and position.
Existing sections restore only changed options; independent options on the same
section and independent sections/packages survive rollback. Additions are
removed. Deleted anonymous sections are recreated with native `cursor.add()` and
moved with native `cursor.reorder()` in ascending prior position. This restores
firewall rule precedence; anonymous section IDs can change. Unknown external
references to those generated IDs are not rewritten. A cursor without section
reordering is rejected before a plan that deletes sections can execute.

The registry writer checks full writes, close and rename. Registry publication
and rollback merge only the plan's exact managed-line delta into the current
file, preserving unrelated registrations, comments and blank lines. Conflicting
IDs/names fail explicitly. This is scoped compensation, not an atomic operation
across UCI packages, files and kernel state. Non-cooperating external writers can
still race libuci commits; all package writers should honor the shared lock.

The affected instance's previous domain-set elements are captured before a
firewall reload, including sets needed only for rollback. Successful execution
restores only the existing eligibility list from enforcement. Whole-firewall
preservation for unchanged sets belonging to other instances remains plan 3.

## Runtime checks and durable uncertainty

Verification uses a three-second monotonic budget per confirmation pass, at
most twelve attempts, one-second subprocess deadlines, and 250 ms pauses.
Reload/activation commands have fifteen-second deadlines. Checks inspect netifd
logical-to-device mappings, installed IPv4/IPv6 policy/prohibit rules, routed
defaults for already-up managed tunnels, nft rule actions/marks/selectors and
sets, and generated configuration belonging to a running dnsmasq instance.
Initial full apply does not require a default route from a tunnel that has not
been brought up. Activation checks the requested up/down state and a managed
tunnel's installed default route before handshake verification begins.

A checked atomic `/tmp/nordvpn_routing_<instance>.json` record is published as
pending **before** mutations. If that write fails, execution stops. Terminal
publication failure leaves pending state unconfirmed. Records contain only the
stage/error/restoration summary and a compact generation of routing preferences;
they contain no keys or configuration snapshots. The generation detects saved
routing preferences that have not been applied; it is not an authentication
hash. Peer-only transactions preserve prior routing confirmation rather than
certifying unapplied preferences.

`status`/`instances` add `routing_application.confirmed`, `stage`, `error` and
`rollback`. Existing routing flags still describe configured objects. Clients
must use confirmation before claiming those policies were installed. The LuCI
view suppresses active DNS/kill-switch claims after an unconfirmed application,
including in a new browser tab or after a page reload. Missing records (including
a reboot, since `/tmp` is volatile) are conservatively unconfirmed until Apply
verifies installation again. Confirmation describes the last verified apply;
it is not continuous monitoring of later external kernel changes.

## Validation and device limits

`test_routing_transaction.uc` injects failure at every package commit, reload,
restoration commit/reload, routing-table write/restoration, activation, runtime
confirmation and confirmation publication. It covers persisted package images,
insufficient storage, scoped unrelated edits, anonymous precedence, unchanged
plans, reconnect without config changes, legacy RPC error fields, missing
WireGuard and fresh-cursor confirmation. Production runtime predicates have
fixtures for policy rules, prohibit rules, metadata-only changes, equivalent
retained rules and wrong-instance firewall marks. Legacy semantic fixtures use
an explicit offline adapter. LuCI tests cover structured failures and warnings
surviving a fresh view.

No OpenWrt router was available. Before release, test supported firmware with
multiple tunnels, down/disabled interfaces, kill switches, domain steering and
bypass, VPN/custom DNS, forced storage/reload errors and interrupted workers.
Verify real traffic paths and DNS behavior after success, compensated failure
and failed compensation. Confirm busybox timeout/netifd/fw4/dnsmasq output and
convergence timing on each supported release. The checks prove observed
installation, not atomic traffic continuity or external resolver reachability.
No router latency or throughput improvement is claimed.
