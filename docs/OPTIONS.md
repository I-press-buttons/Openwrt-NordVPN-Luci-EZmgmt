# NordVPN LuCI options explained

This guide explains what each control on **VPN → NordVPN** is for and what it
changes on the router. Settings belong to the selected tunnel unless marked as
shared. **Save** stores and applies edits; **Discard changes** restores the
saved values. Routing edits are reconciled without reconnecting. Connection
edits are verified with a WireGuard handshake before the new server is kept.

The page starts with a tunnel selector and live status/protection summary.
Settings tabs stay mounted when switching, so unsaved edits are preserved:
**Connection**, **Routing & protection**, **Recovery**, **Advanced**, and
**Global settings**. Credentials, server cache and updates are shared settings;
instance management is also under Global settings. The sticky save bar names
the selected tunnel and explains whether its pending changes reconnect it.

Use HTTPS for administration. The credential dialog blocks token entry and
submission on HTTP and clears the token field immediately after submission.

## Credentials and tunnels

| Option | Purpose and what happens under the hood |
| --- | --- |
| **Credentials** (Global settings) | A NordVPN access token is exchanged once for a WireGuard private key. The token is not retained or returned to the browser; the key is stored in the router's network configuration for netifd. The **Default** entry is shared by all tunnels unless a tunnel selects another named entry. |
| **Add credentials / Replace token / Remove** | Add another account key, replace an entry's key, or remove an unused entry. Removing the Default key keeps the entry but clears its key. An entry in use cannot be removed. |
| **Instances** | Each instance is an independent WireGuard tunnel with its own location, routing, rotation and health settings. Multiple instances can use different countries or credentials. Only one instance can route all LAN traffic; use steering for the others. |
| **Enable / Disable / Delete instance** | Enable applies the saved tunnel settings. Disable takes down the tunnel and removes its managed routing/firewall rules. Delete also removes that instance's settings and generated interface. **Disable all VPNs** disables every instance and removes their kill switches, so affected traffic can use the WAN. |

## Connection

| Option | Purpose and what happens under the hood |
| --- | --- |
| **Credentials** (per instance) | Select which saved credential entry supplies this tunnel's WireGuard key. It takes effect on save and may require a reconnect. |
| **Hop mode: Single hop** | Connect directly to a NordVPN WireGuard server. This is the usual, fastest mode. |
| **Hop mode: Multihop** | Use NordVPN Double VPN: enter through a partner country and exit through the selected country. The exit country determines the public IP; the partner is reflected in the server name. |
| **Hop mode: Onion over VPN** | Send traffic from the NordVPN server into Tor. Tor exits can be slow or blocked by websites. Tor servers are only considered in this mode. |
| **P2P servers only** | Restrict single-hop choices to NordVPN servers tagged for peer-to-peer traffic. It does not apply to multihop or Onion mode. |
| **Locations** | Set the pool used for the initial connection and automatic rotations. A country includes its available cities; narrow it to particular cities when desired. The backend requests matching servers from its cached NordVPN server list. |
| **Server: Automatic** | Let the backend select a matching server using the configured server-selection strategy. Each candidate must establish a real WireGuard handshake before it is accepted. |
| **Pin a server** | Lock this tunnel to one gateway. Automatic rotation and watchdog server changes are unavailable while pinned. Clear the pin to return to automatic selection. Dedicated IP servers are marked in the picker; they are not selected automatically. |

## Traffic routing

The backend creates and tags its own policy-routing rules, firewall objects,
and (when needed) DNS configuration. It does not change the WAN default route.
If it detects custom routing rules for the tunnel, the page reports **Manual**
mode and leaves routing and firewall configuration untouched.

