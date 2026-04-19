#!/usr/bin/env bash
set -euo pipefail

# Best-effort rollback for forge_network.sh changes.
# Does NOT uninstall packages; it only removes configs and rules this project added.

WLAN_IF="${WLAN_IF:-wlan0}"

if [[ ${EUID:-0} -ne 0 ]]; then
  echo "Run as root: sudo bash unforge_network.sh" >&2
  exit 1
fi

echo "[1/6] Stopping services"
systemctl stop hostapd 2>/dev/null || true
systemctl stop dnsmasq 2>/dev/null || true

echo "[2/6] Removing dnsmasq override"
rm -f /etc/dnsmasq.d/pilink.conf

echo "[3/6] Removing hostapd config"
rm -f /etc/hostapd/hostapd.conf

echo "[4/6] Removing dhcpcd PILink block"
if [[ -f /etc/dhcpcd.conf ]]; then
  tmp="$(mktemp)"
  awk 'BEGIN{skip=0} /^# PILINK-BEGIN/{skip=1} /^# PILINK-END/{skip=0; next} skip==0{print}' /etc/dhcpcd.conf >"${tmp}"
  cat "${tmp}" > /etc/dhcpcd.conf
  rm -f "${tmp}"
fi

echo "[5/6] Removing iptables rules (best-effort)"
while iptables -t nat -D PREROUTING -i "${WLAN_IF}" -p tcp --dport 80 -j REDIRECT --to-ports 3000 2>/dev/null; do :; done
while iptables -D FORWARD -i "${WLAN_IF}" -j DROP 2>/dev/null; do :; done
while iptables -D INPUT -i "${WLAN_IF}" -p udp --dport 67:68 -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -i "${WLAN_IF}" -p udp --dport 53 -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -i "${WLAN_IF}" -p tcp --dport 53 -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -i "${WLAN_IF}" -p tcp --dport 3000 -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -i "${WLAN_IF}" -p tcp --dport 80 -j ACCEPT 2>/dev/null; do :; done

netfilter-persistent save 2>/dev/null || true

echo "[6/6] Disabling services + restarting dhcpcd"
systemctl disable hostapd 2>/dev/null || true
systemctl disable dnsmasq 2>/dev/null || true
systemctl restart dhcpcd 2>/dev/null || true

# If NetworkManager is in use and a prior connection name exists, remove it.
if command -v nmcli >/dev/null 2>&1; then
  nmcli con delete PILink-AP 2>/dev/null || true
fi

echo "Rollback complete. Reboot recommended." 
