'use strict';

const CANVAS_W = 1280;
const CANVAS_H = 720;
const LERP     = 0.10;

const LAYOUT = {
  SPLIT:      'split',
  HOST_MAIN:  'host-main',
  GUEST_MAIN: 'guest-main',
  SCREEN:     'screen',
  MEDIA:      'media',
};

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ── State ──────────────────────────────────────────────────────────────────

const roomId      = new URLSearchParams(location.search).get('room');
let socket        = null;
let pc            = null;
let localStream   = null;
let remoteStream  = null;
let currentLayout = LAYOUT.SPLIT;
let isRecording   = false;
let recorder      = null;
let chunks        = [];
let isMuted       = false;
let isCamOff      = false;

// ── DOM ────────────────────────────────────────────────────────────────────

const canvas    = document.getElementById('studioCanvas');
const ctx       = canvas.getContext('2d');
canvas.width    = CANVAS_W;
canvas.height   = CANVAS_H;

const localVid  = makeVid(true);
const remoteVid = makeVid(false);

function makeVid(muted) {
  const v = document.createElement('video');
  v.autoplay = v.playsInline = true;
  v.muted = muted;
  return v;
}

// ── Animated panel system ──────────────────────────────────────────────────
// Guest mirrors the host's layout. Remote = host's feed (camera, screen, or media).
// In MEDIA layout: remote (content) fills 2/3, local fills right 1/3.

function makePanel(x, y, w, h, alpha = 1) {
  return { cX:x, cY:y, cW:w, cH:h, cA:alpha, tX:x, tY:y, tW:w, tH:h, tA:alpha };
}

const W2  = CANVAS_W / 2;
const W3  = CANVAS_W / 3;
const W23 = CANVAS_W * 2 / 3;
const H2  = CANVAS_H / 2;

// Initial: SPLIT — host (remote) left, guest (local) right
const panels = {
  remote: makePanel(0,  0, W2, CANVAS_H, 1),
  local:  makePanel(W2, 0, W2, CANVAS_H, 1),
};

function target(panel, x, y, w, h, alpha) {
  panel.tX = x; panel.tY = y; panel.tW = w; panel.tH = h; panel.tA = alpha;
}

