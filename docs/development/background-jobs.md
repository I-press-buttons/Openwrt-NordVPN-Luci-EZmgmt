# Background tunnel jobs

`nordvpn.jobs` owns the apply/rotation execution slot. Its authoritative `phase`
is `queued → running → done/failed`. Public `state` stays `running` during
queueing for older LuCI clients. Existing response fields remain available;
records add `id`, `phase`, immutable request `context`, queued/started/finished
wall timestamps, monotonic uptime stamps and process ownership identities.

## Handoff and ownership

The launcher reserves a random kernel UUID and publishes queued status before
spawning. The worker receives `--job-id ID` and atomically claims that exact
reservation, instance and operation. Apply's source comes from the reserved
context rather than trusting a second worker argument. Manual CLI jobs reserve
an ID themselves. Duplicate starts for the same instance/kind return the same
active reservation. A different operation receives an explicit busy response.

The status file remains `/tmp/nordvpn_apply_status.json`. A short, stable
`<status>.metadata.lock` advisory lock protects conditional reads/transitions.
It never spans spawn, network calls or work. A separate stable
`<status>.execution.lock` advisory lock covers worker claim, execution and
terminal publication. The mutation coordinator separately owns the affected
instances/configuration while mutations execute; its short configuration lock
is never extended into job metadata publication. Lock order is bounded:
reservation checks execution nonblocking while owning metadata; a worker owns
execution and briefly takes metadata. No path waits for execution under metadata.
Do not unlink either advisory file to recover a busy job.

Launcher handoff writes can update only their own queued record. Completion can
update only the exact running ID and worker identity. A child that completes
before spawn returns keeps its terminal outcome. Terminal publication happens
before execution ownership is released. If storage fails, no work begins before
a successful running publication, and a failed terminal publication returns an
explicit error and logs it; it never reports successful job completion. The
last running record is recovered as failed after worker exit. An operation may
have changed configuration before status publication failed; inspect status and
recent events, then retry after storage becomes writable.

## Recovery, history and API

Queued reservations expire after 30 seconds of monotonic uptime, independently
of the long-lived launching rpcd process. If a spawned worker is known dead,
recovery is immediate. Running records use Linux PID plus process start ticks
and monotonic elapsed time, so PID reuse and NTP jumps cannot fabricate a live
owner or reclaim one due to wall-clock changes. Missing `/proc` identity, UUID
or uptime data prevents a new reservation explicitly. A worker exceeding its
runtime limit is reported failed, but its live execution ownership is retained
until the process exits. It cannot replace that failure with late success.
Investigate/terminate a stuck worker before retrying; automatic lock reclamation
does not kill workers or roll back prior mutations.

One atomic JSON replacement contains the latest record and at most 16 prior
terminal records. Exact-ID readers can retrieve their result after consecutive
jobs of the same kind/instance. `apply_status` accepts optional string `id`;
empty/omitted IDs retain latest-status behavior. An absent/evicted ID returns
`state: missing` and an error, never a different job's latest result. History is
private storage metadata and is excluded from RPC responses. LuCI polls the ID
returned by its start request, including duplicate-start responses. It retains
kind/instance matching when connected to an older backend without IDs.
No ACL changes are needed: the existing read-only status method accepts the
additive argument, and existing write ACLs govern job starts.

Legacy flat status records remain readable with their previous wall-clock
recovery behavior. Finish old workers before upgrading, or reboot after package
installation: old workers cannot participate in new conditional transitions.
Status/history live in `/tmp` and are intentionally lost on reboot. Empty or
malformed status cannot be treated as success. The cache refresher and updater
retain their separate formats and lifecycles. Later probes/cache workers may
instantiate another slot with another status path, rather than contending for
the tunnel execution slot.

## Validation and limits

Offline deterministic tests cover completion before spawn returns, duplicate
and consecutive starts, late old workers, spawn failures/exceptions, unavailable
storage at reservation/claim/completion, metadata exceptions, dead workers,
unclaimed queues, wall-clock jumps, runtime timeouts, publication under execution
ownership, exact-ID retention/eviction and legacy no-ID lookup. Real subprocess
tests SIGKILL a worker, recover its failed result and claim the same stable
advisory inode with a replacement. LuCI tests check exact-ID requests, rejection
of another same-instance result, expired IDs and old-backend compatibility.

Host ucode/fs/math and the existing mutation process suite validate lifecycle
and locking; no package build is required for this change. OpenWrt 24.10 and
snapshot device validation remains outstanding, including real rpcd detached
handoff, supported ucode advisory APIs, multiple LuCI tabs, storage exhaustion,
worker termination during netifd operations and recovery after package upgrades.
No router performance or traffic behavior improvement is claimed as measured.
