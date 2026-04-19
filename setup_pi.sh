#!/usr/bin/env bash
set -euo pipefail

# PILink Pi Setup
# - Configures a NetworkManager hotspot (SSID + static gateway IP)
# - Adds local DNS override so pilink.astatide.com resolves to the node
# - Builds and installs the backend as a systemd service
# - Opens required ports on the AP interface (SSH/HTTP/HTTPS/DNS/DHCP)
#
# Designed to be re-runnable (idempotent) and to fail with actionable guidance.

SSID="PILink"
PSK="pilinkmesh"
AP_CON="PILink-AP"
AP_IF="wlan0"
AP_IP="10.42.0.1/24"
DOMAIN="pilink.astatide.com"
REPO_DIR="$(pwd)"
ACTIVATE_AP=0

usage() {
  cat <<EOF
Usage: bash setup_pi.sh [options]

Options:
  --repo <path>        Repo directory (default: current directory)
  --iface <ifname>     Wi-Fi interface for AP (default: wlan0)
  --ssid <name>        Hotspot SSID (default: PILink_Emergency_Node)
  --psk <pass>         Hotspot WPA2 password (default: pilinkmesh)
  --ip <cidr>          AP gateway address (default: 10.42.0.1/24)
  --domain <name>      Local domain to map to AP IP (default: pilink.astatide.com)
  --activate-ap        Bring up the AP at the end (may drop SSH)
  -h, --help           Show help

Examples:
  bash setup_pi.sh --repo ~/PILink
  bash setup_pi.sh --activate-ap
  bash setup_pi.sh --ssid PILink
EOF
}

log() { printf '[pilink] %s\n' "$*"; }
warn() { printf '[pilink][WARN] %s\n' "$*" >&2; }
die() { printf '[pilink][ERROR] %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing '$1'. Install it and re-run.";
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_DIR="$2"; shift 2;;
    --iface) AP_IF="$2"; shift 2;;
    --ssid) SSID="$2"; shift 2;;
    --psk) PSK="$2"; shift 2;;
    --ip) AP_IP="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --activate-ap) ACTIVATE_AP=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "Unknown arg: $1 (use --help)";;
  esac
done

[[ -d "$REPO_DIR" ]] || die "Repo dir not found: $REPO_DIR"
[[ -f "$REPO_DIR/Cargo.toml" ]] || die "Not a PILink repo (Cargo.toml missing): $REPO_DIR"

need_cmd nmcli
need_cmd systemctl

USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6 || true)"
[[ -n "$USER_HOME" ]] || USER_HOME="/home/$USER_NAME"

# nmcli connection edits generally require root. If not root, re-exec with sudo.
if [[ ${EUID:-0} -ne 0 ]]; then
  exec sudo -E bash "$0" --repo "$REPO_DIR" --iface "$AP_IF" --ssid "$SSID" --psk "$PSK" --ip "$AP_IP" --domain "$DOMAIN" $([[ "$ACTIVATE_AP" -eq 1 ]] && printf '%s' '--activate-ap')
fi

ensure_rust() {
  local CARGO_BIN="$USER_HOME/.cargo/bin/cargo"
  local RUSTUP_BIN="$USER_HOME/.cargo/bin/rustup"
  if [[ -x "$CARGO_BIN" ]] && sudo -u "$USER_NAME" -H "$CARGO_BIN" -V >/dev/null 2>&1; then
    return 0
  fi

  warn "cargo not found. Attempting to install Rust via rustup (internet required)."
  if ! have_cmd curl; then
    die "Missing 'curl'. Install curl (or copy rustup-init offline), then re-run."
  fi

  # Install rustup for the non-root user even if script is run with sudo.
  sudo -u "$USER_NAME" -H sh -c 'set -e; curl -fsSL https://sh.rustup.rs | sh -s -- -y' || {
    die "rustup install failed. Ensure the Pi has internet access, then re-run setup_pi.sh."
  }

  [[ -x "$RUSTUP_BIN" ]] || die "rustup not found at $RUSTUP_BIN after install. Check rustup output and re-run."

  # Ensure a default toolchain exists (some existing rustup installs can have none configured).
  sudo -u "$USER_NAME" -H "$RUSTUP_BIN" toolchain install stable >/dev/null 2>&1 || true
  sudo -u "$USER_NAME" -H "$RUSTUP_BIN" default stable >/dev/null 2>&1 || true

  [[ -x "$CARGO_BIN" ]] || die "cargo missing at $CARGO_BIN after rustup install."
  sudo -u "$USER_NAME" -H "$CARGO_BIN" -V >/dev/null 2>&1 || die "cargo is present but rustup has no default toolchain. Run: $RUSTUP_BIN default stable"
}

log "Using repo: $REPO_DIR"
log "AP connection: $AP_CON on $AP_IF ($AP_IP)"
log "SSID: $SSID"
log "Domain map: $DOMAIN -> ${AP_IP%/*}"

log "Step 1/6: Validate TLS certs (for HTTPS + microphone)"
if [[ ! -f /etc/pilink/certs/fullchain.pem || ! -f /etc/pilink/certs/privkey.pem ]]; then
  warn "TLS certs not found in /etc/pilink/certs."
  warn "Expected: /etc/pilink/certs/fullchain.pem and /etc/pilink/certs/privkey.pem"
  warn "Without TLS, iPhone Safari will block microphone access."
  warn "Fix: issue a cert for $DOMAIN (Let's Encrypt DNS-01) and install into /etc/pilink/certs/."
else
  log "TLS certs present."
fi

