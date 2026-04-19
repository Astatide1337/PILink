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

### 3) Local DNS (offline domain)

When the Pi is the hotspot gateway (`10.42.0.1`), the hotspot DNS must resolve:

- `pilink.astatide.com -> 10.42.0.1`

If NetworkManager shared dnsmasq is used, a common drop-in path is:

- `/etc/NetworkManager/dnsmasq-shared.d/pilink.conf`

with:

```conf
address=/pilink.astatide.com/10.42.0.1
```

Then restart NetworkManager:

```bash
sudo systemctl restart NetworkManager
```

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
