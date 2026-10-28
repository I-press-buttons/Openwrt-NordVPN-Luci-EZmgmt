# Credential safeguards and UI organization

Credential entry and submission require an HTTPS browser page. An HTTP page
shows an HTTPS link and refuses to open or submit the token dialog. The token
field is cleared after submission and when cancelling. The router's existing
HTTPS listener must be verified before enabling a uhttpd redirect; this package
does not silently change the router's global web-server configuration.

The shared log/event redactor now removes both 64-hex tokens and 32-byte base64
WireGuard keys, including keys containing slash or plus characters. Public keys
are also scrubbed intentionally. The current atomic writer already creates
root-only files. The installed older backend received a minimal redactor and
0600-writer patch; existing runtime records were also changed to 0600.

The page starts with the selected tunnel and live status, followed by recent
events. Per-tunnel settings use Connection, Routing & protection, Recovery and
Advanced tabs. Global settings contains credentials, shared cache controls,
updates, and collapsed instance/key management. Manage tunnels opens that area.
Reset/delete/key-removal controls are grouped there. Disabling all tunnels
requires confirmation that their kill switches will be removed.

Panels stay mounted across tab changes. Switching tabs cannot discard drafts
or launch another server-list request. Arrow keys, Home and End navigate the
ARIA tabs. Recovery groups watchdog and egress settings; optional scheduled
rotation is separate. The save bar remains visible while scrolling and names
the tunnel, reconnect behavior and any shared cache change. Per-field details
are expandable. Routing has an explicit All LAN / Selected traffic choice.

Validation:

- Frontend regression tests cover draft retention, keyboard navigation,
  reconnect/shared-setting summaries, HTTP submission prevention, immediate
  password-field clearing and cancelled global-disable actions.
- Fourteen redaction assertions pass on the router with synthetic keys/tokens;
  seven isolated credential-boundary tests also pass with a mocked HTTP client.
- The browser preview executes the actual view with synthetic RPC/config data.
  Routing visibility, cross-tab drafts, recovery grouping, global management,
  HTTP credential refusal and keyboard navigation were checked. A 390-pixel
  viewport showed one active panel and no horizontal overflow. This preview
  uses a test stylesheet; it is not a claim of a live LuCI theme integration test.
- Router HTTP now returns an HTTPS redirect. HTTPS was verified against the
  certificate obtained over authenticated SSH. The existing certificate names
  OpenWrt, so accessing the router by IP can still produce a browser certificate
  warning. No certificate or authentication credential was replaced.
- The live VPN remained connected while the scheduler and rpcd reloaded.

The UI was subsequently deployed with matching backend source from the merged
revision. Workers and RPC modules were compiled against the native router
runtime first; advisory locking and private atomic writes were exercised. The
full previous source and configuration are retained in a root-only rollback
archive on the router. Public UI assets are mode 0644; runtime records remain
0600. The local source version is labelled separately from APK package metadata.

The routing verifier requires `timeout`, which is not enabled in every BusyBox
build. The backend declares `coreutils-timeout` explicitly so package installs
include it. This dependency was discovered by the real-router routing apply
check; mocked command execution in the offline suite cannot establish that a
system utility is installed.
