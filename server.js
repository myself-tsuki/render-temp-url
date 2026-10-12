import express from 'express';
import http from 'http';
import httpProxy from 'http-proxy';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_PORT = parseInt(process.env.PORT || '10000', 10);
const INTERNAL_HOST = process.env.INTERNAL_HOST || '127.0.0.1';
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT || '8000', 10);

// App state
let activeSession = null;
let tunnelProcess = null;
let expirationTimer = null;
const eventClients = new Set();
const recentLogs = [];
let requestStats = {
  totalRequests: 0,
  lastRequestAt: null,
  activeTarget: null
};

function addLog(message, type = 'info') {
  const entry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    time: new Date().toISOString(),
    message: String(message).trim(),
    type
  };
  recentLogs.push(entry);
  if (recentLogs.length > 100) recentLogs.shift();
  broadcast({ type: 'log', data: entry });
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventClients) {
    client.write(data);
  }
}

// -------------------------------------------------------------
// PORT 2: Internal Reverse Proxy (Hidden on localhost / loopback)
// -------------------------------------------------------------
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  secure: false
});

proxy.on('error', (err, req, res) => {
  addLog(`Proxy error [${req?.method || 'REQ'} ${req?.url || ''}]: ${err.message}`, 'error');
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy Gateway Error', details: err.message }));
  }
});

const internalProxyServer = http.createServer((req, res) => {
  if (!activeSession || !activeSession.targetUrl) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('No active tunnel target configured.');
    return;
  }

  requestStats.totalRequests += 1;
  requestStats.lastRequestAt = new Date().toISOString();
  broadcast({ type: 'stats', data: requestStats });

  proxy.web(req, res, { target: activeSession.targetUrl });
});

internalProxyServer.on('upgrade', (req, socket, head) => {
  if (activeSession && activeSession.targetUrl) {
    proxy.ws(req, socket, head, { target: activeSession.targetUrl });
  } else {
    socket.destroy();
  }
});

internalProxyServer.listen(INTERNAL_PORT, INTERNAL_HOST, () => {
  console.log(`[Internal Proxy] Bound to http://${INTERNAL_HOST}:${INTERNAL_PORT} (Hidden from external discovery)`);
});

// -------------------------------------------------------------
// Cloudflared Tunnel Handler
// -------------------------------------------------------------
function stopActiveTunnel(reason = 'stopped_by_user') {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }

  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGTERM');
      setTimeout(() => {
        if (tunnelProcess) {
          try { tunnelProcess.kill('SIGKILL'); } catch (_) {}
        }
      }, 2000);
    } catch (e) {
      addLog(`Failed to terminate cloudflared: ${e.message}`, 'error');
    }
    tunnelProcess = null;
  }

  const prevSession = activeSession;
  activeSession = null;
  requestStats.activeTarget = null;

  addLog(`Tunnel session terminated (${reason})`, 'warn');
  broadcast({
    type: 'status',
    data: getStatusPayload()
  });

  return prevSession;
}

function startCloudflared(targetUrl, durationSeconds) {
  stopActiveTunnel('new_tunnel_requested');

  const cleanTargetUrl = targetUrl.trim().replace(/\/+$/, '');
  const now = Date.now();

  activeSession = {
    id: 'tun_' + Math.random().toString(36).substring(2, 9),
    targetUrl: cleanTargetUrl,
    status: 'starting',
    tunnelUrl: null,
    createdAt: new Date(now).toISOString(),
    establishedAt: null,
    expiresAt: null,
    durationSeconds
  };

  requestStats.activeTarget = cleanTargetUrl;
  broadcast({ type: 'status', data: getStatusPayload() });
  addLog(`Starting tunnel proxy for: ${cleanTargetUrl} (Allocated TTL: ${durationSeconds}s)`);

  const internalProxyUrl = `http://localhost:${INTERNAL_PORT}`;

  try {
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', internalProxyUrl, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    activeSession.status = 'failed';
    activeSession.error = `Failed to spawn cloudflared: ${err.message}`;
    addLog(activeSession.error, 'error');
    broadcast({ type: 'status', data: getStatusPayload() });
    return;
  }

  // Timeout if cloudflared fails to register within 60s
  const startupTimeout = setTimeout(() => {
    if (activeSession && activeSession.status === 'starting') {
      addLog('Cloudflared timed out while trying to establish quick tunnel.', 'error');
      stopActiveTunnel('startup_timeout');
    }
  }, 60000);

  const handleTunnelOutput = (chunk) => {
    const text = chunk.toString();
    const lines = text.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Extract trycloudflare URL
      const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && activeSession && activeSession.status === 'starting') {
        clearTimeout(startupTimeout);
        activeSession.tunnelUrl = match[0];
        activeSession.status = 'active';

        const establishedTime = Date.now();
        activeSession.establishedAt = new Date(establishedTime).toISOString();
        activeSession.expiresAt = new Date(establishedTime + activeSession.durationSeconds * 1000).toISOString();

        addLog(`Quick Tunnel established: ${activeSession.tunnelUrl}`, 'success');
        addLog(`TTL countdown activated: will expire in ${activeSession.durationSeconds}s`, 'info');

        // Start countdown ONLY now that tunnel is verified active
        if (expirationTimer) clearTimeout(expirationTimer);
        expirationTimer = setTimeout(() => {
          addLog(`Tunnel reached expiration time limit (${activeSession.durationSeconds}s)`, 'warn');
          stopActiveTunnel('expired');
        }, activeSession.durationSeconds * 1000);

        broadcast({ type: 'status', data: getStatusPayload() });
      }

      if (line.includes('ERR') || line.includes('error')) {
        addLog(`[cloudflared] ${line}`, 'warn');
      } else if (line.includes('trycloudflare.com') || line.includes('Registered tunnel')) {
        addLog(`[cloudflared] ${line}`, 'info');
      }
    }
  };

  tunnelProcess.stdout.on('data', handleTunnelOutput);
  tunnelProcess.stderr.on('data', handleTunnelOutput);

  tunnelProcess.on('error', (err) => {
    clearTimeout(startupTimeout);
    addLog(`cloudflared process error: ${err.message}`, 'error');
    if (activeSession) {
      activeSession.status = 'failed';
      activeSession.error = err.message;
      broadcast({ type: 'status', data: getStatusPayload() });
    }
  });

  tunnelProcess.on('exit', (code, signal) => {
    clearTimeout(startupTimeout);
    addLog(`cloudflared exited with code ${code} (${signal || 'clean'})`, 'warn');
    if (activeSession && activeSession.status === 'active') {
      activeSession.status = 'stopped';
      broadcast({ type: 'status', data: getStatusPayload() });
    }
    tunnelProcess = null;
  });
}

