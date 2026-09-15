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

The installer refreshes rpcd and clears LuCI's generated menu cache. Log out
of LuCI and back in; refresh the browser if upgrading an existing UI. Xray is
not started or restarted by installation. Existing service configuration is
preserved. Older installations need the primary/backup configuration described
in the README merged first.

The supplied Makefile can also be placed under a LuCI feed's `applications/`
directory and built using the OpenWrt SDK. The package contains the UI only;
install the service separately. The SDK package build has not been exercised
in the Windows development environment.

## Controls

- **Start, Stop, Restart:** call the existing stack manager. Stop restores the
  saved dnsmasq baseline as it does in the CLI.
- **Enable/Disable at boot:** control the project's init service.
- **Primary and backup:** edit complete outbound objects independently. The
  SOCKS5 and VLESS REALITY templates contain example values to replace. The
  app preserves advanced protocol fields and fixes each object's tag.
- **Streaming outbound:** configure a separate node with the same outbound
  editor and VLESS REALITY/SOCKS5 templates. Enable streaming routing, add the
  Netflix/Prime Video/HBO/Max/Disney+ presets, or enter custom domains. Preset
  additions retain custom entries and avoid duplicates. Disable streaming
  without losing the node or domain list. An enabled streaming route requires
  a non-blackhole node and at least one domain. See [Streaming setup](STREAMING.md).
- **Health checks:** set an HTTP(S) probe URL and an interval of 1–3600 seconds.
- **Routing:** select LAN interfaces, CN fast path, IPv6 handling, and forced
  domain rules. Bare domains become `domain:` entries. Empty domain lists use
  an inert `.invalid` placeholder so the rule cannot become a catch-all.
- **Diagnostics:** validate the saved configuration, run doctor, reload the
  firewall, inspect status details, or read logs.

The primary is preferred for client traffic. Global DNS keeps using the
primary; this UI does not introduce DNS failover. The status indicator reports
whether the service is running, not which outbound the health checker selected.
Probe details are available in Xray logs when its log level is `info`.

Streaming connects to its dedicated node without fallback. Force-direct
rules take priority, and CN fast path can bypass the streaming rules. Global
DNS keeps using the primary. The page explains these limits beside the
streaming settings. Disabling streaming affects the domain rule only; any
separate custom IP rules configured through SSH retain their own behavior.

Older configurations without streaming objects load normally. Saving adds
only the missing `proxy-stream` outbound and `STREAMING-PROXY` rule after
`FORCE-DIRECT`. Streaming remains disabled until explicitly enabled. Existing
streaming objects and their additional fields are preserved; the UI can edit
only the node, domain list and enabled state, not rule order or destination.

## Save, apply, and recover

1. The backend rejects changes made from a stale configuration revision.
2. Candidate files are written under a private temporary directory. The backend
   runs `xrayctl validate` against that directory, including the fw4 check.
3. Previous `config.json` and `settings.conf` files are kept in
   `/etc/xray-router/backups/luci-last/` with restricted permissions.
4. Validated files replace the current files using individual atomic renames.
5. A running service restarts. A stopped service remains stopped.
6. If installation or restart fails, the backend restores the previous files
   and attempts to restart the previously running stack. Any failed recovery
   is reported in the diagnostics panel.

**Restore previous configuration** validates and restores the last backup.
The backup is one level deep. A failed validation does not replace it. A
successful ordinary restore retains the pre-restore state as the next backup.

An interrupted apply leaves `/etc/xray-router/backups/luci-pending`. The UI
shows a recovery notice and blocks further changes until the backup has been
restored. It still allows stopping the service. If the web interface cannot be
used, recover from SSH:

```sh
xrayctl stop
cp /etc/xray-router/backups/luci-last/config.json /etc/xray-router/config.json
cp /etc/xray-router/backups/luci-last/settings.conf /etc/xray-router/settings.conf
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
RPC submission, read-only controls, and preservation of failed-save edits.
These do not replace testing on your router's LuCI/rpcd build.

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
