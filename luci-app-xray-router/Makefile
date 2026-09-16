include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI management for Xray Router
LUCI_DEPENDS:=+luci-base +rpcd +lua +luci-lib-jsonc +luci-lib-nixio +jsonfilter
LUCI_PKGARCH:=all

# rpcd discovers executable plugins. Set modes in the build directory so
# packages also work when the source was copied from a Windows checkout.
define XrayRouterRpcPermissions
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.xray-router \
		$(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.xray-inspector
endef
Hooks/Prepare/Post += XrayRouterRpcPermissions

include ../../luci.mk

# Install the xray-router service separately with the repository's install.sh.