log "Step 2/6: Ensure NetworkManager hotspot profile exists"
if nmcli -g NAME con show | grep -qx "$AP_CON"; then
  log "Hotspot profile '$AP_CON' exists; updating settings."
else
  log "Creating hotspot profile '$AP_CON'."
  nmcli con add type wifi ifname "$AP_IF" con-name "$AP_CON" ssid "$SSID" >/dev/null
fi

nmcli con mod "$AP_CON" 802-11-wireless.mode ap
nmcli con mod "$AP_CON" 802-11-wireless.band bg
nmcli con mod "$AP_CON" 802-11-wireless.channel 6
nmcli con mod "$AP_CON" wifi-sec.key-mgmt wpa-psk
nmcli con mod "$AP_CON" wifi-sec.psk "$PSK"

# Force gateway IP and DHCP/DNS sharing.
nmcli con mod "$AP_CON" ipv4.method shared
nmcli con mod "$AP_CON" ipv4.addresses "$AP_IP"
nmcli con mod "$AP_CON" ipv6.method ignore

# Ensure AP comes back on boot.
nmcli con mod "$AP_CON" connection.autoconnect yes
nmcli con mod "$AP_CON" connection.autoconnect-priority 100

log "Step 3/6: Configure local DNS override for $DOMAIN"
# NetworkManager shared-mode dnsmasq commonly supports drop-ins at:
# - /etc/NetworkManager/dnsmasq-shared.d/*.conf
# Some distros use /etc/NetworkManager/dnsmasq.d/*.conf.
DNS_LINE="address=/$DOMAIN/${AP_IP%/*}"

DNS_DIR1="/etc/NetworkManager/dnsmasq-shared.d"
DNS_DIR2="/etc/NetworkManager/dnsmasq.d"

sudo mkdir -p "$DNS_DIR1" || true
TARGET1="$DNS_DIR1/pilink.conf"

if sudo test -d "$DNS_DIR1"; then
  printf '%s\n' "$DNS_LINE" | sudo tee "$TARGET1" >/dev/null
  log "Wrote $TARGET1"
fi

if sudo test -d "$DNS_DIR2"; then
  TARGET2="$DNS_DIR2/pilink.conf"
  printf '%s\n' "$DNS_LINE" | sudo tee "$TARGET2" >/dev/null
  log "Wrote $TARGET2"
fi

log "Note: NetworkManager restart will happen at the end"

log "Step 4/6: Open required ports on AP interface (best-effort)"
if command -v iptables >/dev/null 2>&1; then
  # Allow SSH and web ports for clients on the hotspot.
  for rule in \
    "INPUT -i $AP_IF -p tcp --dport 22 -j ACCEPT" \
    "INPUT -i $AP_IF -p tcp --dport 80 -j ACCEPT" \
    "INPUT -i $AP_IF -p tcp --dport 443 -j ACCEPT" \
    "INPUT -i $AP_IF -p udp --dport 53 -j ACCEPT" \
    "INPUT -i $AP_IF -p tcp --dport 53 -j ACCEPT" \
    "INPUT -i $AP_IF -p udp --dport 67:68 -j ACCEPT";
  do
    if sudo iptables -C $rule 2>/dev/null; then
      :
    else
      sudo iptables -I $rule
    fi
  done

  if command -v netfilter-persistent >/dev/null 2>&1; then
    sudo netfilter-persistent save || true
  fi
else
  warn "iptables not found. Ensure firewall allows inbound on $AP_IF: 22,80,443,53,67-68"
fi

log "Step 5/6: Build backend and install systemd service"
ensure_rust

log "Building release binary (this may take a while on Pi)"
(
  cd "$REPO_DIR"
  sudo -u "$USER_NAME" -H "$USER_HOME/.cargo/bin/cargo" build --release
)

BIN="$REPO_DIR/target/release/pilink-backend"
[[ -x "$BIN" ]] || die "Build succeeded but binary missing: $BIN"

if command -v setcap >/dev/null 2>&1; then
  sudo setcap 'cap_net_bind_service=+ep' "$BIN" || warn "setcap failed; service may need sudo/root to bind 80/443"
else
  warn "setcap not found. Install 'libcap2-bin' to run on ports 80/443 without sudo."
fi

SERVICE_PATH="/etc/systemd/system/pilink.service"

sudo tee "$SERVICE_PATH" >/dev/null <<EOF
[Unit]
Description=PILink (local chat + AI)
After=network-online.target NetworkManager.service
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REPO_DIR
Environment=RUST_LOG=info
ExecStart=$BIN
Restart=always
RestartSec=2

# Allow binding :80/:443 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable pilink
sudo systemctl restart pilink

log "Service status (last lines):"
sudo systemctl --no-pager --full status pilink | sed -n '1,16p' || true

log "Step 6/6: Optionally activate hotspot"

log "Restarting NetworkManager to apply DNS overrides"
sudo systemctl restart NetworkManager

if [[ "$ACTIVATE_AP" -eq 1 ]]; then
  warn "Bringing up '$AP_CON' may drop your SSH session."
  warn "Reconnect SSID: $SSID  IP: ${AP_IP%/*}  URL: https://$DOMAIN"

  # Schedule activation so it still happens if SSH drops immediately.
  nohup sh -c "sleep 2; nmcli con up '$AP_CON'" >/tmp/pilink-ap.log 2>&1 &
  log "Scheduled: nmcli con up '$AP_CON' (see /tmp/pilink-ap.log)"
else
  log "Setup complete. To activate the hotspot later: nmcli con up '$AP_CON'"
  log "Then connect clients to SSID '$SSID' and open: https://$DOMAIN"
fi

log "Done."
