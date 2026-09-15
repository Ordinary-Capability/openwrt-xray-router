include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI management for Xray Router
LUCI_DEPENDS:=+luci-base +rpcd +lua +luci-lib-jsonc +luci-lib-nixio +jsonfilter
LUCI_PKGARCH:=all

include ../../luci.mk

# Install the xray-router service separately with the repository's install.sh.
