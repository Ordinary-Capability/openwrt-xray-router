# OpenWrt Xray Router

A small, editable replacement for the PassWall2 decision path on a Raspberry Pi
3B running modern OpenWrt. nftables only captures packets and provides optional
CN IPv4 fast paths; Xray owns DNS and domain/IP routing policy; dnsmasq remains
the DHCP, LAN-name, and downstream-cache service.

The project is intentionally a starting point. It contains no usable proxy
credential or node. The shipped `proxy-main` outbound is a blackhole and
`xrayctl start` refuses to activate it until you replace that object.

## Scope and assumptions

- OpenWrt 22.03 or later using firewall4 (`fw4`) and nftables.
- Current Xray configuration syntax. The supplied JSON was written against the
  current Xray documentation in September 2026; run `xrayctl validate` against
  your installed binary before applying it.
- IPv4 transparent proxy for forwarded LAN clients only.
- Router-originated traffic is left direct, which avoids an Xray outbound loop.
- Global IPv6 from managed LAN interfaces is blocked by default. Local,
  link-local, and multicast IPv6 are left alone.
- dnsmasq remains installed for DHCP/local names/cache and sends cache misses to
  Xray's DNS listener.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the packet and DNS paths.

## Project layout

```text
openwrt-xray-router/
├── README.md
├── install.sh
├── uninstall.sh
├── config/
│   ├── config.json               Xray DNS/inbound/outbound/routing policy
│   ├── settings.conf             LAN, ports, marks, table, feature switches
│   ├── cn-ipv4.txt               generated CN kernel-fast-path prefixes
│   ├── proxy-server-ipv4.txt     optional literal proxy endpoint IPs
│   └── dnsmasq-uci.txt           reference copy of the UCI changes
├── src/
│   ├── xrayctl                   top-level stack manager
│   ├── xray-router.init          procd service
│   └── policy.sh                 fw4 generation and policy routing
├── examples/
│   ├── outbound-vless-reality-xray-26.json
│   └── outbound-socks5.json
├── docs/
│   ├── ARCHITECTURE.md
│   └── TROUBLESHOOTING.md
├── scripts/
│   └── validate-project.sh
└── tests/
    ├── test-policy.sh
    ├── test-placeholder.sh
    └── test-failover.py
```

`tests/test-policy.sh` provides an isolated lifecycle test for generated fw4
state and policy-route cleanup; it uses fake system commands and changes no
router networking.

`tests/test-placeholder.sh` checks the primary placeholder guard using OpenWrt's
`jsonfilter`. Run `sh scripts/validate-project.sh` for the shell checks (the
placeholder test reports a skip if `jsonfilter` is absent).

On a development machine with Python 3 and a current Xray binary, run:

```sh
python3 tests/test-failover.py /path/to/xray
```

This offline integration test runs Xray against local endpoints and checks
primary preference, outage failover, recovery, and failure of both nodes for
default TCP/UDP traffic and force-proxy traffic. It also checks that global DNS routing
and TXT DNS forwarding stay on the primary. It requires the newer DNS/tunnel
syntax used by the supplied JSON;
older binaries may silently ignore those fields even when `run -test` passes.

Installed administrator files live under `/etc/xray-router`. Reinstalling
refreshes program scripts but does not overwrite those administrator files.

## 1. Prepare OpenWrt

The exact package names depend on your OpenWrt release and repository. A normal
fw4 installation needs Xray, the nftables TProxy/socket kernel support, CA
certificates for DoH, and an `ip` command that supports policy routing. For
official repositories, start with:

```sh
opkg update
opkg install xray-core kmod-nft-tproxy kmod-nft-socket ca-bundle ip-full jsonfilter
```

dnsmasq is already part of a normal OpenWrt installation. Do not install both
iptables and nftables versions of a transparent-proxy rule set.

Stop PassWall/PassWall2 and any existing Xray instance before activating this
project. The installer deliberately does not disable them for you:

```sh
/etc/init.d/passwall2 stop 2>/dev/null
/etc/init.d/passwall2 disable 2>/dev/null
/etc/init.d/xray stop 2>/dev/null
/etc/init.d/xray disable 2>/dev/null
```

Only run the commands for services that you actually intend to replace.

## 2. Copy and install

From Windows PowerShell, for example:

```powershell
scp -r .\openwrt-xray-router root@192.168.1.1:/root/
```

On OpenWrt:

