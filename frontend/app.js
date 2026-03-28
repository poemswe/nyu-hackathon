/**
 * SlumlordWatch PWA — app.js
 * 4-state inspector UI: Idle → Listening → Briefing → Vision
 *
 * Audio: getUserMedia → PCM → WebSocket → Gemini Live → AudioContext playback
 * Video: getUserMedia (camera) → Canvas → 1 FPS JPEG → WebSocket
 */

'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
})();

const FRAME_INTERVAL_MS = 1000;  // 1 FPS for vision mode
const AUDIO_INPUT_RATE = 16000;
const AUDIO_OUTPUT_RATE = 24000;
const MSG_TYPE_AUDIO = 0x01;
const MSG_TYPE_VIDEO = 0x02;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const STATES = ['idle', 'listening', 'briefing', 'vision', 'report'];
let currentState = 'idle';

function setState(name) {
  if (!STATES.includes(name)) return;
  document.querySelectorAll('.state').forEach(el => el.classList.remove('active'));
  document.getElementById(`state-${name}`).classList.add('active');
  currentState = name;

  if (name !== 'listening' && name !== 'vision') stopMic();
  if (name !== 'vision') stopCamera();
  if (name === 'vision') startCamera();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

let ws = null;
let wsReady = false;
let reconnectDelay = 1000;
let reconnectTimer = null;
let shouldReconnect = true;

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  setConnStatus('connecting', 'Connecting…');

  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // wait for "ready" message from server
  };

  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      // Binary = PCM audio from Gemini
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (currentState === 'listening' && !briefingTurnLocked) {
        briefingTurnLocked = true;
        stopMic();
        setState('briefing');
      }
      playAudio(evt.data);
      showSpeaking(true);
    } else {
      try {
        const msg = JSON.parse(evt.data);
        handleServerMessage(msg);
      } catch (e) {
        console.warn('Non-JSON text message:', evt.data);
      }
    }
  };

  ws.onclose = (evt) => {
    wsReady = false;
    if (evt.code === 1000) {
      setConnStatus('error', 'Session ended');
      return;
    }
    if (!shouldReconnect) return;
    setConnStatus('error', 'Disconnected');
    reconnectDelay = Math.min((reconnectDelay || 1000) * 2, 15000);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, reconnectDelay);
  };

  ws.onerror = (e) => {
    console.error('WS error', e);
    setConnStatus('error', 'Connection error');
  };
}

function sendBinary(typeTag, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const buf = new Uint8Array(1 + payload.byteLength);
  buf[0] = typeTag;
  buf.set(new Uint8Array(payload), 1);
  ws.send(buf.buffer);
}

function sendControl(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'ready':
      wsReady = true;
      reconnectDelay = 1000;
      setConnStatus('connected', 'Ready');
      break;

    case 'transcript':
      handleTranscript(msg.text, msg.role);
      break;

    case 'progress':
      handleProgress(msg.text);
      break;

    case 'tool_result':
      // Tool results trigger data card population
      // Actual data comes via transcript; this is just a signal
      break;

    case 'data':
      // Structured data from tools — populate UI cards
      populateCards(msg.data);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'turn_complete':
      finalizeBriefingTranscript();
      showSpeaking(false);
      agentSpeaking = false;
      briefingTurnLocked = false;
      if (currentState === 'briefing') {
        const ctaWrap = document.getElementById('briefing-cta-wrap');
        if (ctaWrap) ctaWrap.style.display = 'block';
      }
      break;

    case 'error':
      console.error('Server error:', msg.message);
      setConnStatus('error', 'Error');
      break;
  }
}

function normalizeTranscriptText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function handleProgress(text) {
  const clean = normalizeTranscriptText(text);
  if (!clean) return;
  if (currentState === 'listening') {
    briefingTurnLocked = true;
    stopMic();
    setState('briefing');
  }
  appendStatusLine(clean);
  speakProgress(clean);
}

