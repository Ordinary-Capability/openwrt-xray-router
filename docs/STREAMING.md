# Dedicated streaming outbound

Use `proxy-stream` for Netflix, Amazon Prime Video, HBO/Max, and Disney+ on one
VLESS/REALITY node. Other proxied traffic continues using the primary/backup
balancer. Matching streaming connections have no automatic fallback: if the
streaming node is unavailable, they fail instead of switching exit regions.

This is an optional configuration. The shipped `proxy-stream` is a blackhole
and `STREAMING-PROXY` matches only `domain:example-stream.invalid`. Installing
the project does not activate streaming rules for real domains.

## Configure and enable in LuCI

Open **Services → Xray Router → Streaming outbound** after installing the
updated UI with `sh scripts/install-luci.sh` and signing into LuCI again.

1. Choose **VLESS REALITY template** and fill in the actual server address,
   port, UUID, server name, public key (`password` in this Xray syntax), and
   short ID in **Outbound JSON**. Existing advanced transport fields are
   retained when editing a configured node. Prefer a literal server IP.
2. Click **Add streaming service presets** for Netflix, Prime Video, HBO/Max,
   and Disney+. The button adds missing groups without deleting custom
   domains. Edit **Streaming domains** to remove services or add others.
3. Set **Streaming routing** to **Enabled**. If streaming destinations with
   CN IPs must also use this node, disable **CN IPv4 fast path** under Routing.
4. Click **Save & Apply**. Validation checks the node and GeoSite groups before
   installing the candidate configuration. A running service restarts; a
   stopped service stays stopped. Failed application uses the existing
   configuration rollback flow.

The UI creates missing streaming objects for older installations during save.
It rejects enabling a blackhole node or an empty domain list. It cannot check
that the streaming provider accepts your node's exit IP; test actual playback
after applying. DNS retains the separate policy described below.

## Configure through SSH

1. In `/etc/xray-router/config.json`, replace the outbound tagged
   `proxy-stream` with `examples/outbound-stream-vless-reality.json`. Supply the
   actual server address/port, UUID, REALITY server name, server public key,
   and short ID. The example uses the current Xray REALITY `password` field
   for the server public key, as in the project's other VLESS example. It is
   not an account password. Use transport and flow settings matching your
   server; the template assumes raw TCP with `xtls-rprx-vision`.
2. Keep the tag `proxy-stream` and socket mark `2`. Prefer the node's literal
   IPv4 address. A domain address requires a bootstrap `dns.hosts` mapping as
   described in the README. Add its literal endpoint to
   `/etc/xray-router/proxy-server-ipv4.txt`.
3. Replace the entire rule tagged `STREAMING-PROXY` with
   `examples/routing-streaming.json`. Keep it immediately after `FORCE-DIRECT`
   and before `FORCE-PROXY`. Do not add a duplicate rule with the same tag.
4. Set `ENABLE_CN_FASTPATH="0"` in `/etc/xray-router/settings.conf` if the
   streaming route must also capture destinations with CN IPs. Otherwise
   those destinations can bypass Xray in nftables. Disabling the fast path
   means more traffic is processed by Xray on the Pi 3B.
5. Validate before applying:

   ```sh
   xrayctl validate && xrayctl restart
   ```

The preset uses `geosite:netflix`, `geosite:primevideo`, `geosite:hbo`,
and `geosite:disney`. The installed `geosite.dat` must contain all four groups;
validation reports a missing group. Use a compatible, maintained GeoSite
database or replace unavailable groups with explicit `domain:` entries.
`xrayctl update-cn` updates the APNIC IPv4 fast-path list, not GeoSite data.

For an older installation without the streaming objects, add the configured
outbound to `outbounds` and insert the preset rule at the position described
above. Reinstallation preserves your installed configuration; do not replace
the whole file with the repository template and lose existing node details.

Only enable the preset after replacing the blackhole. Xray considers a
blackhole a valid outbound; configuration validation alone cannot establish
that a streaming node works or that a service accepts its exit IP.

## Rule priority and additional services

DNS handling and private-address bypass retain priority. An explicit
`FORCE-DIRECT` match also wins. The streaming rule wins over `FORCE-PROXY`,
CN rules inside Xray, and the default proxy rule. Remove a conflicting
force-direct entry if that domain should use the streaming node.

Add more entries to the streaming rule's `domain` array, for example
`domain:another-streaming-service.example` or a supported `geosite:` group.
`domain:` includes subdomains; `full:` matches one exact hostname. Entries
within this array are alternatives. The Prime Video group avoids sending
all Amazon shopping/AWS traffic through the streaming node, though services
may still share domains. Avoid broad shared CDN ranges unless you intend to
route unrelated users of those CDNs too.

To pin an IP or subnet, add a separate `field` rule beside `STREAMING-PROXY`
with `inboundTag: ["tproxy-in"]`, an `ip` array, and
`outboundTag: "proxy-stream"`. Do not put domain and IP lists in the same rule
to express an alternative: different fields require both conditions.

The preset does not limit ports or transports, so it covers matching TCP and
UDP traffic. Transparent domain matching relies on HTTP Host, TLS SNI, or
QUIC sniffing. ECH, unrecognized traffic, and domains missing from the lists
can prevent identification. Test both the service's website and playback on
the actual client device. Node location alone does not guarantee availability;
the provider may reject a datacenter exit IP or impose account-region rules.

## DNS and region

These streaming rules control client connections. They do not move DNS to
`proxy-stream`: CN DNS stays direct, global DNS uses `proxy-main`, and
non-A/AAAA queries also use `proxy-main`. Consequently, a primary-node outage
can still prevent uncached streaming names from resolving. A stream node in
a different region may receive unsuitable CDN answers or encounter region
checks based on inconsistent DNS and traffic exits.

If that happens, configure a dedicated Xray DNS server entry matching the
same streaming domain groups, tag it (for example `dns-stream`), and route that
tag through `proxy-stream` before broader DNS rules. Its selection/fallback
policy needs to be tested with the installed Xray version. This is a separate
DNS change; the supplied routing preset does not provide it. Browser/app
encrypted DNS can also bypass the router's normal domain-based DNS selection.

## Disable streaming

In LuCI, set **Streaming routing** to **Disabled**, then **Save & Apply**.
The node credentials and domain list remain saved. Re-enabling restores the
same domain selection. This switch affects the streaming domain rule; custom
IP rules targeting `proxy-stream` remain independently active.

For SSH administration, the disabled rule uses
`"inboundTag": ["xray-router-stream-disabled"]`; that tag is reserved and must
not be assigned to an inbound. Enabling restores `["tproxy-in"]`. Domains stay
in the rule and Xray still validates their GeoSite references while disabled.
The original `["domain:example-stream.invalid"]` domain placeholder is also
recognized as inactive. Keep domain lists nonempty in saved JSON.

## Offline verification

Run `python tests/test-streaming.py /path/to/xray` with Node.js, a current Xray binary
and compatible `geoip.dat`/`geosite.dat` beside it (or set
`XRAY_LOCATION_ASSET`). The test uses local stand-ins for the nodes and never
connects to the streaming services. It generates enabled/disabled configuration
through the LuCI model and checks real Xray GeoSite selection,
rule priority, preservation of primary/backup selection, and failure without
fallback when the streaming node is down. It does not test REALITY credentials,
router nftables, or actual service access.
