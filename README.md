# PILink

Privacy-first local communication hub for emergencies.

PILink turns a Raspberry Pi into a local Wi-Fi "bubble" that hosts a web app. Phones connect to the Wi-Fi and use PILink in the browser. No internet required for messaging.

## What Runs Where

- Raspberry Pi:
  - Wi-Fi access point (NetworkManager hotspot / hostapd)
  - DHCP + DNS (dnsmasq)
  - PILink backend (Rust/Axum) serving the UI and API
  - Optional: Ollama (local AI) at `127.0.0.1:11434`

- Clients (phones/laptops):
  - Open `https://pilink.astatide.com` while connected to the PILink Wi-Fi

## Repo Layout

- `src/main.rs`: Rust backend
- `dist/`: built frontend assets served by the backend
- `frontend/`: React/Tailwind source (build outputs into `../dist/`)
- `forge_network.sh`: AP/DNS/firewall setup script (earlier prototype)

## Local Dev (Laptop)

Backend:

```bash
cargo run
```

Frontend dev server (optional):

```bash
cd frontend
npm install
npm run dev
```

Production build (what the Pi serves):

```bash
cd frontend
npm install
npm run build
```

## Pi Deployment (Clone + Run)

### 1) Clone

```bash
git clone https://github.com/<you>/pilink.git ~/PILink
cd ~/PILink
```

`dist/` is committed so the Pi does not need Node to serve the UI.

### 2) TLS Certificates (for microphone support)

Mobile browsers require HTTPS for microphone access. This project expects:

- `/etc/pilink/certs/fullchain.pem`
- `/etc/pilink/certs/privkey.pem`

There are two supported setup tracks:

**A) Bring Your Own Domain (best UX)**

- Use a domain you control (example: `pilink.example.com`).
- Issue a publicly-trusted certificate via Let's Encrypt (DNS-01 recommended).
- Configure hotspot DNS so that domain resolves to the node IP (offline).

Pros: no certificate warnings on phones; microphone works without manual trust.

**B) Self-Signed Certificate (no domain required)**

- Generate a self-signed cert on the Pi and install it to `/etc/pilink/certs/`.
- Phones may require a one-time manual trust step.

Generate:

```bash
sudo bash ./generate_self_signed_cert.sh --domain pilink.local
```

Pros: fully offline, no domain needed.
Cons: manual trust step on clients.

### 3) Local DNS (offline domain)

When the Pi is the hotspot gateway (`10.42.0.1`), the hotspot DNS must resolve:

- `pilink.astatide.com -> 10.42.0.1`

If NetworkManager shared dnsmasq is used, a common drop-in path is:

- `/etc/NetworkManager/dnsmasq-shared.d/pilink.conf`

with:

```conf
address=/pilink.astatide.com/10.42.0.1
```

If you use a different domain (BYO domain track), update the mapping to your hostname:

```conf
address=/pilink.example.com/10.42.0.1
```

Then restart NetworkManager:

```bash
sudo systemctl restart NetworkManager
```

## One-Command Pi Setup

This repo includes a setup script that configures:

- NetworkManager hotspot profile (`PILink-AP`)
- Local DNS mapping (`pilink.astatide.com -> 10.42.0.1`)
- Firewall allowances on the AP interface (best-effort)
- A `systemd` service (`pilink`) that runs the backend on boot

Run on the Pi from the repo directory:

```bash
bash setup_pi.sh
```

If you're not using `pilink.astatide.com`, pass your domain:

```bash
bash setup_pi.sh --domain pilink.example.com
```

To activate the hotspot immediately (this may drop SSH):

```bash
bash setup_pi.sh --activate-ap
```

After activation:

- SSID: `PILink_Emergency_Node`
- Gateway IP: `10.42.0.1`
- URL: `https://pilink.astatide.com`

### 4) Build and Run

This backend serves:

- HTTPS on `:443`
- HTTP on `:80` (redirects to `https://pilink.astatide.com/...`)

Build:

```bash
cargo build --release
```

Run (quickest):

```bash
sudo ./target/release/pilink-backend
```

To run without sudo, grant low-port bind capability:

```bash
sudo setcap 'cap_net_bind_service=+ep' ./target/release/pilink-backend
./target/release/pilink-backend
```

### 5) Test

On a phone connected to the PILink Wi-Fi:

- `https://pilink.astatide.com`

Fallback (if a device bypasses local DNS):

- `https://10.42.0.1`

Health check:

```bash
curl -k https://pilink.astatide.com/health
```

## Notes

- Do not commit API tokens, private keys, or certificates.
- Some clients with "Private DNS" / DoH may bypass local DNS.