function appendStatusLine(text) {
  const el = document.getElementById('briefing-transcript');
  finalizeBriefingTranscript();
  const p = document.createElement('p');
  p.className = 'status-line';
  p.textContent = text;
  el.appendChild(p);
  el.scrollTop = el.scrollHeight;
}

function speakProgress(text) {
  if (!progressSpeechEnabled) return;
  if (!('speechSynthesis' in window)) return;
  if (!text || text === lastProgressSpoken) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.volume = 1.0;
  lastProgressSpoken = text;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

function setConnStatus(status, label) {
  const dot = document.getElementById('conn-status');
  const lbl = document.getElementById('conn-label');
  dot.className = `status-dot ${status}`;
  lbl.textContent = label;
}

// ---------------------------------------------------------------------------
// Transcript handling
// ---------------------------------------------------------------------------

let transcriptBuffer = '';
let speakingTimeout = null;
let violationCount = 0;
let draftedViolations = [];
let pendingViolation = null;
let lastBriefingTranscript = '';
let briefingTurnLocked = false;
let briefingLiveText = '';
let briefingLiveEl = null;
let progressSpeechEnabled = true;
let lastProgressSpoken = '';

function handleTranscript(text, role) {
  if (!text) return;
  const clean = normalizeTranscriptText(text);

  if (currentState === 'listening') {
    if (role === 'user') {
      document.getElementById('transcript-text').textContent = clean;
    } else if (role === 'model') {
      const asking = /address|try again|which building|what building|could you repeat/i.test(clean);
      if (asking) {
        stopMic();
        setState('idle');
        const cta = document.querySelector('.cta-text');
        if (cta) cta.textContent = "Didn't catch that. Tap to try again.";
      }
    }
  } else if (currentState === 'briefing') {
    if (role === 'model') {
      appendBriefingTranscript(clean);
      showSpeaking(true);
      clearTimeout(speakingTimeout);
      speakingTimeout = setTimeout(() => showSpeaking(false), 2500);
    }
  } else if (currentState === 'vision') {
    if (role === 'model') {
      document.getElementById('vision-transcript-text').textContent = text;
      const lower = text.toLowerCase();
      // AI suggests a violation → store as pending, wait for user confirmation
      if (lower.includes('class') && /class\s*[abc]/i.test(text)) {
        const classMatch = text.match(/class\s*([ABC])/i);
        pendingViolation = {
          text: text.trim(),
          severity: classMatch ? classMatch[1].toUpperCase() : 'B',
          timestamp: new Date().toLocaleTimeString(),
        };
        showPendingBadge(true);
      }
    } else if (role === 'user') {
      // User confirms → promote pending violation to drafted
      const lower = text.toLowerCase();
      const confirmed = /\b(yes|yeah|yep|correct|confirm|affirm|approved|do it|go ahead)\b/i.test(lower);
      const rejected = /\b(no|nope|cancel|skip|wrong|reject|redo)\b/i.test(lower);
      if (pendingViolation && confirmed) {
        violationCount++;
        draftedViolations.push({
          ...pendingViolation,
          id: violationCount,
        });
        pendingViolation = null;
        showPendingBadge(false);
      } else if (pendingViolation && rejected) {
        pendingViolation = null;
        showPendingBadge(false);
      }
    }
  }

  // Parse structured data from transcript text
  extractDataFromTranscript(clean);
}

function appendBriefingTranscript(text) {
  const el = document.getElementById('briefing-transcript');
  const clean = normalizeTranscriptText(text);
  if (!clean) return;
  if (clean === lastBriefingTranscript) return;

  if (!briefingLiveEl) {
    briefingLiveEl = document.createElement('p');
    el.appendChild(briefingLiveEl);
  }

  // Handle two transcript styles:
  // 1) cumulative: each chunk contains the full text so far
  // 2) incremental: each chunk is a word/phrase token
  if (!briefingLiveText) {
    briefingLiveText = clean;
  } else if (clean.startsWith(briefingLiveText)) {
    // Cumulative update: replace with fuller version.
    briefingLiveText = clean;
  } else if (briefingLiveText.startsWith(clean)) {
    // Older/shorter duplicate chunk: ignore.
  } else {
    // Incremental token: append to current paragraph.
    const joiner = /^[,.;:!?)]/.test(clean) ? '' : ' ';
    briefingLiveText = `${briefingLiveText}${joiner}${clean}`.trim();
  }

  briefingLiveEl.textContent = briefingLiveText;

  lastBriefingTranscript = clean;
  el.scrollTop = el.scrollHeight;
}

