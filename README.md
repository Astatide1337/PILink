# PILink

PILink turns a Raspberry Pi into a local communication hub that people join over Wi-Fi.

Once a phone or laptop connects to the Pi's hotspot, it can open a web app with:

- realtime local chat
- a push-to-talk voice channel
- `PI`, an optional on-device assistant powered by Ollama

PILink is designed for local-first use. It works well for small groups, and the voice channel is intended for one active speaker at a time.

## What PILink Is

- Local-only web app hosted by a Raspberry Pi
- Accessed from a browser over the Pi's Wi-Fi hotspot
- HTTPS-enabled so mobile browsers allow microphone access
- Privacy-first inside the local Wi-Fi boundary

## What PILink Is Not

- Not an internet messaging service
- Not end-to-end encrypted
- Not a mesh radio network
- Not built for large-scale voice rooms

The practical security boundary is the WPA2 hotspot network. Anyone who can join that network can reach the app.

## Features

- `Chat` tab for live group messaging
- `PI` tab for local AI responses streamed from Ollama
- Push-to-talk voice with floor control so only one person speaks at a time
- Local display-name identity stored in the browser
- Offline local DNS so users can open a friendly URL instead of an IP
- Raspberry Pi deployment via `systemd`

## How It Works

The Pi does four jobs:

1. Hosts a Wi-Fi hotspot using NetworkManager
2. Resolves your chosen local hostname to the Pi's hotspot IP
3. Serves the PILink web app over HTTPS
4. Optionally runs Ollama locally for the `PI` assistant

Clients then:

1. Join the hotspot
2. Open `https://your-domain`
3. Use chat, voice, and `PI` directly in the browser

## Architecture

On the Raspberry Pi:

- Rust backend (`axum`)
- Static frontend served from `dist/`
- NetworkManager hotspot profile: `PILink-AP`
- HTTPS on `:443`
- HTTP on `:80`
- WebSocket endpoint at `/api/ws`
- Optional Ollama at `127.0.0.1:11434`

On clients:

- Any modern browser with WebSocket and WebRTC support
- Microphone permission for voice
- Connection to the Pi hotspot

## Repo Layout

- `src/main.rs` - backend server, WebSocket handling, voice signaling, AI routes
- `frontend/` - React frontend source
- `dist/` - built frontend assets served by the backend
- `setup_pi.sh` - main Raspberry Pi setup script
- `generate_self_signed_cert.sh` - helper for self-signed TLS certificates
- `forge_network.sh` - older prototype setup script kept for reference

## Hardware And Software Requirements

Recommended:

- Raspberry Pi 4 or newer
- Raspberry Pi OS or another Linux distro using NetworkManager
- Wi-Fi chipset that supports AP mode on the target interface
- Internet access during initial setup if you need to install Rust, Ollama, or pull an AI model

Expected tools/services on the Pi:

- `bash`
- `nmcli` / NetworkManager
- `systemctl`
- `openssl` if using the self-signed certificate flow

Optional but useful:

- `git`
- `curl`
- `iptables`
- `setcap` from `libcap2-bin`

## Quick Start

If you just want the shortest path on a fresh Pi:

1. Clone this repo onto the Pi
2. Put TLS certs in `/etc/pilink/certs/`
3. Run `bash setup_pi.sh`
4. Run `bash setup_pi.sh --activate-ap`
5. Join the `PILink` Wi-Fi network from a phone or laptop
6. Open your configured HTTPS URL in the browser

The rest of this README explains each step in detail.

## Clone The Project

Clone your copy of the repo onto the Raspberry Pi:

```bash
git clone <your-repo-url> ~/PILink
cd ~/PILink
```

`dist/` is committed, so the Pi does not need Node.js just to serve the frontend.

## Choose Your HTTPS Strategy

Microphone access in mobile browsers requires HTTPS. PILink supports two setup paths.

### Option A: Bring Your Own Domain

This is the best user experience.

Example:

- Public hostname: `pilink.example.com`
- Hotspot gateway IP: `10.42.0.1`
- Local DNS override: `pilink.example.com -> 10.42.0.1`

Benefits:

- No certificate warning on client devices
- Best microphone compatibility
- Clean URL for demos and real use

Typical certificate approach:

