# Multi-arch Dockerfile for CFTun with Cloudflared Quick Tunnels
FROM node:20-bookworm-slim

# Install system dependencies & CA certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install official cloudflared binary dynamically for container architecture (amd64 / arm64)
RUN ARCH=$(dpkg --print-architecture) && \
    echo "Installing cloudflared for architecture: ${ARCH}" && \
    curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" && \
    chmod +x /usr/local/bin/cloudflared && \
    cloudflared --version

WORKDIR /app

# Install npm dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY server.js ./
COPY public/ ./public/

# Render.com default environment configuration
ENV PORT=10000
ENV INTERNAL_HOST=127.0.0.1
ENV INTERNAL_PORT=8000
ENV PING_URL=https://render-temp-url.onrender.com/

# Render detects and binds to 10000 only.
# Port 8000 is intentionally NOT exposed and bound to 127.0.0.1 loopback only.
EXPOSE 10000

CMD ["node", "server.js"]
