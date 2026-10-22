# Indexed, bounded server picker

The accepted server response builds one immutable display index: hostname lookup,
normalized country/city/name/hostname search text, country groups, load/name ordering,
and the lowest eligible relay. A single numeric-aware `Intl.Collator` is reused.
Without numeric collation the fallback compares text and digit runs; it preserves
natural number order without converting long digit runs to floating-point values.
Country names sort naturally, relay ties use name then hostname, and Lowest load
uses the same deterministic tie order. Dedicated IP relays remain selectable but
are excluded from Lowest load.

Typing filters the existing order after a 100 ms debounce. It never sorts or
changes the editable draft. Closing the panel, starting/replacing a server query,
discarding edits, or rebuilding the form cancels pending work. Accepted responses
retain plan 8's instance/query/form-generation checks. Data acceptance replaces
only the list; it preserves the filter DOM node, value, caret and focus. A focused
list action is restored when available, with the filter as its fallback. An
unrelated focused input keeps focus.

Each page contains at most 50 relay buttons. Show more replaces that page and
Previous returns to the prior page, so browsing the complete list never grows the
relay DOM beyond 50. Matching totals exclude the fixed selected/current text
summaries. Those summaries preserve unavailable pins and off-page/filter-hidden
indicators. Automatic and Lowest load stay visible for every filter; Lowest load
is disabled when no eligible relay exists. Filtering includes hostname as well as
country/city/name. Reopening retains the typed filter and returns to its first
page; a new form/context starts with an empty filter.

The whole visible batch is built off-DOM before one `dom.content()` replacement.
Relay and quick actions are native buttons (Enter/Space); Escape closes the panel
and returns focus to its trigger. Paging focuses the first new relay. Reopening
reuses one Escape handler, and accepting data never installs filter handlers.
A click on an old page control during the debounce renders the new filter's first
page, avoiding an out-of-range page. No backend, RPC or saved-setting format changes
are included. Virtualization is unnecessary for the measured bounded workload.

## Regression and browser validation

The initial added regression failed against `128dfc5` because no display index
existed. The unit suite exercises numeric ties, missing hostname lookup, immutable
indexes, dedicated exclusion, ordering, filtered matching totals, missing pins,
quick controls, debounce/cancellation, context replacement, and the page sequence
50/50/26/50. A throwing sort spy in both VM and host realms proves that filtering
and rendering never sort. A separate regression reproduced an empty page when
Show more was clicked during a pending filter; the corrected path renders its
first page. Existing deferred draft/save/discard/instance/error regressions pass.
Numeric fallback cases cover missing Intl, rejected options, and a collator that
silently ignores numeric ordering.

The local browser harness also checks focus/caret preservation during data
acceptance, focused relay restoration, unrelated input focus, rapid-input
coalescing, cancellation on close/data replacement, bounded pagination and
unchanged missing pins. CDP native key events verify Enter selects a relay, Space
activates Automatic, and Escape closes and returns focus.

```sh
node luci-app-nordvpn/tests/overview.test.js
node_modules/.bin/eslint luci-app-nordvpn
node --check luci-app-nordvpn/htdocs/luci-static/resources/view/nordvpn/overview.js
node --check luci-app-nordvpn/tests/server-picker.bench.js
git diff --check
```

Backend code is unchanged; backend/device routing validation and package builds
are outside this change's local checks.

## Measured browser comparison

Measured October 22, 2026 on host headless Chromium 154.0.8037.57, Debian 13,
x86_64 AMD EPYC 9V74 (3 exposed CPUs), without CPU throttling. Viewports are
1440×900 desktop and 390×844 mobile emulation at device scale 1. The mobile-sized
viewport runs on the same host CPU; **these are not physical mobile measurements**.
The harness loads the actual overview methods and its CSS in a real browser DOM,
with stubbed LuCI services and synthetic data. It does not load the full LuCI
theme, fetch servers, measure network performance or measure Core Web Vitals.

Both revisions use the same fixtures and harness: 250, 2,000 and 10,000 relays,
four countries, eight cities, 80% equal-load ties, a dedicated relay every 31
entries and reverse-numbered server names. There is one warm-up followed by seven
samples per size/viewport. Values below are medians. Baseline and changed runs
execute sequentially. Open/filter/reopen timings include synchronous JavaScript,
DOM creation and a forced layout; filter timing uses `city 0` and excludes the
100 ms debounce. Reopen and all subsequent cycles explicitly clear the filter in
both revisions, giving the same unfiltered workload. Data/index construction is
reported separately; source loading is outside these timings.

