# Batched runtime status

`instances` and the lightweight `overview` RPC now collect one request-scoped
runtime snapshot for all configured instances. Each scheduler tick shares a
snapshot too, collected lazily only if an instance needs watchdog or egress
status. Idle/disabled ticks perform no runtime collection. No permanent runtime
cache is retained in rpcd or the scheduler.

## Collection and compatibility

`nordvpn.status.collect_runtime(settings, at)` takes already-loaded settings and
an optional timestamp (the scheduler passes its tick time). It opens one ubus
connection, calls `network.interface dump` once, and disconnects, including after
a failed/throwing call. For observed managed devices it runs at most:

```
wg show all latest-handshakes
wg show all transfer
```

These formats contain no private keys. Results are immediately filtered to
managed interfaces' netifd L3-device names, which may differ from their logical
UCI names. The raw netifd data also serves the existing routing MTU probe in
`instances`, avoiding its former additional shell `ubus` dump. Existing routing
probe memoization remains in place. `overview` performs no routing detection,
IP/link/DNS capability probes, generation-context work, or remote HTTP.

`runtime_status(snapshot, iface)` interprets runtime data without I/O or snapshot
mutation. The existing `status(uci, instance, settings)` API remains supported;
its optional fourth argument supplies a snapshot and avoids runtime collection
inside the instance builder. RPC builders share loaded settings, and `instances`
reads the probe-generation journal once per request. Public response fields,
rotation data, and asynchronous protection-check generation semantics remain
compatible.

Observed behavior is preserved:

- Missing credentials produce `not_configured`. `enabled` remains an
  administrative flag, independent of a configured tunnel's live state.
- Missing/down netifd state produces `disconnected`; uptime and transfer stay
  null. Valid L3-device mapping and integer uptime are preserved.
- An up interface with no valid handshake is `connecting`. The newest peer
  handshake is `connected` through age 180 seconds and `degraded` above that.
  Future timestamps retain the existing age-zero clamp.
- Matching persisted egress failures still fold `connected` into `no_egress`
  in RPC and watchdog decisions.
- Transfer counters sum complete peer observations, including real zero values
  after a device reset. Each request starts fresh; missing devices cannot reuse
  an older snapshot.

Unavailable sources remain independent: failed handshake collection gives a
null handshake age and cannot report healthy state; failed transfer collection
gives null counters while a separately observed valid handshake remains valid.
Empty, malformed, duplicate, or overflowing peer records make that device's
corresponding observation unavailable instead of creating a partial total or
healthy handshake. Malformed netifd state/device mappings cannot create health.
If no managed device is observed, no WireGuard subprocess is needed. Collection
is a short sequence of observations, not an atomic kernel/network transaction;
normal device changes can occur between the netifd and WireGuard reads.

## Regression evidence

`tests/test_runtime_status.uc` invokes the real `overview` and `instances` RPC
handlers and the daemon's actual `tick`/`instance_step` functions. The scheduler
fixture replaces unrelated cache/task/rotation I/O explicitly; it uses the real
runtime collector and state-decision functions. Host uloop is unavailable, so CI
also compile-checks the complete daemon with a compile-only namespace that fails
if executed. It does not emulate a running OpenWrt event loop.

Before implementation, the new fixture failed against the previous code for
per-instance commands/connections, per-interface netifd calls, and the extra
shell dump in `instances`. For all-up fixtures the verified launch/call counts
are:

| Instances | Previous WG calls | Batched WG calls | Previous status ubus connections | Batched connections/dumps |
| --- | --- | --- | --- | --- |
| 1 | 2 | 2 | 1 | 1 / 1 |
| 4 | 8 | 2 | 4 | 1 / 1 |
| 8 | 16 | 2 | 8 | 1 / 1 |

These are deterministic command-launch and connection counts with adapters,
not measured router process/CPU timings. A second scheduler tick recollects
once; disabled ticks collect nothing. The fixture also compares status fields
for multiple peers, L3 mapping, disabled/unconfigured/down/connecting/healthy/
stale/no-egress states, exact handshake thresholds, counter reset, disappearing
devices, malformed/duplicate/overflowing output, independent command failures,
legacy individual callers, pure construction, and throwing ubus connect/call
cleanup. Overview asserts exactly the two WG commands and no other subprocesses.

The offline backend suite, LuCI tests, ESLint, standalone ucode compilation and
whitespace checks run without package builds or provider/network access.

## Pending device validation

No router hardware is attached. OpenWrt 24.10 and snapshot validation, actual
latency/CPU/peak-memory measurements, and the plan's no-material-regression
performance acceptance remain pending; no measured router speedup is claimed.
On the same router/firmware and before/after builds, create 1, 4 and 8 identical
managed tunnels, including logical/L3 names that differ and multiple peers.
Record hardware, firmware, instance/peer count, active UI polling and watchdog
settings, repetitions, elapsed time distribution and peak RSS for status RPCs
and scheduler collection. Record process/ubus calls separately from routing
probes and background probe/rotation workers. Repeat while interfaces disappear,
netifd restarts, and each WG observation fails; verify status meaning and that
connections close. Use normal safe WG fields only when tracing.