function finalizeBriefingTranscript() {
  briefingLiveEl = null;
  briefingLiveText = '';
  lastProgressSpoken = '';
}

// Heuristic extractor — populates data cards from agent speech
function extractDataFromTranscript(text) {
  const t = text.toLowerCase();

  // Violations
  const violMatch = text.match(/(\d+)\s+open violation/i);
  if (violMatch) {
    revealCard('card-violations');
    document.getElementById('val-violations').textContent = violMatch[1];
  }

  // Class C
  const classC = text.match(/(\d+)\s+(?:are\s+)?class\s*c/i);
  if (classC) document.getElementById('badge-c').textContent = `C: ${classC[1]}`;

  // Class B
  const classB = text.match(/(\d+)\s+(?:are\s+)?class\s*b/i);
  if (classB) document.getElementById('badge-b').textContent = `B: ${classB[1]}`;

  // Class A
  const classA = text.match(/(\d+)\s+(?:are\s+)?class\s*a/i);
  if (classA) document.getElementById('badge-a').textContent = `A: ${classA[1]}`;

  // Complaints
  const complMatch = text.match(/(\d+)\s+complaint/i);
  if (complMatch) {
    revealCard('card-complaints');
    document.getElementById('val-complaints').textContent = complMatch[1];
    const trend = document.getElementById('trend-indicator');
    if (t.includes('increas') || t.includes('trending up')) {
      trend.textContent = '↑ Trending up';
      trend.className = 'trend-indicator up';
    } else if (t.includes('decreas') || t.includes('trending down')) {
      trend.textContent = '↓ Trending down';
      trend.className = 'trend-indicator down';
    }
  }

  // Owner / corporation
  const ownerMatch = text.match(/registered owner is ([^.]+)/i) ||
                     text.match(/([A-Z][A-Z\s\d]+(?:LLC|LP|INC|CORP))/);
  if (ownerMatch) {
    revealCard('card-owner');
    document.getElementById('val-owner').textContent = ownerMatch[1].trim();
  }

  // Watchlist
  if (t.includes('worst landlord watchlist') || t.includes('watchlist')) {
    const watchBadge = document.getElementById('watchlist-badge');
    watchBadge.style.display = 'inline-flex';
    const rankMatch = text.match(/number\s+(\d+)/i) || text.match(/rank\s+(\d+)/i);
    if (rankMatch) {
      watchBadge.textContent = `⚠ WATCHLIST #${rankMatch[1]}`;
    }
  }

  // Portfolio
  const portMatch = text.match(/(\d+)\s+(?:other\s+)?buildings/i);
  const portViolMatch =
    text.match(/(?:with|across)\s+([\d,]+)\s+(?:open\s+)?violations(?:\s+across\s+\d+\s+buildings)?/i) ||
    text.match(/([\d,]+)\s+(?:combined\s+)?(?:open\s+)?violations\s+across\s+\d+\s+buildings/i);
  if (portMatch) {
    revealCard('card-portfolio');
    document.getElementById('val-portfolio').textContent = `${portMatch[1]} buildings`;
    if (portViolMatch) {
      document.getElementById('val-portfolio-sub').textContent =
        `${portViolMatch[1]} total violations`;
    }
  }
}

function revealCard(id) {
  const card = document.getElementById(id);
  if (card.style.display === 'none') {
    card.style.display = 'block';
    card.classList.add('revealed');
  }
}