function stepPanels() {
  for (const p of Object.values(panels)) {
    p.cX = lerp(p.cX, p.tX, LERP);
    p.cY = lerp(p.cY, p.tY, LERP);
    p.cW = lerp(p.cW, p.tW, LERP);
    p.cH = lerp(p.cH, p.tH, LERP);
    p.cA = lerp(p.cA, p.tA, LERP);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

function applyLayoutTargets(layout) {
  const PIP_W = 300, PIP_H = 169, PAD = 16;
  switch (layout) {
    case LAYOUT.SPLIT:
      // Host left, guest right — same as initial
      target(panels.remote, 0,   0, W2,       CANVAS_H, 1);
      target(panels.local,  W2,  0, W2,       CANVAS_H, 1);
      break;

    case LAYOUT.HOST_MAIN:
      // Host fills, guest PiP
      target(panels.remote, 0,                          0,                        CANVAS_W, CANVAS_H, 1);
      target(panels.local,  CANVAS_W - PIP_W - PAD,     CANVAS_H - PIP_H - PAD,  PIP_W,    PIP_H,    1);
      break;

    case LAYOUT.GUEST_MAIN:
      // Guest fills, host PiP
      target(panels.local,  0,                          0,                        CANVAS_W, CANVAS_H, 1);
      target(panels.remote, CANVAS_W - PIP_W - PAD,     CANVAS_H - PIP_H - PAD,  PIP_W,    PIP_H,    1);
      break;

    case LAYOUT.SCREEN:
      // Host's stream (now screen) fills, guest PiP bottom-right
      target(panels.remote, 0,                          0,                        CANVAS_W, CANVAS_H, 1);
      target(panels.local,  CANVAS_W - PIP_W - PAD,     CANVAS_H - PIP_H - PAD,  PIP_W,    PIP_H,    1);
      break;

    case LAYOUT.MEDIA:
      // Host's stream (now media) fills 2/3 left, guest fills right 1/3
      target(panels.remote, 0,    0,  W23, CANVAS_H, 1);
      target(panels.local,  W23,  0,  W3,  CANVAS_H, 1);
      break;
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  if (!roomId) { setStatus('No room code in URL', 'error'); return; }

  document.getElementById('roomCode').textContent = roomId;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {});
    setupLocalAnalyser();
    await populateDevices();
  } catch (e) {
    setStatus('Camera/mic access denied — check browser permissions', 'error');
    return;
  }

  socket = io();

  socket.on('joined', () => setStatus('Joined room — waiting for host…', 'info'));
  socket.on('error', msg => setStatus('Error: ' + msg, 'error'));
  socket.on('join-error', msg => {
    setStatus(msg || 'Could not join room', 'warning');
    // If the host simply hasn't opened the room yet, keep retrying quietly
    clearTimeout(window._rejoinTimer);
    window._rejoinTimer = setTimeout(() => {
      socket.emit('join-room', { roomId, role: 'guest' });
    }, 3000);
  });

  socket.on('signal', async (data) => {
    if (!pc) await buildPeerConnection();
    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { roomId, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'candidate' && data.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  });

  socket.on('layout-change', layout => {
    currentLayout = layout;
    applyLayoutTargets(layout);
  });

  socket.on('screen-share-change', active => {
    if (!active && currentLayout === LAYOUT.SCREEN) {
      currentLayout = LAYOUT.SPLIT;
      applyLayoutTargets(LAYOUT.SPLIT);
    }
  });

  socket.on('media-share-change', active => {
    if (!active && currentLayout === LAYOUT.MEDIA) {
      currentLayout = LAYOUT.SPLIT;
      applyLayoutTargets(LAYOUT.SPLIT);
    }
  });

  socket.on('recording-start', startRecording);
  socket.on('recording-stop',  stopRecording);

  socket.on('peer-disconnected', () => {
    setStatus('Host disconnected', 'warning');
    remoteStream = null;
    remoteVid.srcObject = null;
    if (pc) { pc.close(); pc = null; }
    const hint = document.getElementById('overlayHint');
    if (hint) { hint.textContent = 'Host disconnected'; hint.classList.remove('hidden'); }
  });

  socket.emit('join-room', { roomId, role: 'guest' });
  renderLoop();
}

async function buildPeerConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(ICE);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { roomId, data: { type: 'candidate', candidate } });
  };

  pc.ontrack = ({ streams }) => {
    remoteStream = streams[0];
    remoteVid.srcObject = remoteStream;
    remoteVid.play().catch(() => {});
    setStatus('Connected', 'success');
    const hint = document.getElementById('overlayHint');
    if (hint) hint.classList.add('hidden');
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') setStatus('Connection failed — try refreshing', 'error');
  };
}

// ── Render loop ────────────────────────────────────────────────────────────

