#!/usr/bin/env bash
set -euo pipefail

# PILink Router-in-a-Box forge script (Raspberry Pi OS Lite)
# - Creates a local Wi-Fi AP (no internet required)
# - DHCP + DNS captive-portal style resolution to 192.168.4.1
# - Redirects HTTP (port 80) to the PILink app (port 3000)
# - Installs and starts Ollama + pulls qwen2:0.5b

WLAN_IF="wlan0"
AP_IP="192.168.4.1"
AP_CIDR="192.168.4.1/24"
DHCP_START="192.168.4.50"
DHCP_END="192.168.4.150"
SSID="PILink"

if [[ ${EUID:-0} -ne 0 ]]; then
  echo "Run as root: sudo bash forge_network.sh" >&2
  exit 1
fi

echo "[1/7] Installing dependencies"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  hostapd dnsmasq iptables iptables-persistent curl ca-certificates rfkill

systemctl unmask hostapd || true
systemctl stop hostapd || true
systemctl stop dnsmasq || true

echo "[2/7] Configuring static IP for ${WLAN_IF}"
# Raspberry Pi OS Lite uses dhcpcd by default.
if ! grep -q "^# PILINK-BEGIN" /etc/dhcpcd.conf 2>/dev/null; then
  cat >>/etc/dhcpcd.conf <<EOF

# PILINK-BEGIN
interface ${WLAN_IF}
  static ip_address=${AP_CIDR}
  nohook wpa_supplicant
# PILINK-END
EOF
fi

echo "[3/7] Configuring hostapd"
install -d -m 0755 /etc/hostapd
cat >/etc/hostapd/hostapd.conf <<EOF
interface=${WLAN_IF}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=6
ieee80211n=1
wmm_enabled=1
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=pilinkmesh
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

# Tell hostapd where its config lives
if [[ -f /etc/default/hostapd ]]; then
  if grep -q "^#\?DAEMON_CONF=" /etc/default/hostapd; then
    sed -i "s|^#\?DAEMON_CONF=.*|DAEMON_CONF=\"/etc/hostapd/hostapd.conf\"|" /etc/default/hostapd
  else
    echo "DAEMON_CONF=\"/etc/hostapd/hostapd.conf\"" >>/etc/default/hostapd
  fi
fi

echo "[4/7] Configuring dnsmasq (DHCP + captive DNS)"
install -d -m 0755 /etc/dnsmasq.d
cat >/etc/dnsmasq.d/pilink.conf <<EOF
interface=${WLAN_IF}
bind-interfaces
domain-needed
bogus-priv

dhcp-range=${DHCP_START},${DHCP_END},255.255.255.0,12h
dhcp-option=option:router,${AP_IP}
dhcp-option=option:dns-server,${AP_IP}

# Captive-portal style DNS: resolve every name to the node
address=/#/${AP_IP}
EOF

echo "[5/7] Locking traffic to local ecosystem"
# Do not forward client traffic to other interfaces.
sysctl -w net.ipv4.ip_forward=0 >/dev/null
if ! grep -q "^net.ipv4.ip_forward=0" /etc/sysctl.conf 2>/dev/null; then
  echo "net.ipv4.ip_forward=0" >>/etc/sysctl.conf
fi

# Redirect all HTTP to the app (captive portal entry point).
iptables -t nat -C PREROUTING -i "${WLAN_IF}" -p tcp --dport 80 -j REDIRECT --to-ports 3000 2>/dev/null \
  || iptables -t nat -A PREROUTING -i "${WLAN_IF}" -p tcp --dport 80 -j REDIRECT --to-ports 3000

# Drop any forwarding attempts from WLAN.
iptables -C FORWARD -i "${WLAN_IF}" -j DROP 2>/dev/null || iptables -A FORWARD -i "${WLAN_IF}" -j DROP

# Allow required inbound services on WLAN (DHCP, DNS, HTTP redirect, PILink app).
iptables -C INPUT -i "${WLAN_IF}" -p udp --dport 67:68 -j ACCEPT 2>/dev/null || iptables -A INPUT -i "${WLAN_IF}" -p udp --dport 67:68 -j ACCEPT
iptables -C INPUT -i "${WLAN_IF}" -p udp --dport 53 -j ACCEPT 2>/dev/null || iptables -A INPUT -i "${WLAN_IF}" -p udp --dport 53 -j ACCEPT
iptables -C INPUT -i "${WLAN_IF}" -p tcp --dport 53 -j ACCEPT 2>/dev/null || iptables -A INPUT -i "${WLAN_IF}" -p tcp --dport 53 -j ACCEPT
iptables -C INPUT -i "${WLAN_IF}" -p tcp --dport 3000 -j ACCEPT 2>/dev/null || iptables -A INPUT -i "${WLAN_IF}" -p tcp --dport 3000 -j ACCEPT
iptables -C INPUT -i "${WLAN_IF}" -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -A INPUT -i "${WLAN_IF}" -p tcp --dport 80 -j ACCEPT

netfilter-persistent save || true

echo "[6/7] Installing and starting Ollama"
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
systemctl enable ollama || true
systemctl start ollama || true

# Pull the requested model (may take time / storage).
ollama pull qwen2:0.5b || true

echo "[7/7] Enabling services"
rfkill unblock wifi || true
systemctl enable dnsmasq
systemctl enable hostapd
systemctl restart dhcpcd
systemctl restart dnsmasq
systemctl restart hostapd

echo "Done. AP SSID: ${SSID} (passphrase: pilinkmesh)"
echo "Node IP: ${AP_IP}  App: http://${AP_IP}:3000/"