The heap value is `performance.memory.usedJSHeapSize` after exposed `gc()` and
five reopen cycles, for the whole benchmark page including its synthetic data.
It includes retained JavaScript objects and wrappers; it is **not** total DOM,
renderer or browser process memory. GC is a measurement aid, not application
behavior. Small heap changes and sub-millisecond timing differences are sensitive
to JIT and shared-host noise. Raw samples, DOM counts and browser interaction
results are retained in [server-picker-results.json](server-picker-results.json).

| Viewport | Relays | Data/index ms, before → after | Open ms | Filter ms | Reopen ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Desktop | 250 | 0.1 → 0.7 | 13.4 → 2.9 | 2.3 → 1.9 | 11.4 → 2.7 |
| Desktop | 2000 | 0.2 → 4.1 | 109.4 → 2.8 | 18.9 → 2.7 | 97.7 → 2.5 |
| Desktop | 10000 | 0.2 → 16.7 | 572.2 → 3.2 | 100.8 → 3.3 | 500.1 → 2.7 |
| Mobile emulation | 250 | 0.1 → 0.6 | 13.2 → 2.3 | 2.5 → 1.8 | 12.2 → 2.1 |
| Mobile emulation | 2000 | 0.2 → 3.8 | 98.2 → 2.4 | 22.4 → 2.7 | 100 → 2.1 |
| Mobile emulation | 10000 | 0.2 → 17 | 500 → 2.8 | 118.1 → 3.3 | 513.5 → 2.5 |

| Viewport | Relays | Open DOM elements, before → after | Filter DOM elements | Relay rows open/filter/reopen, after | Whole-page post-GC JS heap MiB, before → after |
| --- | ---: | ---: | ---: | --- | ---: |
| Desktop | 250 | 1152 → 219 | 176 → 177 | 50 / 32 / 50 | 1.69 → 1.71 |
| Desktop | 2000 | 9083 → 218 | 1273 → 268 | 50 / 50 / 50 | 2.31 → 2.21 |
| Desktop | 10000 | 45341 → 217 | 6305 → 267 | 50 / 50 / 50 | 9.67 → 4.35 |
| Mobile emulation | 250 | 1152 → 219 | 176 → 177 | 50 / 32 / 50 | 7.30 → 1.77 |
| Mobile emulation | 2000 | 9083 → 218 | 1273 → 268 | 50 / 50 / 50 | 7.92 → 2.27 |
| Mobile emulation | 10000 | 45341 → 217 | 6305 → 267 | 50 / 50 / 50 | 10.26 → 4.41 |

The one-time index cost is 0.7 ms for 250 relays and 16.7 ms for 10,000 on
the desktop viewport. Including that cost, the first 250-relay open falls from
13.5 ms to 3.6 ms; the filtered 32-match page remains small (2.3 → 1.9 ms).
At 10,000, desktop open/filter/reopen drop from 572.2/100.8/500.1 ms to
3.2/3.3/2.7 ms. Relay DOM stays bounded through all five reopen cycles.

The 250-relay desktop JS heap grows slightly (about 22 KiB), reflecting index
metadata despite fewer rows. Heap values cover the whole page and the sequence
of earlier fixtures in the same realm; VM/native cleanup and retained allocations
from the preceding 10,000-relay case particularly affect the baseline mobile
sequence. These observed heap values are not isolated per-picker memory costs,
and do not establish a total browser memory saving. A device memory profile is
still required. The timings and bounded DOM counts support pagination without
adding viewport virtualization.

Reproduce with a local Chromium executable and Node supporting built-in WebSocket:

```sh
git show 128dfc5:luci-app-nordvpn/htdocs/luci-static/resources/view/nordvpn/overview.js > /tmp/nordvpn-picker-before.js
node luci-app-nordvpn/tests/server-picker.bench.js /tmp/nordvpn-picker-before.js > /tmp/nordvpn-picker-before.json
node luci-app-nordvpn/tests/server-picker.bench.js > /tmp/nordvpn-picker-after.json
```

Set `CHROMIUM` to override `/usr/bin/chromium`. The harness uses only about:blank,
local synthetic fixtures and localhost CDP, creates a temporary browser profile,
and removes that profile at exit. It needs permission for Chromium process
sockets where the execution sandbox restricts them; it needs no npm dependencies
or outbound network. Run the commands sequentially. Physical mobile hardware,
live LuCI/OpenWrt integration, supported-browser compatibility and full browser
process/DOM memory remain device-validation limits.