- Use Let's Encrypt
- Use DNS-01 validation if the Pi is not publicly reachable from the internet
- Install the resulting files here:
  - `/etc/pilink/certs/fullchain.pem`
  - `/etc/pilink/certs/privkey.pem`

### Option B: Self-Signed Certificate

Use this if you do not own a domain or want a fully self-contained setup.

Generate the certificate on the Pi:

```bash
sudo bash ./generate_self_signed_cert.sh --domain pilink.local
```

That writes:

- `/etc/pilink/certs/fullchain.pem`
- `/etc/pilink/certs/privkey.pem`

Tradeoffs:

- No domain purchase required
- Fully offline-friendly
- Clients may need a manual trust step before the browser accepts the certificate

If you regenerate the cert later, restart the service:

```bash
sudo systemctl restart pilink
```

## Raspberry Pi Setup Script

The main setup helper is `setup_pi.sh`.

It is designed to be rerun safely and handles most of the boring system setup for you.

What it configures:

- NetworkManager hotspot profile `PILink-AP`
- SSID `PILink` by default
- WPA2 password `pilinkmesh` by default
- Hotspot gateway `10.42.0.1/24`
- Local DNS override for your configured domain
- Release build of the Rust backend
- `systemd` service named `pilink`
- Best-effort Ollama startup and model pull
- Best-effort firewall rules if `iptables` is installed

### Recommended Setup Flow

Run the first command while the Pi still has internet access through normal Wi-Fi or Ethernet.

```bash
bash setup_pi.sh
```

That allows the script to:

- install Rust if missing
- build the backend
- install or verify the `pilink` service
- try to start Ollama and pull the configured model

Once that finishes, switch the Pi into hotspot mode:

```bash
bash setup_pi.sh --activate-ap
```

Important: activating the hotspot may interrupt your SSH session.

### Common Script Variants

Use a custom domain:

```bash
bash setup_pi.sh --domain pilink.example.com
```

Use a different hotspot password:

```bash
bash setup_pi.sh --psk "your-strong-password"
```

Use a different Ollama model:

```bash
bash setup_pi.sh --ollama-model llama3.2:1b
```

Change the hotspot SSID:

```bash
bash setup_pi.sh --ssid "My PILink"
```

## What The Script Expects

Before running `setup_pi.sh`, make sure:

- The repo is present on the Pi
- `Cargo.toml` exists in the repo root
- TLS files exist in `/etc/pilink/certs/`
- NetworkManager manages the Wi-Fi interface you want to use

The script will stop with actionable errors if a required step is missing.

## Default Runtime Configuration

Current defaults:

- SSID: `PILink`
- Hotspot profile: `PILink-AP`
- Password: `pilinkmesh`
- Interface: `wlan0`
- Gateway IP: `10.42.0.1/24`
- Default AI model: `qwen2:0.5b`

The backend also respects:

- `PILINK_OLLAMA_MODEL`

`setup_pi.sh` writes that environment variable into the installed `systemd` service.

## Starting And Stopping PILink

The setup script installs a service called `pilink`.

Useful commands:

```bash
sudo systemctl status pilink --no-pager
sudo systemctl restart pilink
sudo journalctl -u pilink -n 100 --no-pager
```

To manually bring up the hotspot later:

```bash
nmcli con up PILink-AP
```

To see active connections:

```bash
nmcli con show --active
```

To confirm the hotspot IP on `wlan0`:

```bash
ip -4 addr show wlan0
```

## DNS And Offline Access

PILink is meant to be opened through a hostname, not a raw IP, because the TLS certificate must match the URL.

The setup script writes a local DNS override so your chosen hostname resolves to the Pi hotspot IP.

For the default setup, it writes a line like this:

```conf
address=/pilink.astatide.com/10.42.0.1
```

Possible locations:

- `/etc/NetworkManager/dnsmasq-shared.d/pilink.conf`
- `/etc/NetworkManager/dnsmasq.d/pilink.conf`

If you use a custom domain, the script writes that instead.

### Important Client Note

Some phones and browsers use Private DNS or DNS-over-HTTPS, which can bypass the Pi's local DNS.

If the PILink URL does not load while connected to the hotspot:

- disable Private DNS or DoH on the client
- reload the page
- make sure you are using the same hostname that your certificate covers

