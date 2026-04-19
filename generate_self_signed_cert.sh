#!/usr/bin/env bash
set -euo pipefail

# Generates a self-signed TLS certificate for offline LAN use.
# Writes to:
#   /etc/pilink/certs/fullchain.pem
#   /etc/pilink/certs/privkey.pem
#
# Note: iOS/Android may require a one-time manual trust step for self-signed certs.

DOMAIN="pilink.local"
OUT_DIR="/etc/pilink/certs"
DAYS="825"  # ~2.2 years; arbitrary, shorter is fine too.
FORCE=0

usage() {
  cat <<EOF
Usage: sudo bash generate_self_signed_cert.sh [options]

Options:
  --domain <name>   Certificate CN/SAN (default: pilink.local)
  --days <n>        Validity in days (default: 825)
  --force           Overwrite existing cert/key
  -h, --help        Show help

Examples:
  sudo bash generate_self_signed_cert.sh
  sudo bash generate_self_signed_cert.sh --domain pilink.local
  sudo bash generate_self_signed_cert.sh --domain pilink.example.com --force
EOF
}

log() { printf '[pilink] %s\n' "$*"; }
die() { printf '[pilink][ERROR] %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --days) DAYS="$2"; shift 2;;
    --force) FORCE=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "Unknown arg: $1 (use --help)";;
  esac
done

[[ ${EUID:-0} -eq 0 ]] || die "Run as root: sudo bash generate_self_signed_cert.sh"
command -v openssl >/dev/null 2>&1 || die "Missing openssl. Install it and re-run."

FULLCHAIN="$OUT_DIR/fullchain.pem"
PRIVKEY="$OUT_DIR/privkey.pem"

mkdir -p "$OUT_DIR"

if [[ -f "$FULLCHAIN" || -f "$PRIVKEY" ]] && [[ "$FORCE" -ne 1 ]]; then
  die "Cert/key already exist at $OUT_DIR. Re-run with --force to overwrite."
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

log "Generating self-signed cert for: $DOMAIN"

# EC key (small + fast on Pi).
openssl ecparam -name prime256v1 -genkey -noout -out "$tmpdir/key.pem"

# Self-signed cert with SAN.
cat >"$tmpdir/req.cnf" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = $DOMAIN

[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = $DOMAIN
EOF

openssl req -x509 -new -nodes \
  -key "$tmpdir/key.pem" \
  -days "$DAYS" \
  -out "$tmpdir/cert.pem" \
  -config "$tmpdir/req.cnf"

install -o root -g root -m 600 "$tmpdir/key.pem" "$PRIVKEY"
install -o root -g root -m 644 "$tmpdir/cert.pem" "$FULLCHAIN"

log "Wrote: $FULLCHAIN"
log "Wrote: $PRIVKEY"
log "Next: restart PILink service so it picks up the new cert."