function getStatusPayload() {
  const now = Date.now();
  let remainingSeconds = 0;

  if (activeSession && activeSession.expiresAt) {
    const remainingMs = new Date(activeSession.expiresAt).getTime() - now;
    remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  }

  return {
    session: activeSession ? {
      ...activeSession,
      remainingSeconds
    } : null,
    stats: requestStats,
    server: {
      publicPort: PUBLIC_PORT,
      internalHost: INTERNAL_HOST,
      internalPort: INTERNAL_PORT
    }
  };
}

// -------------------------------------------------------------
// PORT 1: Public Dashboard & REST API
// -------------------------------------------------------------
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json(getStatusPayload());
});

app.get('/api/logs', (req, res) => {
  res.json(recentLogs);
});

app.post('/api/tunnel/start', (req, res) => {
  const { targetUrl, durationSeconds } = req.body;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'A valid targetUrl string is required.' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'URL must use http:// or https:// protocol.' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL format provided.' });
  }

  const duration = parseInt(durationSeconds, 10);
  if (isNaN(duration) || duration < 10 || duration > 43200) {
    return res.status(400).json({ error: 'Duration must be between 10 seconds and 43200 seconds (12 hours).' });
  }

  startCloudflared(parsed.toString(), duration);

  res.json({
    message: 'Tunnel initialization triggered',
    status: getStatusPayload()
  });
});

app.post('/api/tunnel/stop', (req, res) => {
  const stopped = stopActiveTunnel('manual_stop');
  res.json({
    message: 'Tunnel stopped successfully',
    previousSession: stopped,
    status: getStatusPayload()
  });
});

app.post('/api/tunnel/extend', (req, res) => {
  const { additionalSeconds } = req.body;
  const extra = parseInt(additionalSeconds, 10);

  if (!activeSession || activeSession.status !== 'active') {
    return res.status(400).json({ error: 'No active tunnel session to extend.' });
  }

  if (isNaN(extra) || extra <= 0 || extra > 43200) {
    return res.status(400).json({ error: 'Invalid additional seconds.' });
  }

  const currentExpiry = activeSession.expiresAt ? new Date(activeSession.expiresAt).getTime() : Date.now();
  const newExpiry = currentExpiry + extra * 1000;
  activeSession.expiresAt = new Date(newExpiry).toISOString();
  activeSession.durationSeconds = (activeSession.durationSeconds || 0) + extra;

  if (expirationTimer) clearTimeout(expirationTimer);
  const remainingMs = Math.max(1000, newExpiry - Date.now());
  expirationTimer = setTimeout(() => {
    addLog(`Tunnel reached extended expiration time limit`, 'warn');
    stopActiveTunnel('expired');
  }, remainingMs);

  addLog(`Tunnel lifetime extended by +${extra}s (New TTL: ${Math.round(remainingMs / 1000)}s remaining)`, 'success');
  broadcast({ type: 'status', data: getStatusPayload() });

  res.json({
    message: `Extended by ${extra}s`,
    status: getStatusPayload()
  });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  eventClients.add(res);

  res.write(`data: ${JSON.stringify({ type: 'init', data: getStatusPayload(), logs: recentLogs })}\n\n`);

  req.on('close', () => {
    eventClients.delete(res);
  });
});

// Clean shutdown listeners
process.on('SIGTERM', () => {
  stopActiveTunnel('server_sigterm');
  process.exit(0);
});

process.on('SIGINT', () => {
  stopActiveTunnel('server_sigint');
  process.exit(0);
});

const server = app.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`[Dashboard Server] Listening on http://0.0.0.0:${PUBLIC_PORT}`);
  addLog(`Server online. Public interface on 0.0.0.0:${PUBLIC_PORT}, hidden proxy on ${INTERNAL_HOST}:${INTERNAL_PORT}`);
});
