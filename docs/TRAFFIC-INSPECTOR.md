# Traffic Inspector

The **Inspector** tab under **Services → Xray Router** diagnoses traffic from
one LAN IPv4 address. It collects actual Xray route/access records and sampled
nftables trace events. Starting, stopping, or timing out a capture never edits
the Xray configuration, restarts Xray, or reloads the firewall.

## Install and use

Copy the updated project to OpenWrt and run `sh scripts/install-luci.sh` from
the project directory, then sign into LuCI again and refresh the page. The
inspector uses the existing Lua/jsonc/nixio packages, `logread`, and an `nft`
build supporting JSON output and `monitor trace`. No tcpdump or gRPC client is
required. The OpenWrt SDK package includes the new files automatically.

1. Open **Services → Xray Router → Inspector**.
2. Select a DHCP/ARP device suggestion or type its IPv4 address. Choose an
   expected path if you want mismatches highlighted: Direct, Normal proxy
   (primary or backup), Streaming, Streaming 2, Primary only, or Backup only.
3. Choose 30, 60, or 120 seconds and click **Start capture**. Reopen the affected
   app to establish new connections, then reproduce the issue. The gateway
   normally cannot identify which application owns each connection, so close
   unrelated applications when practical.
4. Filter by IP, domain, path, or rule, or select **Only unexpected paths or
   errors**. Open **Details** for the evidence behind a row. A known hostname
   provides an exact `full:` entry you can copy into the appropriate routing
   list in the **Routing** tab. Switching tabs retains the capture and form edits.
5. Click **Stop / clean up**, or allow the capture to expire. **Download
   report** exports the displayed capture as JSON, including device/domain
   metadata and raw evidence. Review it before sharing.

## Reading the results

- **Destination:** original address/port from access logs or kernel packet
  records when available. A route-decision line alone may instead name the
  hostname used for routing; `route_target` in Details identifies that value.
- **Hostname evidence:** `sniffed` means Xray reported HTTP Host, TLS SNI, or
  QUIC metadata. `xray-destination` means an access record named the domain.
  DNS associations are candidates from observed queries/answers; shared CDN
  addresses make them ambiguous. Unknown stays unknown.
- **Actual path:** the selected Xray outbound, an observed kernel bypass, or
  unknown. `proxy-main` and `proxy-backup` count as Normal proxy. `dns-out` and
  router-local traffic are not marked as unexpected application exits.
- **Rule / kernel decision:** matched `ruleTag` at info logging, or an
  observed CN/private/proxy-endpoint bypass. `TPROXY` confirms interception;
  without a subsequent Xray record it does not prove outbound selection.
- **Result:** route selection is not connection success. Correlated Xray
  failures and firewall drop/reject events appear separately. Silence cannot
  establish that playback or an HTTPS request succeeded.

For example, streaming traffic marked **kernel-direct / CN-FASTPATH** bypassed
Xray before domain rules could run. Traffic marked **proxy-main /
DEFAULT-PROXY** reached Xray but did not match an earlier streaming rule.
**proxy-stream / Error logged** selected the intended node and then encountered
a logged error; changing the domain list may not fix that problem.

The collector correlates info logs by Xray session ID and the selected client
source. Xray may log a sniffed domain as its routing target and the original IP
in its access record. These records merge only for a unique pending source
port/protocol/destination-port/path combination within two seconds. Ambiguous
or incomplete records remain separate instead of inventing attribution.

## Logging and restarts

Capture reads the existing system log at the existing level. With the shipped
explicit `log` section, Xray 26.9.9 emits access records at `warning`, so the
selected outbound is available; sniffed domains, matched rule names, and many
connection errors require `info`. Other Xray versions/log configurations may
provide less information. The page labels the saved level; an external edit
without a restart may differ from the running process.

**Logging settings (may restart Xray)** exposes two separate actions:

- **Enable info logging…** changes only `log.loglevel` to `info`.
- **Restore warning logging…** changes only `log.loglevel` to `warning`.

Both require a UI confirmation explaining that active proxied connections will
be interrupted. They use the existing Save & Apply/rollback path;
a running service restarts and a stopped service stays stopped. Info logging
remains enabled until explicitly restored. Finishing a capture never switches
the level back and never triggers a second restart. Custom access/error log
destinations remain unchanged and are not read by this inspector. With default
console logging, OpenWrt logd's bounded RAM ring holds the log.

The inspector does not enable dnsmasq query logging or change DNS settings.
Query/answer associations appear only if dnsmasq is already logging them.
Encrypted DNS, client caches, and cached names predating the capture may leave
DNS information unavailable. Logs from Xray's local DNS inbound cannot, by
themselves, identify the original client behind dnsmasq.

## Limits and cleanup

Only one capture runs at a time. The selected `LAN_INTERFACES` must be literal
device names in settings.conf. A separate `inet xray_router_inspect` table
sets `nftrace` on sampled new TCP/UDP packets from the selected IPv4 address
on those interfaces, just before the project's interception chain. It adds no
TProxy/NAT rules or forwarding verdicts. Sampling is limited to 5 packets per
second with a burst of 10. This is packet sampling, not a complete flow record.

The tracing source is a timed nftables set element. It expires within the
chosen duration after installation even if the collector is killed. A
finished capture removes only the table carrying its exact ownership token.
On nft 1.0.2, which omits table comments from JSON, cleanup verifies the
table's leading comment in text output instead; nested comments do not count.
The worker terminates its own `nft monitor trace` and `logread` helpers on
normal exit. A failed cleanup is reported and retains the capture lock for
**Stop / clean up** recovery. Read-only requests never remove tables.

Capture data lives in root-only `/tmp/xray-router-inspector`; it is replaced
by the next capture and cleared on reboot. The parser holds at most 500 rows,
1024 tracked sessions/trace IDs each, 100 DNS queries, and eight short evidence
items per row. Published snapshots are capped at 192 KiB; omitted rows are
reported. Collection stops automatically even if the browser closes.

IPv6 traffic, including this project's global IPv6 block, is not captured in
this first version. Existing or flow-offloaded connections may not produce
new prerouting events. nft trace parsing depends on the installed nft output
format; raw packet/rule evidence is included for recognized flows. Unmatched
domains, ECH, and router-originated traffic may not have the expected evidence.

LuCI stack changes are blocked while capture holds its lock, apart from the
emergency Stop action. Stop/clean up a capture before installing/uninstalling.
Avoid simultaneous CLI configuration changes; the report warns when the JSON
or settings file changes during capture. The observation table is separate
from fw4; normal capture does not require a firewall reload.

## Verification

```sh
node tests/test-inspector-ui.js
python tests/test-inspector.py
python tests/test-luci-backend.py
python tests/test-inspector-xray.py /path/to/xray
sh scripts/validate-project.sh
```

Python tests need `lupa` with Lua 5.1. Isolated tests cover parser attribution,
source filtering, bounds, timeout/Stop cleanup, cleanup failure recovery,
unrelated-table protection, ACL signatures, log-change rollback, and explicit
restart confirmation. The Xray integration test makes only local connections
and parses actual info/warning logs. A browser preview using simulated data is
available at `/tests/inspector-preview.html` when serving the repository with
`python -m http.server 8765 --bind 127.0.0.1`.

Live nftables/procd/rpcd behavior still needs on-router testing: confirm access
to the RPC methods, capture a known direct and proxied connection, verify the
reported paths, and check `nft list table inet xray_router_inspect` reports no
table after completion. Test logging changes separately during a suitable
maintenance window; verify the new level and restored warning level.
