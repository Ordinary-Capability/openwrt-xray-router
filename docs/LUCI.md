# LuCI management app

The optional `luci-app-xray-router` adds **Services → Xray Router** to the
existing OpenWrt web interface. It uses client-side JavaScript and a Lua
executable plugin registered with rpcd. It has no separate web server.

## Install on OpenWrt

Install the UI dependencies using the package manager for your release. For
an opkg-based installation:

```sh
opkg update
opkg install luci-base rpcd lua luci-lib-jsonc luci-lib-nixio jsonfilter
cd /root/openwrt-xray-router
sh install.sh --with-luci
```

On releases using apk, use `apk add` with the same package names. The service
itself still requires the dependencies listed in the main README. The UI also
uses BusyBox `sha256sum` to detect concurrent configuration changes.

If the service scripts are already up to date, install just the page:

```sh
sh scripts/install-luci.sh
```

The installer refreshes rpcd and clears LuCI's generated menu cache. Reload
the page after upgrading; sign in again if prompted. The script gives the view,
JavaScript dependencies and stylesheet content-versioned URLs, so an ordinary
reload fetches updated assets even when LuCI's own release version is unchanged.
Previous asset bundles remain available to pages already open during an upgrade
and are removed by the uninstaller. Xray is not started or restarted by installation. Existing service configuration is
preserved. Older installations need the primary/backup configuration described
in the README merged first.

The supplied Makefile can also be placed under a LuCI feed's `applications/`
directory and built using the OpenWrt SDK. The package contains the UI only;
install the service separately. The SDK package build has not been exercised
in the Windows development environment.

## Controls

There is one **Services → Xray Router** entry with three tabs:

- **Routing:** outbound assignment cards first, followed by ordered Xray rules, their outbound/balancer targets, and the
  corresponding node aliases and endpoints. Dropdowns assign library nodes to
  `proxy-main`, `proxy-backup`, and `proxy-stream`. This tab also holds routing, streaming-domain, and health-check
  settings in expandable sections. Kernel bypass rules take effect before Xray's ordered rules.
- **Proxy Nodes:** a reusable library of named nodes, such as `us-vps` and
  `jp-vps`, with Test and Edit on each row; Duplicate and Delete are under More. Each node has an alias
  and a complete outbound JSON object, with SOCKS5 and VLESS REALITY templates.
- **Inspector:** capture traffic for a selected LAN IPv4 device without
  restarting Xray, compare paths, inspect evidence, and export reports. See
  [Traffic Inspector](TRAFFIC-INSPECTOR.md).

Switching tabs keeps unsaved edits and Inspector results; it does not apply
configuration or restart the service. Save & Apply covers both configuration
tabs. Inspector log-level changes retain their explicit restart confirmation
and require saving or discarding any pending configuration edits first.
The old Inspector URL remains available for bookmarks but has no separate
Services menu entry. Xray's runtime configuration schema is unchanged.

The header shows service status and progress in a reserved space, so operations
do not move the tabs or their content. Detailed guidance is under expandable
help. Inspector keeps Connections and Logging settings permanently visible.

Each row in **Proxy Nodes** has a **Test** button and a Connectivity result.
Testing uses that node's current draft, including nodes that have not been saved
or assigned. A temporary Xray process listens only on loopback and sends one
HTTPS request to `https://www.gstatic.com/generate_204` through that node alone.
HTTP 204 counts as success; the displayed milliseconds measure the whole request,
including proxy setup and TLS. This checks HTTPS connectivity, not bandwidth,
UDP support, streaming access, or the normal routing rules. No other node is used
as a fallback. Nodes that reference another outbound cannot be tested alone.

The test requires `curl` and CA certificates (`opkg install curl ca-bundle` for
manual installations). The request times out after 15 seconds, and the temporary
Xray process is removed when the test finishes, with a 30-second watchdog if the
worker dies. Active Xray, routing, and saved files are unchanged. Results last
until the page reloads; editing a node's outbound clears its previous result.

- **Start, Stop, Restart:** call the existing stack manager. Stop restores the
  saved dnsmasq baseline as it does in the CLI. Start and Restart skip separate
  Xray and firewall preflight tests; use **Validate saved configuration** before
  restarting after manual edits. The real Xray process and firewall reload still
  parse their configuration and can fail. Startup waits for the new Xray PID
  to own all configured TCP listeners and the DNS/TProxy UDP sockets. An
  unchanged active firewall policy stays installed during ordinary restarts.
  DNS setup skips rewriting/restarting dnsmasq when its requested upstream,
  `noresolv` and cache settings already match, there are no pending DHCP UCI
  edits, and dnsmasq is running. Log-level and proxy-node changes normally
  leave DNS running. Changed DNS settings or a stopped dnsmasq still trigger
  a restart; Stop restores the baseline when needed.
