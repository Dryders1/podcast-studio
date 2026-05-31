'use strict';

const CANVAS_W = 1280;
const CANVAS_H = 720;
const PIP_W    = 300;
const PIP_H    = 169;
const PIP_PAD  = 16;

const LAYOUT = {
  SPLIT:      'split',
  HOST_MAIN:  'host-main',
  GUEST_MAIN: 'guest-main',
  SCREEN:     'screen',
};

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ── State ──────────────────────────────────────────────────────────────────

const roomId       = new URLSearchParams(location.search).get('room');
let socket         = null;
let pc             = null;
let localStream    = null;   // camera + mic
let remoteStream   = null;   // guest camera
let screenStream   = null;   // screen share
let currentLayout  = LAYOUT.SPLIT;
let isRecording    = false;
let recorder       = null;
let chunks         = [];
let isMuted        = false;
let isCamOff       = false;
let guestConnected = false;

// ── DOM ────────────────────────────────────────────────────────────────────

const canvas     = document.getElementById('studioCanvas');
const ctx        = canvas.getContext('2d');
canvas.width     = CANVAS_W;
canvas.height    = CANVAS_H;

const localVid   = makeVideoEl(true);   // muted — we hear ourselves from mic
const remoteVid  = makeVideoEl(false);
const screenVid  = makeVideoEl(true);

function makeVideoEl(muted) {
  const v = document.createElement('video');
  v.autoplay   = true;
  v.playsInline = true;
  v.muted      = muted;
  return v;
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  if (!roomId) { setStatus('No room ID in URL', 'error'); return; }

  document.getElementById('roomCode').textContent = roomId;
  const inviteUrl = `${location.origin}/guest.html?room=${roomId}`;
  document.getElementById('inviteLink').value = inviteUrl;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {});
  } catch (e) {
    setStatus('Camera/mic access denied — check browser permissions', 'error');
    return;
  }

  socket = io();

  socket.on('joined', () => setStatus('Waiting for guest…', 'info'));

  socket.on('peer-joined', async () => {
    guestConnected = true;
    updateGuestStatus(true);
    setStatus('Guest joined — connecting…', 'info');
    await buildPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { roomId, data: { type: 'offer', sdp: offer } });
  });

  socket.on('signal', async (data) => {
    if (!pc) await buildPeerConnection();
    if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'candidate' && data.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  });

  socket.on('peer-disconnected', () => {
    guestConnected = false;
    remoteStream   = null;
    remoteVid.srcObject = null;
    updateGuestStatus(false);
    setStatus('Guest disconnected', 'warning');
    if (pc) { pc.close(); pc = null; }
  });

  socket.emit('join-room', { roomId, role: 'host' });

  renderLoop();
  loadFiles();
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
    setStatus('Connected — ready to record', 'success');
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') setStatus('Connection failed — try refreshing', 'error');
  };
}

// ── Canvas render loop ─────────────────────────────────────────────────────

function renderLoop() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const hasLocal  = localStream  && localVid.readyState  >= 2;
  const hasRemote = remoteStream && remoteVid.readyState >= 2;
  const hasScreen = screenStream && screenVid.readyState >= 2;

  switch (currentLayout) {
    case LAYOUT.SPLIT:
      drawFit(hasLocal  ? localVid  : null, 0,            0, CANVAS_W / 2, CANVAS_H, 'You');
      drawFit(hasRemote ? remoteVid : null, CANVAS_W / 2, 0, CANVAS_W / 2, CANVAS_H, 'Guest');
      drawDivider();
      break;

    case LAYOUT.HOST_MAIN:
      drawFit(hasLocal  ? localVid  : null, 0, 0, CANVAS_W, CANVAS_H, 'You');
      if (hasRemote) drawPiP(remoteVid, 'Guest');
      break;

    case LAYOUT.GUEST_MAIN:
      drawFit(hasRemote ? remoteVid : null, 0, 0, CANVAS_W, CANVAS_H, 'Guest');
      if (hasLocal) drawPiP(localVid, 'You');
      break;

    case LAYOUT.SCREEN:
      drawFit(hasScreen ? screenVid : null, 0, 0, CANVAS_W, CANVAS_H, 'Screen');
      if (hasRemote) drawPiP(remoteVid, 'Guest');
      break;
  }

  if (isRecording) drawRecBadge();

  requestAnimationFrame(renderLoop);
}

function drawFit(video, x, y, w, h, label) {
  if (!video) {
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#444';
    ctx.font = '15px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return;
  }
  // Centre-crop to fill the target rect
  const vW = video.videoWidth  || 1;
  const vH = video.videoHeight || 1;
  const vR = vW / vH;
  const tR = w  / h;
  let sx, sy, sw, sh;
  if (vR > tR) {
    sh = vH; sw = vH * tR;
    sx = (vW - sw) / 2; sy = 0;
  } else {
    sw = vW; sh = vW / tR;
    sx = 0; sy = (vH - sh) / 2;
  }
  ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
}

function drawPiP(video, label) {
  const x = CANVAS_W - PIP_W - PIP_PAD;
  const y = CANVAS_H - PIP_H - PIP_PAD;
  // Shadow / border
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 12;
  ctx.fillStyle   = '#000';
  ctx.fillRect(x - 2, y - 2, PIP_W + 4, PIP_H + 4);
  ctx.restore();
  drawFit(video, x, y, PIP_W, PIP_H, label);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(x, y, PIP_W, PIP_H);
}

