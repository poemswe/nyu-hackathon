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
  const host = location.hostname === 'localhost' ? 'localhost:8080' : location.host;
  return `${proto}://${host}/ws`;
})();

const FRAME_INTERVAL_MS = 1000;  // 1 FPS for vision mode
const AUDIO_INPUT_RATE = 16000;
const AUDIO_OUTPUT_RATE = 24000;
const MSG_TYPE_AUDIO = 0x01;
const MSG_TYPE_VIDEO = 0x02;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const STATES = ['idle', 'listening', 'briefing', 'vision'];
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

function connectWS() {
  setConnStatus('connecting', 'Connecting…');

  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // wait for "ready" message from server
  };

  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      // Binary = PCM audio from Gemini
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
    setConnStatus('error', 'Disconnected');
    reconnectDelay = Math.min((reconnectDelay || 1000) * 2, 15000);
    setTimeout(connectWS, reconnectDelay);
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

    case 'error':
      console.error('Server error:', msg.message);
      setConnStatus('error', 'Error');
      break;
  }
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
let lastBriefingTranscript = '';

function handleTranscript(text, role) {
  if (!text) return;

  // Auto-advance to briefing state when agent starts speaking
  if (role === 'model' && currentState === 'listening') {
    setState('briefing');
  }

  // Update appropriate transcript element based on state
  if (currentState === 'listening') {
    if (role === 'user') {
      document.getElementById('transcript-text').textContent = text;
    }
  } else if (currentState === 'briefing') {
    if (role === 'model') {
      appendBriefingTranscript(text);
      showSpeaking(true);
      clearTimeout(speakingTimeout);
      speakingTimeout = setTimeout(() => showSpeaking(false), 2500);
    }
  } else if (currentState === 'vision') {
    if (role === 'model') {
      document.getElementById('vision-transcript-text').textContent = text;
      // Count drafted violations (rough heuristic)
      if (text.toLowerCase().includes('draft') || text.toLowerCase().includes('class')) {
        violationCount++;
        document.getElementById('vcount-num').textContent = violationCount;
      }
    }
  }

  // Parse structured data from transcript text
  extractDataFromTranscript(text);
}

function appendBriefingTranscript(text) {
  const el = document.getElementById('briefing-transcript');
  // Ignore exact duplicate transcript events.
  if (text === lastBriefingTranscript) return;

  // Many live transcript streams are cumulative (new text starts with old text).
  // Replace the last paragraph instead of appending a duplicate block.
  if (lastBriefingTranscript && text.startsWith(lastBriefingTranscript) && el.lastElementChild) {
    el.lastElementChild.textContent = text;
    el.lastElementChild.innerHTML = el.lastElementChild.innerHTML.replace(
      /\b(\d+)\b/g,
      '<span class="highlight">$1</span>'
    );
  } else {
    const p = document.createElement('p');
    p.textContent = text;
    p.innerHTML = p.innerHTML.replace(/\b(\d+)\b/g, '<span class="highlight">$1</span>');
    el.appendChild(p);
  }

  lastBriefingTranscript = text;
  el.scrollTop = el.scrollHeight;
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
  const portViolMatch = text.match(/([\d,]+)\s+(?:combined\s+|total\s+)?(?:open\s+)?violations/i);
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
      if (!wsReady || agentSpeaking) return;
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
const audioQueue = [];
let isPlaying = false;
let agentSpeaking = false;

function playAudio(arrayBuffer) {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: AUDIO_OUTPUT_RATE
    });
  }
  agentSpeaking = true;
  audioQueue.push(arrayBuffer);
  if (!isPlaying) drainAudioQueue();
}

function drainAudioQueue() {
  if (!audioQueue.length) {
    isPlaying = false;
    agentSpeaking = false;
    return;
  }
  isPlaying = true;
  const buf = audioQueue.shift();

  // PCM int16 → float32
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
  source.start();
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

  // Mic button (idle state)
  document.getElementById('mic-button').addEventListener('click', () => {
    if (!wsReady) {
      alert('Not connected yet. Please wait a moment.');
      return;
    }
    // Reset briefing state
    resetBriefing();
    startMic();
    setState('listening');
  });

  // Back buttons
  document.getElementById('listen-back').addEventListener('click', () => setState('idle'));
  document.getElementById('briefing-back').addEventListener('click', () => {
    stopMic();
    setState('idle');
  });
  document.getElementById('vision-back').addEventListener('click', () => setState('briefing'));

  // Enter vision mode from briefing
  document.getElementById('enter-vision').addEventListener('click', () => {
    violationCount = 0;
    document.getElementById('vcount-num').textContent = '0';
    document.getElementById('vision-transcript-text').textContent = '';
    setState('vision');
    // Keep mic running in vision mode
    if (!micStream) startMic({ setListeningState: false }).catch(() => {});
  });
});

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
  showSpeaking(false);
}
