# Troubleshooting

## First checks

For an application failing on one LAN device, use **Services → Xray Traffic
Inspector**. Select the device and expected path, capture for 60 seconds, and
reopen the application. The report distinguishes Xray route selection from
kernel CN bypasses and logged connection errors. Starting/stopping capture
never restarts Xray; changing its log level is a separate confirmed operation.
See [the capture guide](TRAFFIC-INSPECTOR.md).

```sh
xrayctl doctor
xrayctl validate
xrayctl status
xrayctl logs 200
```

`validate` checks both the Xray configuration and the full fw4-generated
ruleset before anything is applied.

## Emergency rollback

Keep the current SSH session open during first deployment. To return LAN
traffic and DNS to the pre-project state:

```sh
xrayctl stop
```

If the wrapper itself cannot run:

```sh
rm -f /usr/share/nftables.d/table-post/30-xray-router.nft
/etc/init.d/firewall reload
ip -4 rule del priority 10010 2>/dev/null
ip -4 route del local 0.0.0.0/0 dev lo table 100 2>/dev/null
cp /etc/xray-router/backups/dhcp.before-xray-router /etc/config/dhcp
/etc/init.d/dnsmasq restart
/etc/init.d/xray-router stop
```

Adjust the mark/table/priority commands if you changed `settings.conf`.

## Xray will not start

Common causes:

- `proxy-main` is still the intentional blackhole placeholder.
- PassWall2 or the package-provided `/etc/init.d/xray` still owns the Xray
  process or listening ports.
- The TProxy and nft socket kernel modules are absent.
- `geoip.dat` or `geosite.dat` is missing from `XRAY_ASSET_DIR`.
- `TPROXY_PORT` or `XRAY_DNS_PORT` no longer matches `config.json`.
- Your installed Xray is older than the fields used by the supplied current
  configuration. Use `xray version` and adapt the JSON to that release.

Check port ownership with whichever command is installed:

```sh
ss -lntup
netstat -lnptu
```

## DNS failure

Confirm Xray listens on port 1053 and dnsmasq points to it:

```sh
netstat -lnptu | grep 1053
uci show dhcp.@dnsmasq[0] | grep -E 'noresolv|server|cachesize'
nslookup baidu.com 127.0.0.1
nslookup openai.com 127.0.0.1
```

Prefer literal IP addresses for both proxy servers. If a server's `address` is a
domain, pin that server name in Xray's `dns.hosts` or otherwise provide a
bootstrap resolution path; a global DoH request cannot use a proxy whose own
address is waiting on that same DoH request.

Browser Secure DNS/DoH does not use dnsmasq's split-DNS path. Disable it during
diagnosis. The DoH HTTPS connection is still normal client traffic and will be
routed by Xray when it enters the transparent path.

## Backup does not take over, or primary does not recover

- Replace the `proxy-backup` blackhole with a usable node; keep its tag.
- Ensure `observatory.subjectSelector` and the balancer's `selector` contain
  only `proxy-main`, and `fallbackTag` is `proxy-backup`.
- Verify `probeUrl` is reachable through the primary. An outage of the probe
  destination also makes the primary appear unhealthy. The default pause is
  10 seconds; allow additional time for a failed probe to finish.
- Confirm the force-proxy and default rules use `proxy-failover`.
- DNS has no failover: global queries still use `proxy-main`. If DNS cache
  misses fail during an outage, test client failover with a known destination
  IP or a previously resolved name.
- For UDP-only failures, verify both proxy nodes support UDP. HTTP probes do
  not prove UDP health.

For a controlled test, make the primary endpoint unavailable, then open a new
global connection from a LAN client after the probe fails and verify the
backup's public IP. Restore the primary and verify a new connection returns to
its public IP after a successful probe. Existing sessions need to reconnect.

For health-probe details, temporarily set `log.loglevel` to `info`, run
`xrayctl restart`, and inspect `xrayctl logs 200`. Restore `warning` afterward.
Reinstalling scripts preserves the installed JSON; older installations need
the configuration changes merged as described in the README.

## A domestic service still exits through the VPS

Inspect its resolved address and whether the nftables CN set contains it:

```sh
nslookup service.example 127.0.0.1
nft list set inet fw4 xray_cn4
```

If the address is outside mainland ranges, add the root domain to the
`FORCE-DIRECT` rule in `config.json`. That flow will enter Xray and can be sent
directly based on sniffed SNI/Host.

If you need the opposite—force proxy for a domain that resolves to a CN
address—set `ENABLE_CN_FASTPATH=0`. Otherwise nftables returns the packet before
Xray can see the domain.

## Inspect the actual interception state

```sh
nft list chain inet fw4 xray_prerouting
ip -4 rule show
ip -4 route show table 100
fw4 print | grep -n xray
```

Counters on the `xray_prerouting` rules show whether packets are taking a
reserved/CN fast path or reaching TProxy.

## Client does not enter the chain

Verify that:

- The client uses this OpenWrt device as its default gateway.
- Its ingress bridge/device is listed in `LAN_INTERFACES`.
- The client is using IPv4. This project blocks global IPv6 by default rather
  than transparently proxying it.
- A guest or VLAN interface has been added explicitly if it should be managed.