```sh
cd /root/openwrt-xray-router
sh install.sh
```

Installation only copies files. It does not start Xray, load TProxy rules, or
change dnsmasq.

## 3. Tune the configuration

Edit both files:

```sh
vi /etc/xray-router/config.json
vi /etc/xray-router/settings.conf
```

### Replace `proxy-main`

In `config.json`, replace the first outbound object—the one tagged
`proxy-main`—with your actual VLESS, VMess, Trojan, Shadowsocks, SOCKS, or other
supported outbound. Preserve this tag exactly:

```json
"tag": "proxy-main"
```

The examples directory contains current-format VLESS+REALITY and SOCKS5 object
shapes. They are snippets, not credentials; every example value must be
replaced.

Prefer a literal IP as the proxy server `address`. If you use a domain, provide
a bootstrap mapping in Xray `dns.hosts`; otherwise global DNS may wait for the
same proxy whose address is still unresolved. Put literal endpoint IPs in:

```text
/etc/xray-router/proxy-server-ipv4.txt
```

Keep outbound socket mark `2` if you later add router-output interception. The
current LAN-only implementation does not capture router-originated sockets, but
the mark makes that future extension safer.

### Configure automatic failover

Replace the `proxy-backup` blackhole outbound with your second node, keeping
`"tag": "proxy-backup"`. You can copy either outbound example and change its
tag and connection details. Configure both nodes' endpoint IPs (or bootstrap
`dns.hosts` mappings) as described above; retain socket mark `2` on both.

The supplied configuration already connects the failover pieces:

- `observatory` probes `proxy-main` through the node using `probeUrl`, with a
  `10s` pause between probes. Choose a URL that is reliably reachable through
  your primary and returns HTTP 204.
- The `proxy-failover` balancer uses `leastPing` with **only `proxy-main`** in
  its selector. If the primary has no successful health result, its
  `fallbackTag` sends new connections to `proxy-backup`. A successful later
  probe automatically returns new connections to the primary.
- Force-proxy rules and default TCP/UDP traffic use this balancer.

DNS routing stays unchanged: CN DNS goes direct, while global DNS and
non-A/AAAA forwarding use `proxy-main`. There is no DNS failover; uncached
global DNS queries can fail while the primary is down, even when client
connections can use the backup.

Selectors match tag prefixes. Do not add other outbound tags beginning with
`proxy-main`, or add the backup to the selector: that would allow load balancing
instead of strict primary preference.

Failover follows health probes, so detection takes a probe interval plus the
time needed for a failed probe. Existing TCP connections and UDP sessions do
not migrate; clients must reconnect. Until the first successful probe after
startup, traffic may use the backup. If both nodes fail, proxied traffic fails;
there is no automatic direct fallback. The probe checks HTTP connectivity,
not every destination or UDP capability. Use nodes supporting UDP for the
project's UDP and non-address DNS forwarding.

The backup is optional: leaving its blackhole placeholder means proxy traffic
is blocked while the primary is considered unavailable, including startup.

After editing the installed configuration:

```sh
xrayctl validate
xrayctl restart
```

For an existing installation, reinstall the updated scripts, then manually
merge `observatory`, the `proxy-backup` outbound, `routing.balancers`, and the
`balancerTag` changes in `FORCE-PROXY` and `DEFAULT-PROXY` from the supplied
`config/config.json`. Reinstallation preserves your existing configuration.

### Tune domain policy

Replace the reserved `.invalid` examples in these two rules:

```text
FORCE-DIRECT
FORCE-PROXY
```

Use `domain:example.com` to match a root domain and all its subdomains. Rules
are evaluated top to bottom. The supplied order is:

1. DNS handling.
2. Private addresses direct.
3. Force-direct domains.
4. Force-proxy domains.
5. `geosite:cn` direct.
6. `geoip:cn` direct.
7. Everything else through the primary/backup proxy balancer.

### Check ports and interfaces

`TPROXY_PORT=12345` and `XRAY_DNS_PORT=1053` in `settings.conf` must match the
two inbound ports in `config.json`.

`LAN_INTERFACES` is a space-separated list of Linux device names, for example:

```sh
LAN_INTERFACES="br-lan br-guest"
```

Only clients arriving on those devices are captured.

### Choose correctness versus CN fast-path performance

With the default:

```sh
ENABLE_CN_FASTPATH="1"
```

