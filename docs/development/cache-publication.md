# Server cache refresh publication

The shared server refresh has its own `nordvpn.jobs` execution slot at
`/tmp/nordvpn_fetch_status.json`, independent of tunnel apply/rotation jobs and
the package updater. RPC reserves queued status before detached spawn; the
scheduler reserves before `uloop.task`; a manual cache CLI reserves itself.
Workers claim the exact reservation ID and cache path. Busy callers cannot
write progress or terminal status for another refresh. The CLI accepts optional
`--job-id ID`; RPC start retains `started`, `already_running`, `job` and adds the
reserved `apply.id` record. `refresh_status` accepts optional `id`; absent IDs
read latest status, missing exact IDs return `missing`.

The public `state` stays `running` during queueing, fetching, validating and
publishing. `phase` exposes those steps. Fetch only reports progress and never
publishes a terminal state. The outer worker rejects empty/unusable normalized
trees and verifies required country/city/gateway fields and counts. It writes a
cache generation equal to its reservation ID, checks the replacement is readable
with that generation, and then publishes `done` under execution ownership.
Terminal records contain compact generation/stats/time metadata, never server
trees; bounded job history therefore does not duplicate multi-megabyte caches.
Refresh lifecycle `failed` maps to legacy public `error` plus `message`.

`common.atomic_write` creates an exclusive temporary in the same directory,
checks the exact write count and close result, then checks rename. Any failed
step cleans up the temporary and returns false; the old destination remains
unchanged until a successful rename. This disposable `/tmp` data does not need
fsync durability. All existing helper consumers benefit from checked publication;
the updater's separate token handoff and history locking remain unchanged.

A successful rename followed by failed read verification or terminal-status
storage is explicitly ambiguous: the worker retains the replacement, returns
`cache_published: true` with an error, and logs it. It does not claim refresh
success or restore older bytes over a completed publication. If the last stored
phase is publishing and the worker dies, status recovery reports that publication
may have succeeded. Readers should inspect the available cache; its generation
identifies the published request. LuCI renders terminal errors before reading
locations, preserves previous availability/age in the row, and shows a retryable
read error if that follow-up RPC fails.

New running records use PID plus Linux process start ticks. A live refresh has
no total-age cutoff: each HTTP page retains its connect/total timeout, response
size bound and pagination limit, but many legitimate pages can outlive the old
600-second token lock or 1800-second scheduler deadline. New reservations never
steal advisory ownership by age. Dead workers release the execution descriptor;
status recovery fails their exact record. The scheduler observes that identity,
folds each outcome once, ignores late callbacks and applies failure backoff to
spawn failures and dead-worker recovery. Successful publication starts the next
refresh interval at completion. Forked service children still drop inherited
advisory descriptors before doing work.

Existing flat refresh records remain readable with their legacy progress-age
recovery rules. Finish existing workers before upgrading, or reboot after
installation: old workers cannot participate in the new identity transitions.
Stable advisory lock files must not be unlinked. Legacy cache schema remains
readable; new generations are additive. RPC tree and relay memoization already
includes inode/size/mtime/ctime, so atomic replacement invalidates both even for
equal-size writes in the same timestamp tick.

Offline validation covers write/short-write/close/rename/exception failures,
empty/malformed trees, later-page failure, exact-generation readback, unavailable
storage, completion before spawn returns, compact history, long-lived ownership
and clock changes, worker death in each phase, stable ownership recovery,
concurrent readers during replacement, equal-size memo replacement and LuCI
previous-cache/error/missing-status/read-failure behavior. The full offline ucode
suite, LuCI tests, ESLint and standalone compile checks are the required checks.
No package build or live router test was performed. OpenWrt rpcd/uloop handoff,
real storage exhaustion and supported target ucode APIs still need device
validation; no measured device performance improvement is claimed.