// For structured data sent directly from server (not just transcript)
function populateCards(data) {
  if (!data) return;

  if (data.violations) {
    const v = data.violations;
    revealCard('card-violations');
    document.getElementById('val-violations').textContent = v.total;
    document.getElementById('badge-c').textContent = `C: ${v.class_c}`;
    document.getElementById('badge-b').textContent = `B: ${v.class_b}`;
    document.getElementById('badge-a').textContent = `A: ${v.class_a}`;
  }

  if (data.owner) {
    const o = data.owner;
    revealCard('card-owner');
    const name = o.corporate_owner || o.individual_owner || 'Unknown';
    document.getElementById('val-owner').textContent = name;
    if (o.watchlist) {
      const wb = document.getElementById('watchlist-badge');
      wb.style.display = 'inline-flex';
      wb.textContent = `⚠ WATCHLIST #${o.watchlist.rank}`;
    }
  }

  if (data.complaints) {
    const c = data.complaints;
    revealCard('card-complaints');
    document.getElementById('val-complaints').textContent = c.total_12mo;
    const trend = document.getElementById('trend-indicator');
    if (c.trend?.trending_up) {
      trend.textContent = `↑ Trending up (${c.trend.last_3mo} in last 3 mo)`;
      trend.className = 'trend-indicator up';
    }
  }

  if (data.portfolio?.found) {
    const p = data.portfolio;
    revealCard('card-portfolio');
    document.getElementById('val-portfolio').textContent = `${p.total_buildings} buildings`;
    document.getElementById('val-portfolio-sub').textContent =
      `${p.total_open_violations.toLocaleString()} total violations`;
  }
}

// ---------------------------------------------------------------------------
// Agent speaking indicator
// ---------------------------------------------------------------------------

function showSpeaking(on) {
  document.getElementById('agent-speaking').classList.toggle('active', on);
}

// ---------------------------------------------------------------------------
// Audio: mic → WebSocket
// ---------------------------------------------------------------------------

let audioContext = null;
let micStream = null;
let scriptProcessor = null;

async function startMic(options = {}) {
  const { setListeningState = true } = options;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: AUDIO_INPUT_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });
    micStream = stream;

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: AUDIO_INPUT_RATE
    });

    const source = audioContext.createMediaStreamSource(stream);
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (!wsReady || agentSpeaking || briefingTurnLocked) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = float32ToInt16(float32);
      sendBinary(MSG_TYPE_AUDIO, int16.buffer);
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    document.getElementById('mic-button').classList.add('recording');
    if (setListeningState) {
      setState('listening');
    }

  } catch (err) {
    console.error('Mic error:', err);
    alert('Microphone access required. Please allow microphone permissions.');
  }
}

function stopMic() {
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  document.getElementById('mic-button').classList.remove('recording');
}

function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

// ---------------------------------------------------------------------------
// Audio: WebSocket → speaker playback
// ---------------------------------------------------------------------------

let playbackContext = null;
let playbackUnlocked = false;
const audioQueue = [];
let isPlaying = false;
let agentSpeaking = false;
let nextPlayTime = 0;

async function unlockPlaybackAudio() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: AUDIO_OUTPUT_RATE
    });
  }
  if (playbackContext.state === 'suspended') {
    try {
      await playbackContext.resume();
    } catch (e) {
      console.warn('Audio resume blocked:', e);
    }
  }
  if (playbackContext.state === 'running' && !playbackUnlocked) {
    const silent = playbackContext.createBuffer(1, 1, AUDIO_OUTPUT_RATE);
    const src = playbackContext.createBufferSource();
    src.buffer = silent;
    src.connect(playbackContext.destination);
    src.start();
    playbackUnlocked = true;
  }
  if (playbackContext.state === 'running' && audioQueue.length && !isPlaying) {
    drainAudioQueue();
  }
  return playbackContext.state === 'running';
}