- **Start on boot:** a switch controls the project's init service immediately.
- **Update CN IP list:** next to **Start on boot**, runs `xrayctl update-cn`
  in the background using the saved `CN_LIST_URL`. The final output appears in
  Diagnostics. It refreshes the active kernel fast path when the service is
  running, without restarting Xray or applying unsaved form edits. Stop an
  Inspector capture before updating. Download errors are shown in the output;
  the router needs access to the configured download URL. For an isolated VM,
  set `CN_DOWNLOAD_PROXY` in `/etc/xray-router/settings.conf` and install `curl`.
  For example, `http://192.168.80.2:10809` uses this test VM's Xray HTTP inbound
  and its configured outbound nodes. An explicit proxy never falls back to a
  direct connection; failed downloads retain the previous list.
- **Primary and backup:** choose nodes under **Outbound assignments**.
  One library node can serve multiple tags; each runtime copy receives the
  appropriate fixed tag. Templates contain example values to replace. Advanced
  protocol fields are preserved. Node aliases are independent of routing tags.
- **Streaming outbounds:** configure separate nodes in **Proxy Nodes** with the
  same outbound editor and VLESS REALITY/SOCKS5 templates. In **Routing**, assign
  each to `proxy-stream` or `proxy-stream2`, enable its streaming route, and add the
  Netflix/Prime Video/HBO/Max/Disney+ presets, or enter custom domains. Preset
  additions retain custom entries and avoid duplicates. Disable streaming
  without losing the node or domain list. An enabled streaming route requires
  a non-blackhole node and at least one domain. See [Streaming setup](STREAMING.md).
  The two lists are independent; `proxy-stream` wins overlapping matches.
  Stream 2 starts disabled, and Inspector can check it as **Streaming 2**.
- **Health checks:** set an HTTP(S) probe URL and an interval of 1–3600 seconds.
- **Routing:** select LAN interfaces, CN fast path, IPv6 handling, and forced
  domain rules. Bare domains become `domain:` entries. Empty domain lists use
  an inert `.invalid` placeholder so the rule cannot become a catch-all.
- **Diagnostics:** validate the saved configuration, run doctor, reload the
  firewall, inspect status details, or read logs. It starts collapsed and opens
  when an operation returns output or reports an error.

**Validate saved configuration** runs `xray run -test` and a firewall dry run.
The firewall step renders the project's TProxy/CN include, temporarily places
it where fw4 reads it, and runs `fw4 check` against the complete ruleset. It
then restores the previous include (or removes the temporary one). It does
not reload the live firewall or edit `/etc/config/firewall`; it can create the
project's include symlink when that link is missing. Starting the service still
installs the policy route and reloads the firewall to activate interception.

The primary is preferred for client traffic and, in the current configuration
template, global DNS. Both use `proxy-failover` after DNS migration; older
installations retain their saved DNS policy until the README migration is
applied. Check the `DNS-GLOBAL-PROXY` target in the route table. The status indicator reports
whether the service is running, not which outbound the health checker selected.
Probe details are available in Xray logs when its log level is `info`.

Streaming connects to its dedicated node without fallback. Force-direct
rules take priority, and CN fast path can bypass the streaming rules. Global
DNS follows its own primary/backup selection, which can produce a different
exit region from streaming. The page explains these limits beside the
streaming settings. Disabling streaming affects the domain rule only; any
separate custom IP rules configured through SSH retain their own behavior.

Older configurations without streaming objects load normally. Saving adds
only missing streaming outbounds and rules: `STREAMING-PROXY` after
`FORCE-DIRECT`, then `STREAMING2-PROXY`. New routes remain disabled until explicitly enabled. Existing
streaming objects and their additional fields are preserved; the UI can edit
only the node, domain list and enabled state, not rule order or destination.

## Node library and assignments

Use **Add node**, enter a unique alias and outbound JSON, then **Use node** to
update the draft. A pasted `tag` is removed: the Routing assignment supplies it.
**Save & Apply** saves both tabs. Renaming an alias retains its stable node ID,
so assignments remain intact. Editing an assigned node updates all tags using
it on apply. Unassign a node before deleting it; unconfigured slots block traffic.

The root-only `/etc/xray-router/nodes.json` stores schema version 1, a `nodes`
object keyed by stable IDs (`alias` and `outbound` per node), and a `bindings`
object mapping the four proxy tags to node IDs. Older version 1 libraries gain
an empty `proxy-stream2` binding when saved. An empty binding means
unconfigured. Up to 64 nodes and 256 KiB of library JSON are supported.
Unused nodes are checked for valid JSON structure; Xray checks their complete
protocol/transport configuration when they are assigned and applied.

On first load, existing configured outbounds are imported into the draft library
without writes or restarts. Existing blackholes remain unconfigured slots. A
SOCKS primary is initially named `host-socks`; aliases can be edited. If an SSH
edit changes a configured outbound later, the UI imports that current outbound
into a new draft node and displays a notice, retaining the old library node.

Adding unused nodes, changing aliases, or assigning an identical outbound saves
metadata without changing runtime files or restarting Xray. Changes to assigned
node contents or routing use the runtime apply and recovery flow. The
library and bindings are included in revision checking, backups, and recovery.