function drawDivider() {
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(CANVAS_W / 2 - 1, 0, 2, CANVAS_H);
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

// ── Screen share ───────────────────────────────────────────────────────────

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenVid.srcObject = screenStream;
    await screenVid.play().catch(() => {});

    if (pc) {
      const track  = screenStream.getVideoTracks()[0];
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(track);
    }

    screenStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);
    socket.emit('screen-share-change', { roomId, active: true });
    setLayout(LAYOUT.SCREEN);
    document.getElementById('screenBtn').classList.add('sharing');
    document.getElementById('screenBtn').querySelector('.ctrl-icon').textContent = '🖥️';
    document.getElementById('screenBtn').lastChild.textContent = ' Stop Sharing';
  } catch (e) {
    if (e.name !== 'NotAllowedError') setStatus('Screen share failed: ' + e.message, 'error');
  }
}

function stopScreenShare() {
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;
  screenVid.srcObject = null;

  if (pc && localStream) {
    const track  = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender && track) sender.replaceTrack(track);
  }

  socket.emit('screen-share-change', { roomId, active: false });
  setLayout(LAYOUT.SPLIT);
  const btn = document.getElementById('screenBtn');
  btn.classList.remove('sharing');
  btn.innerHTML = '<span class="ctrl-icon">🖥️</span> Share Screen';
}

// ── Layout ─────────────────────────────────────────────────────────────────

function setLayout(layout) {
  currentLayout = layout;
  socket.emit('layout-change', { roomId, layout });
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === layout);
  });
}

// ── Recording ──────────────────────────────────────────────────────────────

function getMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  chunks = [];

  try {
    recorder = new MediaRecorder(localStream, { mimeType: getMimeType() });
  } catch (e) {
    setStatus('Recording not supported in this browser', 'error');
    isRecording = false;
    return;
  }

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start(1000);

  socket.emit('recording-start', { roomId });
  const btn = document.getElementById('recordBtn');
  btn.classList.add('active');
  btn.innerHTML = '<span class="rec-dot"></span> Stop Recording';
  setStatus('Recording…', 'recording');
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  socket.emit('recording-stop', { roomId });

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: getMimeType() });
    const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await uploadFile(blob, `host-${ts}.webm`);
  };
  recorder.stop();

  const btn = document.getElementById('recordBtn');
  btn.classList.remove('active');
  btn.innerHTML = '<span class="rec-dot"></span> Start Recording';
  setStatus('Recording stopped — uploading…', 'info');
}

// ── Upload ─────────────────────────────────────────────────────────────────

function uploadFile(blob, filename) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('file', blob, filename);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload/${roomId}`);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) showProgress(Math.round(e.loaded / e.total * 100));
    };

    xhr.onload = () => {
      showProgress(100);
      setStatus(`Uploaded: ${filename}`, 'success');
      loadFiles();
      setTimeout(hideProgress, 3000);
      resolve();
    };

    xhr.onerror = () => {
      setStatus('Upload failed', 'error');
      hideProgress();
      resolve();
    };

    showProgress(0);
    xhr.send(form);
  });
}

function showProgress(pct) {
  const el = document.getElementById('uploadProgress');
  el.style.display = 'block';
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';
}
function hideProgress() {
  document.getElementById('uploadProgress').style.display = 'none';
}

// ── File list ──────────────────────────────────────────────────────────────

async function loadFiles() {
  try {
    const res   = await fetch(`/room/${roomId}/files`);
    const files = await res.json();
    const list  = document.getElementById('fileList');

    if (!files.length) {
      list.innerHTML = '<p class="empty-state">No recordings yet</p>';
      return;
    }

    list.innerHTML = files.map(f => `
      <div class="file-item">
        <span class="file-name">${f.name}</span>
        <span class="file-size">${fmtBytes(f.size)}</span>
        <a href="${f.url}" download class="file-dl">↓</a>
      </div>
    `).join('');
  } catch (_) { /* server may not be reachable yet */ }
}

function fmtBytes(b) {
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className   = 'status ' + type;
}

function updateGuestStatus(connected) {
  const el = document.getElementById('guestStatus');
  el.textContent  = connected ? '🟢 Guest connected' : '⚪ No guest yet';
  el.className    = 'guest-status' + (connected ? ' connected' : '');
}

async function copyLink() {
  const link = document.getElementById('inviteLink').value;
  await navigator.clipboard.writeText(link).catch(() => {});
  const btn = document.getElementById('copyBtn');
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

document.getElementById('recordBtn').addEventListener('click', () => {
  isRecording ? stopRecording() : startRecording();
});

document.getElementById('screenBtn').addEventListener('click', () => {
  screenStream ? stopScreenShare() : startScreenShare();
});

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

document.getElementById('copyBtn').addEventListener('click', copyLink);

document.getElementById('refreshBtn').addEventListener('click', loadFiles);

document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => setLayout(btn.dataset.layout));
});

// Refresh file list every 15 seconds in case guest uploads arrive
setInterval(loadFiles, 15000);

init();
