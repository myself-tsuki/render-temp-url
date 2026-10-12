(() => {
  // Elements
  const form = document.getElementById('tunnel-form');
  const targetUrlInput = document.getElementById('target-url');
  const durationPreview = document.getElementById('duration-preview');
  const durationSecondsInput = document.getElementById('duration-seconds');
  const inputHrs = document.getElementById('input-hrs');
  const inputMins = document.getElementById('input-mins');
  const inputSecs = document.getElementById('input-secs');
  const durationPills = document.querySelectorAll('.pill');
  const presetChips = document.querySelectorAll('.chip');
  const btnSubmit = document.getElementById('btn-submit');
  const btnSubmitText = document.getElementById('btn-submit-text');
  const btnSpinner = document.getElementById('btn-spinner');

  const activeBanner = document.getElementById('active-banner');
  const liveTimer = document.getElementById('live-timer');
  const activeTunnelLink = document.getElementById('active-tunnel-link');
  const activeTargetDisplay = document.getElementById('active-target-display');
  const activeReqCount = document.getElementById('active-req-count');
  const timerProgressFill = document.getElementById('timer-progress-fill');
  const btnCopyUrl = document.getElementById('btn-copy-url');
  const copyBtnText = document.getElementById('copy-btn-text');
  const btnOpenUrl = document.getElementById('btn-open-url');
  const btnStopActive = document.getElementById('btn-stop-active');

  const consoleStream = document.getElementById('console-stream');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const badgePublicPort = document.getElementById('badge-public-port');
  const badgeStealthPort = document.getElementById('badge-stealth-port');
  const badgeConnStatus = document.getElementById('badge-conn-status');
  const connStatusText = document.getElementById('conn-status-text');

  let currentSession = null;
  let countdownInterval = null;

  // -----------------------------------------------------------
  // Time Pill & Inputs Coordination
  // -----------------------------------------------------------
  function updateTimeFromInputs() {
    const hrs = Math.max(0, parseInt(inputHrs.value || '0', 10));
    const mins = Math.max(0, parseInt(inputMins.value || '0', 10));
    const secs = Math.max(0, parseInt(inputSecs.value || '0', 10));

    let total = hrs * 3600 + mins * 60 + secs;
    if (total < 10) total = 10;
    if (total > 43200) total = 43200; // 12 hours max

    durationSecondsInput.value = total;

    // Format preview text
    let parts = [];
    if (hrs > 0) parts.push(`${hrs}h`);
    if (mins > 0) parts.push(`${mins}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    durationPreview.textContent = `${parts.join(' ')} (${total}s)`;

    // Check if matches any preset pill
    durationPills.forEach(pill => {
      const pSec = parseInt(pill.dataset.sec, 10);
      if (pSec === total) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });
  }

  function setTimeFromSeconds(totalSec) {
    let s = Math.max(10, Math.min(43200, totalSec));
    const hrs = Math.floor(s / 3600);
    s %= 3600;
    const mins = Math.floor(s / 60);
    const secs = s % 60;

    inputHrs.value = hrs;
    inputMins.value = mins;
    inputSecs.value = secs;
    updateTimeFromInputs();
  }

  durationPills.forEach(pill => {
    pill.addEventListener('click', () => {
      const sec = parseInt(pill.dataset.sec, 10);
      setTimeFromSeconds(sec);
    });
  });

  [inputHrs, inputMins, inputSecs].forEach(inp => {
    inp.addEventListener('input', updateTimeFromInputs);
  });

  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      targetUrlInput.value = chip.dataset.url;
      targetUrlInput.focus();
    });
  });

  // -----------------------------------------------------------
  // Logging Helper
  // -----------------------------------------------------------
  function appendLogEntry(entry) {
    const div = document.createElement('div');
    div.className = `console-entry ${entry.type || 'info'}`;

    const timeStr = entry.time ? new Date(entry.time).toLocaleTimeString() : new Date().toLocaleTimeString();
    div.innerHTML = `
      <span class="log-time">[${timeStr}]</span>
      <span class="log-msg">${escapeHtml(entry.message)}</span>
    `;

    consoleStream.appendChild(div);
    consoleStream.scrollTop = consoleStream.scrollHeight;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  btnClearLogs.addEventListener('click', () => {
    consoleStream.innerHTML = '';
  });

  // -----------------------------------------------------------
  // Countdown Timer & Active Banner
  // -----------------------------------------------------------
  function formatCountdown(secRemaining) {
    const h = Math.floor(secRemaining / 3600);
    const m = Math.floor((secRemaining % 3600) / 60);
    const s = secRemaining % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);

    const tick = () => {
      if (!currentSession || !currentSession.expiresAt) {
        clearInterval(countdownInterval);
        return;
      }

      const now = Date.now();
      const expiresAt = new Date(currentSession.expiresAt).getTime();
      const diffSec = Math.max(0, Math.floor((expiresAt - now) / 1000));

      liveTimer.textContent = formatCountdown(diffSec);

      if (currentSession.durationSeconds) {
        const pct = Math.max(0, Math.min(100, (diffSec / currentSession.durationSeconds) * 100));
        timerProgressFill.style.width = `${pct}%`;
      }

      if (diffSec <= 0) {
        clearInterval(countdownInterval);
        fetchStatus();
      }
    };

    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  function renderSessionState(session) {
    currentSession = session;

    if (!session || session.status === 'stopped' || session.status === 'failed') {
      activeBanner.style.display = 'none';
      btnSubmit.disabled = false;
      btnSpinner.style.display = 'none';
      btnSubmitText.textContent = 'Launch Cloudflare Tunnel';
      if (countdownInterval) clearInterval(countdownInterval);
      return;
    }

    activeBanner.style.display = 'block';
    activeTargetDisplay.textContent = session.targetUrl;

    if (session.status === 'starting') {
      activeTunnelLink.textContent = 'Allocating trycloudflare.com tunnel...';
      activeTunnelLink.removeAttribute('href');
      btnSubmit.disabled = true;
      btnSpinner.style.display = 'inline-block';
      btnSubmitText.textContent = 'Generating Quick Tunnel...';
    } else if (session.status === 'active' && session.tunnelUrl) {
      activeTunnelLink.textContent = session.tunnelUrl;
      activeTunnelLink.href = session.tunnelUrl;
      btnSubmit.disabled = false;
      btnSpinner.style.display = 'none';
      btnSubmitText.textContent = 'Restart / Switch Target';
    }

    startCountdown();
  }

  // -----------------------------------------------------------
  // Actions: Copy, Open, Stop
  // -----------------------------------------------------------
  btnCopyUrl.addEventListener('click', async () => {
    if (!currentSession || !currentSession.tunnelUrl) return;
    try {
      await navigator.clipboard.writeText(currentSession.tunnelUrl);
      copyBtnText.textContent = 'Copied!';
      setTimeout(() => { copyBtnText.textContent = 'Copy'; }, 2000);
    } catch (_) {
      prompt('Copy tunnel URL:', currentSession.tunnelUrl);
    }
  });

  btnOpenUrl.addEventListener('click', () => {
    if (currentSession && currentSession.tunnelUrl) {
      window.open(currentSession.tunnelUrl, '_blank', 'noopener,noreferrer');
    }
  });

  btnStopActive.addEventListener('click', async () => {
    if (!confirm('Destroy and close this Quick Tunnel session now?')) return;
    try {
      btnStopActive.disabled = true;
      const res = await fetch('/api/tunnel/stop', { method: 'POST' });
      const data = await res.json();
      renderSessionState(data.status?.session || null);
    } catch (e) {
      alert('Failed to stop tunnel: ' + e.message);
    } finally {
      btnStopActive.disabled = false;
    }
  });

  // -----------------------------------------------------------
  // Form Submission
  // -----------------------------------------------------------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const targetUrl = targetUrlInput.value.trim();
    const durationSeconds = parseInt(durationSecondsInput.value, 10);

    btnSubmit.disabled = true;
    btnSpinner.style.display = 'inline-block';
    btnSubmitText.textContent = 'Connecting...';

    try {
      const res = await fetch('/api/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl, durationSeconds })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start tunnel');
      }

      renderSessionState(data.status?.session || null);
    } catch (err) {
      alert(err.message);
      btnSubmit.disabled = false;
      btnSpinner.style.display = 'none';
      btnSubmitText.textContent = 'Launch Cloudflare Tunnel';
    }
  });

  // -----------------------------------------------------------
  // SSE Events & Polling
  // -----------------------------------------------------------
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.server) {
        badgePublicPort.textContent = `:${data.server.publicPort}`;
        badgeStealthPort.textContent = `${data.server.internalHost}:${data.server.internalPort}`;
      }
      if (data.stats) {
        activeReqCount.textContent = data.stats.totalRequests || 0;
      }
      renderSessionState(data.session);
    } catch (_) {}
  }

  function initSSE() {
    const sse = new EventSource('/api/events');

    sse.onopen = () => {
      connStatusText.textContent = 'LIVE FEED';
      badgeConnStatus.style.borderColor = 'rgba(0, 240, 255, 0.4)';
    };

    sse.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init') {
          if (msg.logs && Array.isArray(msg.logs)) {
            consoleStream.innerHTML = '';
            msg.logs.forEach(appendLogEntry);
          }
          if (msg.data) {
            renderSessionState(msg.data.session);
            if (msg.data.server) {
              badgePublicPort.textContent = `:${msg.data.server.publicPort}`;
              badgeStealthPort.textContent = `${msg.data.server.internalHost}:${msg.data.server.internalPort}`;
            }
            if (msg.data.stats) {
              activeReqCount.textContent = msg.data.stats.totalRequests || 0;
            }
          }
        } else if (msg.type === 'log') {
          appendLogEntry(msg.data);
        } else if (msg.type === 'status') {
          renderSessionState(msg.data.session);
        } else if (msg.type === 'stats') {
          activeReqCount.textContent = msg.data.totalRequests || 0;
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    sse.onerror = () => {
      connStatusText.textContent = 'RECONNECTING';
      badgeConnStatus.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    };
  }

  // Init
  setTimeFromSeconds(900); // 15 mins default
  fetchStatus();
  initSSE();
})();