function renderLoop() {
  stepPanels();

  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const hasLocal  = localStream  && localVid.readyState  >= 2;
  const hasRemote = remoteStream && remoteVid.readyState >= 2;

  // Remote always behind local
  drawPanel(hasRemote ? remoteVid : null, panels.remote, 'Host');
  drawPanel(hasLocal  ? localVid  : null, panels.local,  'You');

  // Dividers
  const splitAlpha = currentLayout === LAYOUT.SPLIT ? Math.min(panels.remote.cA, panels.local.cA) : 0;
  if (splitAlpha > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${0.08 * splitAlpha})`;
    ctx.fillRect(panels.remote.cX + panels.remote.cW - 1, 0, 2, CANVAS_H);
  }

  if (currentLayout === LAYOUT.MEDIA && panels.remote.cW < CANVAS_W - 10) {
    ctx.fillStyle = `rgba(255,255,255,0.06)`;
    ctx.fillRect(panels.remote.cX + panels.remote.cW - 1, 0, 2, CANVAS_H);
  }

  if (isRecording) drawRecBadge();

  requestAnimationFrame(renderLoop);
}

function drawPanel(video, panel, label) {
  const { cX: x, cY: y, cW: w, cH: h, cA: a } = panel;
  if (w < 2 || h < 2 || a < 0.02) return;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, a));

  if (!video || video.videoWidth === 0) {
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(x, y, w, h);
    if (a > 0.5) {
      ctx.fillStyle = '#444';
      ctx.font = `${Math.max(12, Math.min(16, w / 20))}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2);
    }
  } else {
    const vW = video.videoWidth, vH = video.videoHeight;
    const vR = vW / vH, tR = w / h;
    let sx, sy, sw, sh;
    if (vR > tR) { sh = vH; sw = vH * tR; sx = (vW - sw) / 2; sy = 0; }
    else         { sw = vW; sh = vW / tR; sx = 0; sy = (vH - sh) / 2; }
    ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
  }

  ctx.restore();
}

function drawRecBadge() {
  ctx.save();
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath();
  ctx.arc(CANVAS_W - 22, 22, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('REC', CANVAS_W - 34, 22);
  ctx.restore();
}

// ── Audio meter + device selection ─────────────────────────────────────────

let audioCtx = null;
let localAnalyser = null;

function setupLocalAnalyser() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    localAnalyser = audioCtx.createAnalyser();
    localAnalyser.fftSize = 256;
    audioCtx.createMediaStreamSource(localStream).connect(localAnalyser);
  } catch (_) {}
}

function getRMS(analyser) {
  if (!analyser) return 0;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const n = (v - 128) / 128; sum += n * n; }
  return Math.sqrt(sum / buf.length);
}

function updateMicMeter() {
  const fill = document.getElementById('micMeterFill');
  if (!fill || !localAnalyser) return;
  const pct = Math.min(100, Math.round(getRMS(localAnalyser) * 280));
  fill.style.width = pct + '%';
  fill.classList.toggle('hot', pct > 85);
}