Avoid telling users to browse to `https://10.42.0.1` unless the certificate was explicitly created for that IP, which is not the normal setup.

## Ollama And The `PI` Assistant

`PI` is optional. Chat and voice still work without it.

PILink expects Ollama to be reachable at:

- `http://127.0.0.1:11434`

Default model:

- `qwen2:0.5b`

The setup script will try to:

- enable and start the `ollama` service
- check whether the API responds
- pull the configured model if it is missing

If Ollama is installed but the model is missing, the app reports that clearly through the AI health endpoint instead of failing silently.

Useful checks:

```bash
curl http://127.0.0.1:11434/api/tags
ollama list
curl -k https://your-domain/api/ai/health
```

If needed, pull the default model manually:

```bash
ollama pull qwen2:0.5b
```

## Local Development

### Backend

Run the Rust backend locally:

```bash
cargo run
```

In local development without the production TLS setup, the backend runs on:

- `http://127.0.0.1:3000`

### Frontend

Run the Vite dev server:

```bash
cd frontend
npm install
npm run dev
```

Build production assets:

```bash
cd frontend
npm install
npm run build
```

Those build outputs land in `dist/`, which is what the Pi serves in production.

## Verification Checklist

After setup, verify the full stack.

On the Pi:

```bash
sudo systemctl status pilink --no-pager
curl -k https://your-domain/health
curl -k https://your-domain/api/ai/health
nmcli con show --active
```

On a client device connected to the hotspot:

1. Open `https://your-domain`
2. Enter a display name
3. Send a chat message
4. Test push-to-talk voice from two devices
5. Open the `PI` tab and confirm a response streams back

## Troubleshooting

### The Hotspot Is Missing

If you previously switched the Pi back to normal Wi-Fi for updates, the hotspot may simply not be active anymore.

Bring it back up:

```bash
nmcli con up PILink-AP
```

Then re-check:

```bash
nmcli con show --active
ip -4 addr show wlan0
```

### The Page Does Not Load On A Phone

Check these in order:

- You are connected to the correct SSID
- The Pi hotspot is active
- The hostname matches the certificate
- Private DNS / DoH is disabled on the client if needed
- `pilink` service is running

### Microphone Does Not Work

Most often this is a certificate issue.

Check:

- You opened PILink over `https://`
- The certificate is trusted by the device
- The hostname in the browser matches the certificate hostname
- The browser has microphone permission

### `PI` Is Unavailable

Check:

```bash
systemctl status ollama --no-pager
curl http://127.0.0.1:11434/api/tags
ollama list
curl -k https://your-domain/api/ai/health
```

Common causes:

- Ollama is not installed
- Ollama is not running
- The configured model was never pulled
- The Pi had no internet during the model download step

### The Setup Script Warns About `iptables`

Some Pi environments do not have `iptables` installed.

In that case, `setup_pi.sh` warns and continues. PILink can still work, but you should make sure your firewall allows inbound traffic on the hotspot interface for:

- `22/tcp`
- `80/tcp`
- `443/tcp`
- `53/tcp`
- `53/udp`
- `67-68/udp`

### The Service Fails After Adding TLS Files

PILink expects the service user to be able to read the private key. `setup_pi.sh` attempts to fix this automatically by using a `pilink` group and adjusting permissions on `/etc/pilink/certs/privkey.pem`.

If needed, re-run:

```bash
bash setup_pi.sh
```

Then check logs:

```bash
sudo journalctl -u pilink -n 100 --no-pager
```

## Security Notes

- PILink is local-first, not zero-trust
- It does not claim end-to-end encryption
- Anyone with the hotspot password can join the app
- Use a strong WPA2 password if the deployment environment matters
- Protect your private key files and never commit them into git

## Operational Notes

- `dist/` is intentionally committed so the Pi can serve the app without Node.js
- `setup_pi.sh` is the main supported setup path
- `forge_network.sh` exists from an earlier approach and is not the primary path for new installs
- For best experience, perform the initial install while the Pi still has internet access, then switch to hotspot mode after setup completes

## License And Contribution

If you are publishing PILink as open source, this README is intended to make self-hosting on a Raspberry Pi straightforward for other users.

If you extend the project, keep the deployment path simple:

- keep `dist/` up to date
- keep `setup_pi.sh` idempotent
- document any new system dependency clearly