| Option | Purpose and what happens under the hood |
| --- | --- |
| **Route all LAN traffic through the VPN** | Route every network in OpenWrt's LAN firewall zone through this tunnel's dedicated routing table. Other zones, such as guest, and traffic created by the router itself keep their normal route. Only one enabled instance can own this mode. |
| **Steered networks** | Route only selected OpenWrt networks (such as a guest or media VLAN) into this tunnel's routing table. Local subnet routes remain reachable. |
| **Steered devices** | Route chosen client devices by MAC address. A DHCP address change does not change the policy. A device can be assigned to one enabled tunnel at a time. |
| **Steered domains** | Route traffic to a domain and its subdomains through this tunnel. dnsmasq resolves the names into managed nftables sets that the firewall uses for routing. Requires `dnsmasq-full`, clients using the router for DNS, and does not catch app or browser encrypted DNS. |
| **Steered addresses** | Route destination IPv4 addresses or CIDR networks through this tunnel using firewall sets and policy rules. This does not depend on DNS or `dnsmasq-full`. |
| **Excluded devices** | Keep selected MAC addresses on the normal WAN route even when this tunnel routes all LAN traffic or otherwise steers traffic. Their DNS is also kept on the normal resolver path. |
| **Excluded domains and addresses** | Keep destinations on the normal WAN route. Domain exclusions use dnsmasq and have the same DNS and `dnsmasq-full` requirements as domain steering; IPv4 address/network exclusions do not. |
| **Kill switch** | Add rules that prohibit routed traffic from falling through to the WAN when the tunnel's routing table has no working tunnel route. It applies to traffic assigned to this instance; unrelated networks keep their normal connection. |
| **Block direct IPv6** | Block IPv6 for traffic assigned to this tunnel. NordLynx carries IPv4, so leaving IPv6 unblocked can let IPv6-capable clients bypass it. |
| **IP masquerading** | NAT client source addresses to the tunnel address before sending traffic through the VPN. Keep this on unless the provider can route replies back to the LAN addresses; disabling it commonly breaks connectivity. |
| **DNS: Off** | Leave DNS on the router's existing resolver configuration. |
| **DNS: NordVPN standard / Threat Protection** | Use NordVPN's standard resolver or its DNS filtering for ads and malware. Routed DNS is sent through the tunnel. With all-LAN routing the router resolver is locked to NordVPN DNS; with steering, steered clients' IPv4 DNS is redirected while other clients keep normal DNS. |
| **DNS: Custom** | Send DNS through up to four supplied IPv4 resolver addresses (for example Quad9 or a private resolver). The same routing and DNS lock behavior applies as for NordVPN DNS. |

For the details and limits of DNS, IPv6 and kill-switch protection, see the
[leak prevention guide](../README.md#preventing-leaks).

## Recovery: automatic reconnect and scheduled rotation

| Option | Purpose and what happens under the hood |
| --- | --- |
| **Automatic rotation** | Periodically select and verify another matching server. A pinned server disables rotation. **Rotate now** starts a one-time rotation. |
| **Schedule: Every N hours** | Rotate after the selected interval (1, 3, 6, 12 or 24 hours). |
| **Schedule: At specific time** | Rotate once a day at the selected time in the router's local timezone. The page reports the next scheduled run. |
| **Auto-reconnect (watchdog)** | Monitor tunnel handshakes and, if Internet check is enabled, probe results. When the tunnel is stale or has no egress, try another eligible server with backoff. It is unavailable while a server is pinned. |
| **Internet check** | Every 30 seconds, ping the configured IPv4 targets through the tunnel. Three consecutive failed checks mark the tunnel as having no internet; the watchdog can then replace its server. |
| **Check targets** | IPv4 addresses to probe. Any one successful reply passes the check. Empty uses `1.1.1.1` and `8.8.8.8`. |

## Advanced settings

| Option | Purpose and what happens under the hood |
| --- | --- |
| **Interface name** | Name of the managed WireGuard interface. Changing it after setup creates the tunnel under the new name; use care because manually created objects tied to the old name may need cleanup. |
| **Routing table** | Name or number of the policy-routing table for this instance. Empty uses the interface name when routing is managed, or the main table otherwise. This changes routing rules without rebuilding the WireGuard tunnel. |
| **MTU** | Maximum packet size on the WireGuard interface. Empty uses netifd's 1420 default. The page recommends WAN MTU minus 80; lower values can help with fragmented or stalled connections, especially on cellular uplinks. TCP MSS clamping remains enabled as a backstop. |
| **Connection wait** | Seconds to wait for a WireGuard handshake from each candidate server before rejecting it. Higher values tolerate slow links but can make apply/rotation take longer. |
| **Max server attempts** | Maximum candidate servers a rotation can try before it reports failure. Each candidate is still checked for a handshake. |
| **Server selection: Balanced** | Prefer lower-load servers while spreading choices among candidates. Load information comes from the server-list cache. |
| **Server selection: Lowest load first** | Try the lowest reported-load eligible server first. |
| **Server selection: Random** | Choose eligible servers randomly. |
| **Cache directory** (Global settings) | Location of the downloaded NordVPN server list, shared by all instances. Empty uses `/tmp`. Persistent or system directories that are unsafe for this cache are rejected. |
| **Server cache / Refresh server list** (Global settings) | Shows server-list age and server count; refresh fetches current locations, server metadata and load values from NordVPN for later selection. |

## Status, actions, and updates

| Control or display | What it does |
| --- | --- |
| **Status** | Shows configuration and live tunnel state separately. Connected means a recent WireGuard handshake; the page also displays selected/connected location, public IP/protection information when available, uptime and traffic. |
| **Reconnect** | Reapply this instance's settings and choose a server if needed. The current server is retained when it still matches the configuration. |
| **Recent events** | Shows recent connects, rotations, recoveries and errors recorded by the backend. |
| **Package updates** | Downloads and installs both packages from a GitHub release. Choose the latest release or a specific version/tag. Save or discard pending settings first; LuCI services restart after installation, then reload the page. |

The backend also provides the same core management over ubus and command-line
tools; see the [repository README](../README.md) for installation, API and
configuration-file references.
