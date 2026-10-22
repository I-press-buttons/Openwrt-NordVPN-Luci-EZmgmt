# Asynchronous protection checks

LuCI now reads local observations and starts a detached `/usr/bin/nordvpn-probe`
worker. The new RPC handlers perform no remote HTTP work. They return after local
cache/job reads, bounded metadata coordination, and launch. Normal status polling
continues while the worker waits for the provider.

## API and compatibility

All methods accept `instance` (default `main`).

| Method | ACL | Result |
| --- | --- | --- |
| `external_ip_status` | read | Local observation; optional `id` selects that exact check |
| `external_ip_start` | write | Fresh cached observation, deduplicated pending ID, bounded failure/backoff, or busy/error |
| `external_ip` | read, existing | Retained synchronous legacy provider request |

`external_ip_status` performs no cache/job recovery or writes. Read-only users
can inspect existing observations; LuCI does not start checks without write
permission. IDs never fall back to another job. An expired/evicted ID is missing
or stale, even if a newer same-instance check succeeded.

The additive observation states are `pending`, `fresh`, `stale`, `failed`, and
`missing` for an unavailable exact ID. Only `fresh` includes `result`, with the
existing IP/location/protected fields and optional `lan_path`. Metadata includes
the ID, gateway/interface, opaque generation, check/expiry timestamps, remaining
TTL and retry delay. An old successful payload is never returned as current
protection after expiration or invalidation. A failed eligible LAN check makes
the whole check failed rather than implying that LAN protection was confirmed.

The legacy `external_ip` response and read ACL are preserved. It still performs
one synchronous request (two for eligible legacy routing), each with the old
eight-second timeout, and can block rpcd for approximately 8–16 seconds. This is
an explicit compatibility limitation; LuCI does not call it. External clients
should migrate to start/status. Removal needs a separate compatibility decision.

## Ownership, publication and freshness

Probes reuse `nordvpn.jobs` with a separate slot at
`/tmp/nordvpn_probe_job.json`. A probe cannot occupy the tunnel/cache-refresh
execution slots. Reservation precedes spawn, workers claim the exact ID, and
terminal job metadata is published while execution ownership is held. Job
history contains completion metadata only, with no provider payload or keys.
`jobs.peek()` supplies read-only status without recovering abandoned records.

The atomic `/tmp/nordvpn_probe_cache.json` journal holds at most 16 latest
per-instance observations and 32 generation entries. Its advisory lock
serializes mutation invalidation and worker publication. Versions are unique
kernel UUIDs; an evicted version must be initialized with a new UUID before a
later probe can publish, so the missing-version sentinel cannot resurrect an
old success. Temporary writes are checked and atomically renamed using the
shared writer; publication failure cannot return a successful worker result.

The mutation coordinator invalidates affected generations after acquiring all
instance locks and before modifying anything. This covers scheduler/CLI/UI
apply, rotation, routing changes, disable/delete and credential fan-out, including
reconnects to the same gateway. Conservative invalidation also occurs when an
owned operation later fails or finds nothing to change. Failed invalidation
refuses the mutation and releases all ownership; fix `/tmp` storage and retry.

The context also includes non-secret routing/interface configuration, current
gateway/endpoint, and boot identity plus the device's sysfs ifindex/admin flags.
Device absence/down state invalidates protection; ordinary WireGuard handshakes
do not change the generation. Normal device recreation outside the coordinator
gets a new ifindex. Arbitrary external in-place routing edits that bypass both
UCI and the coordinator are outside this generation contract; retry after
applying managed settings, or wait for the short cache expiry.

Starts briefly acquire the instance lock, so a probe cannot launch during an
owned reconnect. The worker briefly checks context at entry and, after HTTP,
acquires instance ownership and rechecks generation under the journal lock
before cache publication. Any intervening reconnect, rotation, interface or
routing change rejects the result. Remote requests hold no instance,
configuration, cache or job metadata locks. A one-second bounded initial wait
permits a fast detached child to finish its launch handoff; publication never
waits through a conflicting mutation. Lock order is instance → journal → short
job metadata; all execution-lock checks under metadata are nonblocking.

Successful observations expire after 120 seconds of monotonic uptime. Failure
retries back off for 30, 60, 120, 240, then 300 seconds, capped at 300. Starts
deduplicate running checks and fresh results across browser tabs. There is one
probe worker globally, so other instances receive an explicit busy response.
Worker death/spawn/publication failure enters the same retry policy on the next
write-side start. Wall-clock timestamps are display metadata; NTP jumps cannot
fabricate freshness or skip backoff. `/tmp` state is disposable on reboot.

The worker uses curl with a three-second connect timeout, eight-second total
deadline per request and 16 KiB response limit. A bounded pipe reader also caps
chunked responses on older curl versions. The job runtime ceiling is 25 seconds.
The tunnel request remains bound to the configured interface. A second unbound
LAN-path request is made only when the instance is enabled, the actual network
interface has no `ip4table`, and configuration-only routing detection reports
`auto`, preserving the legacy eligibility rule.

LuCI polls exact IDs through normal five-second status updates. Accepted
responses must match instance, active form and backend generation. Switching,
rebuilding a form, disconnecting or reconnecting invalidates late responses.
Freshness is rendered explicitly; expired/pending/stale/failed responses never
reuse the protected styling. Errors are retried with server/local backoff.

## Validation and remaining device checks

Offline regressions cover HTTP-free RPC launch/status, concurrent tab dedupe,
read-only stores and ACL separation, same-gateway/routing/device generation
races, mutation-held publication, exact IDs, expiry, exponential backoff and
clock changes, bounded records/versions, failed publication, generation storage
cleanup, response-size/time limits, binding and eligible LAN-path requests.
Separate real processes hold a delayed request while local status returns and
a mutation acquires ownership, reject the resulting superseded observation,
and verify read-only failure/backoff after SIGKILL. Deferred UI tests cover
instance/form/generation/disconnect races, exact-ID rejection, visible failure
and stale states, read-only views, and independent normal updates.

Validation uses the host ucode/fs/math interpreter and mocked router services;
no package build or live HTTP/provider account is needed. OpenWrt 24.10 and
snapshot device validation remains pending: delayed/failed provider responses
while issuing real status/configuration RPCs, detached rpcd handoff, multiple
tabs, same-gateway reconnect, scheduler rotation and credential changes during
a probe, ifdown/up recreation, legacy LAN path, storage exhaustion and worker
termination. Check real curl/ucode pipe deadlines and supported advisory-lock
behavior on those devices. No router latency or CPU improvement is claimed as
measured.