async function playAudio(arrayBuffer) {
  agentSpeaking = true;
  audioQueue.push(arrayBuffer);
  if (!playbackContext) return;
  if (playbackContext.state === 'suspended') {
    try {
      await playbackContext.resume();
    } catch (e) {
      console.warn('playAudio resume failed:', e);
    }
  }
  if (!isPlaying) drainAudioQueue();
}

function drainAudioQueue() {
  if (!audioQueue.length) {
    isPlaying = false;
    agentSpeaking = false;
    nextPlayTime = 0;
    return;
  }
  if (!playbackContext) {
    isPlaying = false;
    return;
  }
  if (playbackContext.state === 'suspended') {
    isPlaying = false;
    playbackContext.resume().then(() => {
      if (playbackContext.state === 'running' && audioQueue.length && !isPlaying) {
        drainAudioQueue();
      }
    }).catch(() => {});
    return;
  }
  if (playbackContext.state !== 'running') {
    isPlaying = false;
    return;
  }
  isPlaying = true;
  const buf = audioQueue.shift();

  const int16 = new Int16Array(buf);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
  }

  const audioBuf = playbackContext.createBuffer(1, float32.length, AUDIO_OUTPUT_RATE);
  audioBuf.copyToChannel(float32, 0);

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuf;
  source.connect(playbackContext.destination);
  source.onended = drainAudioQueue;

  const now = playbackContext.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += audioBuf.duration;
}

// ---------------------------------------------------------------------------
// Camera: vision mode
// ---------------------------------------------------------------------------

let cameraStream = null;
let frameInterval = null;

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',  // rear camera
        width: { ideal: 1280 },
        height: { ideal: 720 },
      }
    });

    const video = document.getElementById('camera-feed');
    video.srcObject = cameraStream;

    // Start 1 FPS capture loop
    frameInterval = setInterval(captureFrame, FRAME_INTERVAL_MS);

  } catch (err) {
    console.error('Camera error:', err);
    // Don't crash — vision mode is optional
  }
}

function stopCamera() {
  clearInterval(frameInterval);
  frameInterval = null;
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const video = document.getElementById('camera-feed');
  video.srcObject = null;
}

function captureFrame() {
  if (!wsReady) return;
  const video = document.getElementById('camera-feed');
  if (!video.videoWidth) return;

  const canvas = document.getElementById('capture-canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  canvas.toBlob((blob) => {
    if (!blob) return;
    blob.arrayBuffer().then(buf => {
      sendBinary(MSG_TYPE_VIDEO, buf);
      // Flash analyzing badge
      const badge = document.getElementById('analyzing-badge');
      badge.classList.add('active');
      setTimeout(() => badge.classList.remove('active'), 800);
    });
  }, 'image/jpeg', 0.85);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Connect WebSocket immediately
  connectWS();

  // Mobile autoplay policy workaround: unlock once on first user gesture.
  const unlockOnce = async () => {
    const ok = await unlockPlaybackAudio();
    if (ok) {
      window.removeEventListener('touchstart', unlockOnce);
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('click', unlockOnce);
    }
  };
  window.addEventListener('touchstart', unlockOnce, { passive: true });
  window.addEventListener('pointerdown', unlockOnce, { passive: true });
  window.addEventListener('click', unlockOnce, { passive: true });

  // Watchdog: if audio is queued but context suspended on mobile, try to resume
  setInterval(() => {
    if (playbackContext && playbackContext.state === 'suspended' && audioQueue.length > 0) {
      playbackContext.resume().then(() => {
        if (!isPlaying && audioQueue.length) drainAudioQueue();
      }).catch(() => {});
    }
  }, 500);

  // Mic button (idle state)
  document.getElementById('mic-button').addEventListener('click', async () => {
    if (!wsReady) {
      alert('Not connected yet. Please wait a moment.');
      return;
    }
    await unlockPlaybackAudio();
    resetBriefing();
    const cta = document.querySelector('.cta-text');
    if (cta) cta.textContent = 'Tap to speak an address';
    sendControl({ type: 'start_turn', mode: 'briefing' });
    startMic();
  });

  // Back buttons
  document.getElementById('listen-back').addEventListener('click', () => setState('idle'));
  document.getElementById('briefing-back').addEventListener('click', () => {
    stopMic();
    setState('idle');
  });
  document.getElementById('vision-back').addEventListener('click', () => setState('briefing'));

  async function enterVisionMode() {
    violationCount = 0;
    draftedViolations = [];
    pendingViolation = null;
    showPendingBadge(false);
    document.getElementById('vcount-num').textContent = '0';
    document.getElementById('vision-transcript-text').textContent = '';
    const ctaWrap = document.getElementById('briefing-cta-wrap');
    if (ctaWrap) ctaWrap.style.display = 'none';
    sendControl({ type: 'start_turn', mode: 'vision' });
    await unlockPlaybackAudio();
    setState('vision');
    // Keep mic running in vision mode
    if (!micStream) startMic({ setListeningState: false }).catch(() => {});
  }

  // Enter vision mode from briefing
  document.getElementById('enter-vision').addEventListener('click', () => {
    enterVisionMode().catch(() => {});
  });
  document.getElementById('briefing-cta-vision').addEventListener('click', () => {
    enterVisionMode().catch(() => {});
  });

  // Vision "Done" → show report
  document.getElementById('vision-done').addEventListener('click', () => {
    stopMic();
    stopCamera();
    populateReport();
    setState('report');
  });

  // Report back → return to vision
  document.getElementById('report-back').addEventListener('click', () => {
    setState('vision');
  });

  // Report new inspection → back to idle
  document.getElementById('report-new').addEventListener('click', () => {
    draftedViolations = [];
    violationCount = 0;
    setState('idle');
  });
});

