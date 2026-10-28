# Mutation ownership

The backend coordinates configuration mutations through `nordvpn.mutation`.
This applies to RPC, detached CLI workers, scheduled rotation and watchdog
recovery, service credential migration, and the first-boot UCI migration.

## Lock contract

1. Acquire affected instance names in lexical order, deduplicated. Failed
   multi-instance acquisition releases every acquired descriptor before retry.
2. Acquire `/tmp/nordvpn_configuration.lock` for configuration reads, writes,
   commits, routing-table registration/removal and corresponding reloads.
   Open a new UCI cursor **after** acquiring this lock. Never commit a cursor
   retained from an earlier configuration scope.
3. Release shared configuration ownership before HTTP or handshake waits.
   Retain instance ownership until connection verification/rollback finishes.
   Release ownership on both normal and exceptional exits.

Instance files are `/tmp/nordvpn_operation_<instance>.lock`. They use
`fs.open(path, 'ae', 0600)` and `file.lock('xn')`: nonblocking exclusive
`flock`, with close-on-exec descriptors. Release closes the owning descriptor;
**never unlink these files while the backend is running**. File timestamps,
PID text, runtime ceilings and wall-clock changes cannot steal ownership.
The kernel releases ownership when the last owning descriptor closes, including
worker termination. A delayed or repeated release of an old token cannot
release a replacement owner's descriptor. The implementation fails closed
when this filesystem locking API is unavailable; it does not silently fall
back to age-based mutation locks.

Scheduler `uloop.task()` children close inherited advisory descriptors before
working, without explicitly unlocking the parent's shared file description.
Exec children close them automatically. New fork sites must follow this rule.

## Mutation inventory

| Entry point | Instance ownership | Shared scope |
| --- | --- | --- |
| Full apply / enable / reconnect / save | One, through verification and rollback | Credential sync, routing reconciliation, table registration, each peer write/ifup, rollback |
| Rotation: manual CLI/job, schedule, watchdog | One, through candidate verification and rollback | Each fresh peer write/ifup and rollback |
| Routing-only apply | One | Fresh settings, routing/table changes, commits and firewall/network/DNS reloads |
| Disable / disconnect | One | Enabled flag, routing release, auto flag, ifdown |
| Disable all | One at a time; attempts every instance | Each disable; response lists disabled instances and per-instance errors |
| Delete / reset main | One | Routing/table cleanup, ifdown, interface/peer/config deletion/reset |
| Create instance | New name | Revalidate name/interface/credential uniqueness, create config and sync key |
| Set / clear / remove credentials; explicit sync | All configured names, conservatively | Revalidate membership and users, bank changes, interface/peer sync/restarts |
| Credential-bank migration | All configured names | Bank/config migration; no HTTP |
| First-boot legacy UCI migration | All configured names | Shell migration reads, writes and commits run as one protected child |
| WAN default restoration | None: shared global runtime resource | Recheck and add route under shared lock; retry sleeps are outside it |

`connect_one()`, `restore_connection()`, `keep_running()`, `sync_instance()`,
`write_relay()`, `restore_peer()`, `commit_routing()` and routing `enforce()`
are lower-level helpers. Callers must own the affected instance(s).
`connect_one()`, `restore_connection()` and `keep_running()` open their own
shared scope. The remaining helpers operate on a cursor supplied from an
existing shared scope; they must not be used as uncoordinated entry points.

Credential fan-out acquires the complete configured set before shared
configuration, then rechecks membership; a concurrent creation/deletion causes
a bounded retry. A busy owner causes no bank or interface changes. Responses
add `succeeded` and per-instance `errors` for fan-out; busy responses identify
the blocking instance. A sync exception is reported per instance. Existing
public response fields remain. As before, unchecked command/commit return
values are a separate routing/result-contract refactor, so these lists do not
promise runtime convergence after a command reports failure.

RPC mutation paths return explicit busy errors without waiting for ownership.
Apply/rotation workers can wait up to 60 seconds for configuration ownership;
apply workers can also wait for an instance owner. Short operations return
busy immediately. A separately configured alias pointing two instances at the
same interface is rejected before tunnel mutations, since ownership by name
cannot safely distinguish such tunnels.

## Scope and compatibility

LuCI's direct `uci` save/apply, third-party services and administrator edits do
not participate in these application locks. They can change configuration
while a backend operation owns it. Fresh protected cursors avoid overwriting
changes committed by other coordinated backend operations; they cannot make
external UCI writers transactional. Reapply after external settings changes.

The updater's launch-to-worker token handoff, cache refresh, history and
rotation-state metadata retain their existing independent lock slots and
formats. Apply/rotation background jobs use a separate execution slot and
conditional status transitions, documented in [background-jobs.md](background-jobs.md).
Mutation ownership still protects synchronous operations and scheduled workers
that do not participate in the background job slot.

Before upgrading from token-based tunnel locks, stop the scheduler and allow
existing apply/rotation workers to exit (or reboot after package installation).
Old and new backend processes must not run concurrently: old workers neither
honor shared configuration ownership nor the new stable instance files.
Do not remove the stable lock files as a busy-state recovery step. After worker
termination, retry the operation; kernel ownership is already released.

## Validation and remaining device checks

The offline suite includes public-entry busy/no-write checks, shared contention,
exception cleanup, migration, alias rejection, HTTP outside shared ownership,
and fan-out results. Real subprocess tests cover two instance owners writing
one filesystem-backed UCI package with cached cursor snapshots, reverse-order
multi-instance acquisition, competing credential-style fan-out, killed owners,
stale timestamps/PID text, delayed old releases, stable inodes and exec child
inheritance. These tests require Python 3 alongside host ucode/fs/math.

The implementation was exercised with host ucode commit
`c650fa89b771b81e0031e4d88e53b4e7d2a667a4`. The fs `file.lock('xn')` and
close-on-exec APIs were checked against that implementation. Supported OpenWrt
24.10 and snapshot package versions still require device validation, including
uloop fork inheritance, netifd/fw4/dnsmasq convergence and interrupted routing
operations. No router performance or traffic-isolation improvement is claimed
as measured. Test multiple tunnels, domain steering/bypass, kill switch, DNS,
disable/delete/reset, credential changes and controlled reload failures before
release. Lock cleanup does not roll back configuration written before a crash.
