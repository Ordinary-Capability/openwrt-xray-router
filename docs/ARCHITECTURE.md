# Architecture

This project deliberately separates packet capture from policy.

```mermaid
flowchart TD
    LAN[LAN clients] --> NFT[fw4 / nftables]
    NFT -->|private, proxy IP, optional CN IP| FAST[kernel direct path]
    NFT -->|other IPv4 TCP/UDP| XRAY[Xray TProxy]
    XRAY --> DIRECT[direct outbound]
    XRAY --> BAL[proxy-failover balancer]
    BAL -->|healthy| PROXY[proxy-main outbound]
    BAL -->|primary unavailable| BACKUP[proxy-backup outbound]
    DNSMASQ[dnsmasq cache] --> DNSIN[Xray DNS listener]
    DNSIN --> CNDNS[CN DNS direct]
    DNSIN --> GDNS[global DNS through proxy]
```

## Runtime responsibilities

| Layer | Responsibility | Deliberately excluded |
| --- | --- | --- |
| dnsmasq | DHCP, local host names, `/etc/hosts`, downstream DNS cache | GeoSite/GeoIP policy and proxy selection |
| fw4/nftables | Capture selected LAN IPv4 TCP/UDP; bypass reserved, proxy-server, and optional CN IPv4 ranges | Domain policy and node selection |
| Linux policy routing | Send mark `0x1` to local table `100`, where the Xray transparent socket receives it | Geographic decisions |
| Xray | DNS selection, sniffed-domain routing, direct/proxy decisions, remote protocol | DHCP and LAN host database |

## Packet path

The generated chain is a base chain in `table inet fw4` at mangle priority. It
only handles packets entering through `LAN_INTERFACES`. Router-originated
traffic is intentionally outside the transparent path, preventing Xray's own
connections from looping back into Xray.

Known CN IPv4 destinations can return from nftables before TProxy. This is the
performance optimization: those flows retain the normal kernel forwarding/NAT
path. Disable it with `ENABLE_CN_FASTPATH=0` when domain-level force-proxy
overrides are more important than the fast path.

Unknown or foreign destinations enter Xray at `127.0.0.1:12345`. Sniffing uses
HTTP Host, TLS SNI, or QUIC metadata for domain rules while `routeOnly=true`
retains the client's original destination address.

## DNS path

dnsmasq listens on the normal LAN/router port 53 and forwards cache misses to
Xray at `127.0.0.1:1053`.

For A/AAAA requests, the `dns-out` outbound hijacks the request into Xray's
built-in DNS module:

- `geosite:cn` uses `223.5.5.5` through the direct outbound.
- `geosite:geolocation-!cn` uses Cloudflare DoH through `proxy-main`.
- unmatched names use the global DoH server through `proxy-main`.

Other query types are forwarded to `1.1.1.1:53` through `proxy-main`. This
avoids silently discarding non-address DNS records, while the routing-critical
A/AAAA responses still use Xray's split DNS and cache.

Traditional TCP/UDP port-53 queries that a client sends to an external resolver
are also caught by the TProxy inbound and routed to `dns-out`. Encrypted browser
DoH is ordinary HTTPS traffic and cannot be treated as a plaintext DNS packet.

## Primary and backup selection

Xray's observatory checks HTTP reachability through `proxy-main`. The
`proxy-failover` balancer selects that single candidate with `leastPing` when
healthy, and otherwise uses its `fallbackTag`, `proxy-backup`. Keeping only the
primary in the selector preserves primary preference regardless of backup
latency. Probing continues during an outage, allowing automatic recovery.

The force-proxy and default client traffic rules use the balancer. DNS keeps
its original policy: global DNS and non-address queries use `proxy-main`,
and CN DNS goes direct. There is no DNS failover, so global DNS cache misses
can fail during a primary outage even when the backup carries client traffic.

Selection applies to new connections/sessions after health results change.
Before the first successful primary probe, the backup is selected. Failed
connections are not replayed, and existing sessions are not migrated. If the
backup is also unavailable (or remains the shipped blackhole), proxied traffic
fails closed. Direct/CN traffic retains its existing routing policy.

## Stop and failure behavior

`xrayctl stop` first restores the saved dnsmasq baseline, then removes the
TProxy service and policy routing. This gives a clean direct-network rollback.

The persistent fw4 include is a symlink to `/tmp/xray-router/30-xray-router.nft`.
The target is created only while the service is active. Because `/tmp` is
cleared at boot, an unclean shutdown cannot make fw4 load stale interception
rules before Xray and its policy route are ready.

If the Xray process crashes, procd respawns it. During that short interval the
TProxy rule remains active, so intercepted traffic fails closed rather than
leaking directly. Use `xrayctl stop` for an intentional fail-open rollback.