window.addEventListener('beforeunload', () => {
  shouldReconnect = false;
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close(1000, 'page unload');
  }
});

function showPendingBadge(on) {
  const badge = document.getElementById('pending-badge');
  if (badge) badge.classList.toggle('active', on);
}

function populateReport() {
  const list = document.getElementById('report-violations-list');
  list.innerHTML = '';
  document.getElementById('report-count').textContent = draftedViolations.length;

  if (draftedViolations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'report-empty';
    empty.textContent = 'No violations drafted during this inspection.';
    list.appendChild(empty);
    return;
  }

  draftedViolations.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'report-violation-item';
    item.innerHTML = `
      <div class="report-v-header">
        <span class="badge badge-${v.severity.toLowerCase()}">CLASS ${v.severity}</span>
        <span class="report-v-time">${escapeHtml(v.timestamp)}</span>
      </div>
      <p class="report-v-text">${escapeHtml(v.text)}</p>
    `;
    list.appendChild(item);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function resetBriefing() {
  // Hide and reset all data cards
  ['card-violations', 'card-owner', 'card-complaints', 'card-portfolio'].forEach(id => {
    const card = document.getElementById(id);
    card.style.display = 'none';
    card.classList.remove('revealed');
  });
  document.getElementById('val-violations').textContent = '—';
  document.getElementById('val-owner').textContent = '—';
  document.getElementById('val-complaints').textContent = '—';
  document.getElementById('val-portfolio').textContent = '—';
  document.getElementById('val-portfolio-sub').textContent = '';
  document.getElementById('badge-c').textContent = 'C: —';
  document.getElementById('badge-b').textContent = 'B: —';
  document.getElementById('badge-a').textContent = 'A: —';
  document.getElementById('watchlist-badge').style.display = 'none';
  document.getElementById('trend-indicator').textContent = '';
  document.getElementById('trend-indicator').className = 'trend-indicator';
  document.getElementById('briefing-transcript').innerHTML = '';
  lastBriefingTranscript = '';
  briefingTurnLocked = false;
  briefingLiveText = '';
  briefingLiveEl = null;
  lastProgressSpoken = '';
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  const ctaWrap = document.getElementById('briefing-cta-wrap');
  if (ctaWrap) ctaWrap.style.display = 'none';
  showSpeaking(false);
}