## Save, apply, and recover

1. The backend rejects changes made from a stale configuration revision.
2. JSON structure, editable fields and node assignments are checked without
   running Xray. Changed routing settings receive a firewall-only dry run in
   a private temporary directory. Logging and node-only edits skip that step.
3. Previous `config.json`, `settings.conf`, and optional `nodes.json` are kept in
   `/etc/xray-router/backups/luci-last/` with restricted permissions.
4. Candidate files replace the current files using individual atomic renames.
5. Runtime changes restart a running service. Library-only changes do not
   restart it. There is no `xray run -test`: the real startup detects Xray
   configuration errors. A stopped service remains stopped, and Xray checks
   its saved configuration on its next start.
6. If installation or restart fails, the backend restores the previous files
   and attempts to restart the previously running stack. Any failed recovery
   is reported in the diagnostics panel.

**Restore previous configuration** uses the same apply and recovery path.
The backup is one level deep. A failed firewall check does not replace it. A
successful ordinary restore retains the pre-restore state as the next backup.

Management progress polls once per second while an operation runs, and every
five seconds while idle. Inspector uses the faster interval during capture or
logging changes, and pauses its own polling when its idle tab is hidden.

An interrupted apply leaves `/etc/xray-router/backups/luci-pending`. The UI
shows a recovery notice and blocks further changes until the backup has been
restored. It still allows stopping the service. If the web interface cannot be
used, recover from SSH:

```sh
xrayctl stop
cp /etc/xray-router/backups/luci-last/config.json /etc/xray-router/config.json
cp /etc/xray-router/backups/luci-last/settings.conf /etc/xray-router/settings.conf
if [ -f /etc/xray-router/backups/luci-last/nodes.json ]; then
    cp /etc/xray-router/backups/luci-last/nodes.json /etc/xray-router/nodes.json
else
    rm -f /etc/xray-router/nodes.json
fi
xrayctl validate
# Only after validation succeeds:
rm -f /etc/xray-router/backups/luci-pending
xrayctl start
```

Only one web management operation runs at a time. Avoid simultaneous CLI
configuration/service changes while a web operation is in progress. The page
polls progress so long-running service commands do not depend on keeping an
HTTP request open. Closing the page does not cancel the operation.

## Permissions

The app uses existing authenticated LuCI sessions. Its rpcd ACL permits only
the app's named RPC methods; it grants no generic shell or filesystem access.
Read access includes the node credentials needed to display the configuration.
Write access additionally permits the fixed management actions. Do not grant
this ACL to users who should not see proxy credentials or manage this service.

The backend accepts only the exposed outbound/probe/domain changes and three
routing settings. It rejects changes to DNS and other configuration sections.
Routing values are checked before being written to the shell settings file.
Library saves also validate aliases, node IDs, references, and exact agreement
between assigned nodes and the submitted runtime outbounds.

## Verification

Development checks:

```sh
sh scripts/validate-project.sh
node tests/test-luci.js
# Python dependency for the isolated Lua 5.1 backend tests:
python3 -m pip install lupa
python3 tests/test-luci-backend.py
```

The backend tests use in-memory files and fake service commands. They verify
validation rejection, rollback, partial-write recovery, conflict detection,
input restrictions, streaming migration/toggling, and DNS preservation.
JavaScript tests cover configuration edits, streaming templates/presets,
RPC submission, read-only controls, route mappings, and preservation of edits
across tab switches and failed saves. Inspector tests cover embedded polling,
pending-edit guards, and configuration refresh after logging changes.
Node-library tests cover shared assignments, alias uniqueness, metadata-only
saves, stale revisions, external edits, and recovery of all three saved files.
These do not replace testing on your router's LuCI/rpcd build.

Verified on OpenWrt 22.03.2 x86/64 with Xray 26.9.9: page loading,
authenticated validation, Save & Apply, and traffic capture start/stop.
The three-tab layout was also checked live: one Services entry, route/node
mappings, drafts retained across tabs, and embedded capture start/stop. The UI
update and these tab checks left the Xray PID and the Xray, network, DHCP, and
firewall configuration hashes unchanged.
The node library was verified on the same VM: import `host-socks`, duplicate a
node, assign it through the Routing dropdown, save/reload, and roll back the
library and assignment. Identical outbound assignments caused no Xray restart
or runtime file changes; the temporary test node was removed by rollback.
The nixio adapter uses octal permission strings for compatibility with this
release's Lua bindings.

On-router checks after installation:

```sh
ubus -v list luci.xray-router
ubus call luci.xray-router status
```

Open the page, inspect status/logs, and validate the saved configuration. Test
Save & Apply while stopped first. Confirm that Xray stays stopped, then use
Restore previous configuration. Check Start/Stop and boot settings during a
maintenance window with SSH access available.

The project's `uninstall.sh` removes the LuCI files along with the service
scripts, while retaining configuration and backups unless `--purge` is used.
