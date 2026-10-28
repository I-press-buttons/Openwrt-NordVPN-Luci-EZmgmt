# Scheduler resource guard

On an OpenWrt 25.12.5 router running nordvpn-wireguard 1.8.0-r1, the
WireGuard handshake was over 27 hours old. The daemon still recorded watchdog
attempts, but rotation outcomes, egress probes and cache refreshes stopped
advancing. Manual rotation immediately established a working tunnel; restarting
the scheduler resumed probes and cache refresh.

An isolated real-uloop reproduction on that router ran 150 successful tasks.
The process retained 160 descriptors, including one extra pipe per task.
Explicit garbage collection did not reduce that count. This is a runtime
resource leak; the application guard bounds its effect rather than repairing
the ucode library itself.

`task_guard.uc` tracks scheduler tasks and checks `/proc/self/fd` before each
30-second tick. At 192 descriptors it exits successfully once all tracked
workers have finished. procd starts a fresh scheduler after five seconds.
WireGuard, routing and firewall configuration are untouched by this recycle.
The existing persisted scheduler clocks and watchdog state survive it.
The procd crash window is explicitly 60 seconds so regular resource recycling
does not exhaust the default one-hour crash budget on multi-instance systems.
Spawn failures raise an error for the scheduler's existing logging boundaries.

Validation:

- Six deterministic regression checks cover normal operation, pressure with
  an active worker, idle recycling at the threshold, logging, the lower bound,
  and task-spawn failure.
- A real-uloop stress test on the router with a test threshold of 48 descriptors
  recycled after 37 tasks, with all 37 results delivered.
- The deployed scheduler compiled on the router and restarted without
  resetting the WireGuard interface uptime.
- A controlled `ifdown` was detected and recovered automatically after the
  watchdog grace period. The first replacement subsequently failed egress
  checks; the watchdog detected `no_egress` and rotated again successfully.
- Final checks showed a fresh WireGuard handshake, advancing traffic counters,
  successful egress probes, and NordVPN's external-IP endpoint reporting
  `protected: true` in the configured Wilmington location. Kill switch and
  IPv6 blocking remained enabled.

The router received a minimal patch against its installed 1.8.0-r1 daemon;
the repository's newer daemon uses the same guard. No broader package upgrade
was required. Router backups of the original daemon and init script are in
`/root/nordvpn-repair-20261028/`. A package upgrade can replace the live patch;
build from the patched source to include the guard in future packages.