async function populateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');
    const camSel = document.getElementById('cameraSelect');
    const micSel = document.getElementById('micSelect');
    const curCam = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
    const curMic = localStream?.getAudioTracks()[0]?.getSettings().deviceId;

    camSel.innerHTML = '';
    cams.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === curCam) o.selected = true;
      camSel.appendChild(o);
    });
    micSel.innerHTML = '';
    mics.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Mic ${i + 1}`;
      if (d.deviceId === curMic) o.selected = true;
      micSel.appendChild(o);
    });
  } catch (_) {}
}

async function switchDevices() {
  const camId = document.getElementById('cameraSelect').value;
  const micId = document.getElementById('micSelect').value;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: camId ? { exact: camId } : undefined,
               width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: { deviceId: micId ? { exact: micId } : undefined,
               echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
    const newV = newStream.getVideoTracks()[0];
    const newA = newStream.getAudioTracks()[0];
    if (pc) {
      const vs = pc.getSenders().find(s => s.track?.kind === 'video');
      if (vs && newV) vs.replaceTrack(newV);
      const as = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (as && newA) as.replaceTrack(newA);
    }
    localStream.getTracks().forEach(t => t.stop());
    localStream = newStream;
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {});
    setupLocalAnalyser();
    setStatus('Device switched', 'success');
  } catch (e) {
    setStatus('Could not switch device', 'error');
  }
}

// ── Recording ──────────────────────────────────────────────────────────────

function getMimeType() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// Chunked recording — uploads as it records so nothing sits in memory.
let recFilename  = null;
let uploadQueue  = [];
let queueRunning = false;

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  uploadQueue = [];
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  recFilename = `guest-${ts}.webm`;

  try {
    recorder = new MediaRecorder(localStream, {
      mimeType: getMimeType(),
      videoBitsPerSecond: 5_000_000,   // 5 Mbps — YouTube recommended for 1080p/30
      audioBitsPerSecond: 192_000,     // 192 kbps audio
    });
  } catch (e) {
    setStatus('Recording not supported in this browser', 'error');
    isRecording = false;
    return;
  }

  recorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) { uploadQueue.push(e.data); processQueue(); }
  };
  recorder.start(2000);
  setStatus('Recording…', 'recording');
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  isUploading = true;
  showProgress(null); // indeterminate "saving" indicator
  while (uploadQueue.length) {
    const chunk = uploadQueue.shift();
    try {
      await fetch(`/upload-chunk/${roomId}/${encodeURIComponent(recFilename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
    } catch (_) {
      uploadQueue.unshift(chunk);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  queueRunning = false;
  if (!isRecording) { isUploading = false; }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  recorder.onstop = async () => {
    setStatus('Saving…', 'info');
    while (uploadQueue.length || queueRunning) {
      await new Promise(r => setTimeout(r, 200));
    }
    isUploading = false;
    hideProgress();
    setStatus('Upload complete! You can close this tab now.', 'success');
  };
  recorder.stop();
  setStatus('Recording stopped — saving…', 'info');
}

// ── Upload ─────────────────────────────────────────────────────────────────

let isUploading = false;

function uploadFile(blob, filename) {
  return new Promise(resolve => {
    isUploading = true;
    const form = new FormData();
    form.append('file', blob, filename);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload/${roomId}`);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) showProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload  = () => { isUploading = false; showProgress(100); setStatus('Upload complete! You can close this tab now.', 'success'); setTimeout(hideProgress, 4000); resolve(); };
    xhr.onerror = () => { isUploading = false; setStatus('Upload failed', 'error'); hideProgress(); resolve(); };
    showProgress(0);
    xhr.send(form);
  });
}

// Warn the guest if they try to close while their recording is still uploading
window.addEventListener('beforeunload', e => {
  if (isUploading) {
    e.preventDefault();
    e.returnValue = 'Your recording is still uploading. Leaving now will lose it.';
    return e.returnValue;
  }
});

function showProgress(pct) {
  document.getElementById('uploadProgress').style.display = 'block';
  const label = document.querySelector('#uploadProgress .progress-label');
  if (pct === null) {
    // Indeterminate "saving as you record" state
    if (label) label.textContent = 'Saving recording…';
    document.getElementById('progressBar').style.width = '100%';
    document.getElementById('progressPct').textContent = '•••';
  } else {
    if (label) label.textContent = 'Uploading your recording…';
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressPct').textContent = pct + '%';
  }
}
function hideProgress() { document.getElementById('uploadProgress').style.display = 'none'; }

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

// ── Wiring ─────────────────────────────────────────────────────────────────

document.getElementById('micBtn').addEventListener('click', () => {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('micBtn');
  btn.classList.toggle('muted', isMuted);
  btn.innerHTML = isMuted
    ? '<span class="ctrl-icon">🔇</span> Unmute Mic'
    : '<span class="ctrl-icon">🎙️</span> Mute Mic';
});

document.getElementById('camBtn').addEventListener('click', () => {
  isCamOff = !isCamOff;
  localStream?.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById('camBtn');
  btn.classList.toggle('cam-off', isCamOff);
  btn.innerHTML = isCamOff
    ? '<span class="ctrl-icon">📷</span> Show Cam'
    : '<span class="ctrl-icon">📷</span> Hide Cam';
});

document.getElementById('cameraSelect').addEventListener('change', switchDevices);
document.getElementById('micSelect').addEventListener('change', switchDevices);
navigator.mediaDevices.addEventListener('devicechange', populateDevices);
setInterval(updateMicMeter, 80);

init();
