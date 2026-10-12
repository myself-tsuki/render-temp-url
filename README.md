# CFTun — Ephemeral Cloudflare Quick Tunnel Gateway

A containerized proxy server and web dashboard that generates temporary, expiring Cloudflare Quick Tunnels (`trycloudflare.com`) on demand.

Designed specifically to operate seamlessly on **Render.com** (and other container cloud platforms) without conflicting port detection.

---

## 🚀 Features

- **Dual-Port Stealth Architecture**:
  - **Port 10000 (`0.0.0.0`)**: Public web UI & REST API — cleanly detected and bound by Render as the primary Web Service.
  - **Port 8000 (`127.0.0.1` / loopback)**: Internal reverse proxy target — invisible to Render's external port scanners, keeping Render from failing or routing to the wrong port.
- **Dynamic Quick Tunnels**: Spawns `cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate` on demand without requiring Cloudflare login or credentials.
- **Custom TTL Expiration**:
  - Configurable expiration range from **10 seconds** up to **12 hours** (43,200s).
  - Built-in preset pills (`10s`, `1m`, `5m`, `15m`, `1h`, `6h`, `12h`) + fine-grained Hours/Minutes/Seconds inputs.
  - Automatic teardown and cleanup upon TTL expiration.
- **Real-Time Live Dashboard**:
  - Active tunnel URL display with 1-click clipboard copy and direct launch.
  - Live countdown ticker and progress bar.
  - Server-Sent Events (SSE) streaming live `cloudflared` stdout/stderr output and proxy logs.
  - Live forwarded request counter.
  - Manual kill switch to terminate tunnels on demand.

---

## 🛠️ How Render Port Stealth Works

Render.com automatically scans Docker containers for exposed network ports. If multiple services bind to `0.0.0.0`, Render may pick the wrong port or throw port conflict warnings:

```
[Incoming Internet Traffic]
            │
            ▼
┌──────────────────────────────────────────────┐
│ Render.com Web Service                       │
│                                              │
│  [Port 10000 on 0.0.0.0]                     │
│  • Public Web Dashboard & Control API        │
│                                              │
│  [Port 8000 on 127.0.0.1 (Loopback Only)]     │
│  • Hidden from Render port scanner           │
│  • Reverse proxies to Target URL             │
│                                              │
│  [cloudflared daemon]                        │
│  • Outbound connection to Cloudflare Edge    │
│  • Routes trycloudflare.com -> 127.0.0.1:8000│
└──────────────────────────────────────────────┘
            │
            ▼
[External trycloudflare.com URL]
```

By strictly binding Port 8000 to `127.0.0.1` (or custom internal loopback) and only exposing `10000` in the `Dockerfile`, Render sees exactly **one** public port (`10000`).

---

## 🐳 Running with Docker

### Build the Docker Image
```bash
docker build -t cftun .
```

### Run the Container
```bash
docker run -d -p 10000:10000 --name cftun-gateway cftun
```

Open your browser at `http://localhost:10000`.

---

## 🌐 Deploying to Render.com

1. Push this repository to GitHub or GitLab.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** -> **Web Service**.
3. Connect your repository.
4. Set the runtime to **Docker**.
5. Set the Environment Variables (optional, defaults already configured):
   - `PORT`: `10000`
   - `INTERNAL_HOST`: `127.0.0.1`
   - `INTERNAL_PORT`: `8000`
6. Deploy! Render will build the Docker container and expose your dashboard on your Render URL.

---

## 💻 Running Locally (Node.js)

```bash
# Install dependencies
npm install

# Start the server (requires cloudflared installed on host system)
npm start
```