destinations in `cn-ipv4.txt` bypass Xray entirely and remain in the kernel
forwarding path. This matters on a Raspberry Pi 3B during large domestic
downloads and preserves the best chance of OpenWrt flow offload.

The tradeoff is strict: a force-proxy domain that resolves to a CN IP will also
bypass Xray before its domain can be inspected. Set this to `0` if force-proxy
overrides must win for CN-addressed destinations.

## 4. Validate before changing traffic

```sh
xrayctl doctor
xrayctl validate
```

`doctor` checks commands, geodata, IPv4 forwarding, fw4 automatic includes,
the proxy placeholder, and another running Xray process. `validate` asks the
installed Xray binary to test the JSON and asks fw4 to compile the generated
nftables configuration without loading it.

Optionally populate the CN IPv4 fast path from APNIC's delegated statistics:

```sh
xrayctl update-cn
```

The updater downloads the source, converts only CN IPv4 allocations to CIDRs,
checks that the result is plausible, and reloads the firewall if the service is
already active. It does not download a pre-generated executable rule file.

## 5. Start and test

Keep an SSH session open for the first activation:

```sh
xrayctl start
xrayctl status
xrayctl logs 100
```

`start` performs one coherent operation:

1. Validate Xray and fw4.
2. Start Xray under procd.
3. Install the policy route and generated fw4 include.
4. Save a one-time `/etc/config/dhcp` baseline.
5. Point dnsmasq at `127.0.0.1#1053` and restart dnsmasq.

Test from one LAN client:

```sh
nslookup baidu.com
nslookup openai.com
```

Then verify one domestic and one global HTTPS site, UDP if you use it, and the
expected public source IP. Browser Secure DNS should be disabled while testing
the split-DNS path.

Only after the tests pass, enable boot startup:

```sh
xrayctl enable
```

## Daily management

```sh
xrayctl start
xrayctl stop
xrayctl restart
xrayctl status
xrayctl logs 200
xrayctl validate
xrayctl firewall-reload
xrayctl update-cn
```

Run `xrayctl help` for the complete command list.

`xrayctl stop` restores the saved pre-project dnsmasq file before stopping Xray
and removing interception. Because restoration is a full-file restore, do not
make unrelated `/etc/config/dhcp` edits while this stack is active. If you want
a newer stopped-state file to become the rollback point, run:

```sh
xrayctl stop
# make the intended dnsmasq/DHCP edits
xrayctl dnsmasq-save-baseline
xrayctl start
```

## Rollback and uninstall

Immediate direct-mode rollback:

```sh
xrayctl stop
```

Remove project programs but retain your tuned configuration and dnsmasq backup:

```sh
cd /root/openwrt-xray-router
sh uninstall.sh
```

Delete the retained `/etc/xray-router` configuration too:

```sh
sh uninstall.sh --purge
```

Neither form removes the `xray-core`, dnsmasq, nftables, or kernel packages.

## Important limitations

- This version does not transparent-proxy router-originated traffic.
- This version does not transparent-proxy IPv6. Global IPv6 is blocked by
  default to avoid a silent bypass; set `IPV6_MODE=bypass` only intentionally.
- Domain sniffing cannot identify every encrypted or non-HTTP protocol.
- The CN kernel fast path intentionally wins before Xray domain rules.
- Xray configuration syntax evolves. Always validate with the exact binary that
  will run on the router.
- A Raspberry Pi 3B has limited CPU and RAM. Proxied throughput depends mostly
  on the outbound protocol, encryption, transport, server, and Xray version.
  CN fast-path flows avoid Xray's userspace cost.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for recovery commands and
diagnostic cases.

## Documentation basis

- [Xray TProxy tutorial](https://xtls.github.io/en/document/level-2/tproxy)
- [Xray built-in DNS](https://xtls.github.io/en/config/dns)
- [Xray DNS outbound](https://xtls.github.io/en/config/outbounds/dns.html)
- [Xray routing](https://xtls.github.io/en/config/routing.html)
- [Xray observatory](https://xtls.github.io/en/config/observatory.html)
- [Xray tunnel inbound](https://xtls.github.io/en/config/inbounds/tunnel.html)
- [OpenWrt firewall4 nftables include layout](https://github.com/openwrt/firewall4/blob/master/root/usr/share/nftables.d/README)
- [OpenWrt's packaged Xray procd service](https://github.com/openwrt/packages/blob/master/net/xray-core/files/xray.init)
