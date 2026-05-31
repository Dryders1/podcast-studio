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

const roomId      = new URLSearchParams(location.search).get('room');
let socket        = null;
let pc            = null;
let localStream   = null;
let remoteStream  = null;   // host's video (camera or screen)
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

const localVid  = makeVideoEl(true);
const remoteVid = makeVideoEl(false);

function makeVideoEl(muted) {
  const v = document.createElement('video');
  v.autoplay    = true;
  v.playsInline = true;
  v.muted       = muted;
  return v;
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  if (!roomId) { setStatus('No room code in URL', 'error'); return; }

  document.getElementById('roomCode').textContent = roomId;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {});
  } catch (e) {
    setStatus('Camera/mic access denied — check browser permissions', 'error');
    return;
  }

  socket = io();

  socket.on('joined', () => setStatus('Joined room — waiting for host…', 'info'));

  socket.on('error', msg => setStatus('Error: ' + msg, 'error'));

  // Host sends an offer once we join
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

  // Layout driven entirely by host
  socket.on('layout-change', layout => {
    currentLayout = layout;
  });

  // When host switches to/from screen share, just follow the layout change
  socket.on('screen-share-change', active => {
    if (!active && currentLayout === LAYOUT.SCREEN) currentLayout = LAYOUT.SPLIT;
  });

  // Host starts / stops recording — we mirror it
  socket.on('recording-start', startRecording);
  socket.on('recording-stop',  stopRecording);

  socket.on('peer-disconnected', () => {
    setStatus('Host disconnected', 'warning');
    remoteStream = null;
    remoteVid.srcObject = null;
    if (pc) { pc.close(); pc = null; }
    document.getElementById('overlayHint').textContent = 'Host disconnected';
    document.getElementById('overlayHint').classList.remove('hidden');
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
    document.getElementById('overlayHint').classList.add('hidden');
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') setStatus('Connection failed — try refreshing', 'error');
  };
}

// ── Canvas render loop ─────────────────────────────────────────────────────
// Guest sees the same composition as the host:
//   HOST_MAIN  → host (remote) fills, guest (local) in PiP
//   GUEST_MAIN → guest (local) fills, host (remote) in PiP
//   SPLIT      → host left, guest right
//   SCREEN     → host stream (now screen) fills, guest in PiP

function renderLoop() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const hasLocal  = localStream  && localVid.readyState  >= 2;
  const hasRemote = remoteStream && remoteVid.readyState >= 2;

  switch (currentLayout) {
    case LAYOUT.SPLIT:
      drawFit(hasRemote ? remoteVid : null, 0,            0, CANVAS_W / 2, CANVAS_H, 'Host');
      drawFit(hasLocal  ? localVid  : null, CANVAS_W / 2, 0, CANVAS_W / 2, CANVAS_H, 'You');
      drawDivider();
      break;

    case LAYOUT.HOST_MAIN:
      drawFit(hasRemote ? remoteVid : null, 0, 0, CANVAS_W, CANVAS_H, 'Host');
      if (hasLocal) drawPiP(localVid, 'You');
      break;

    case LAYOUT.GUEST_MAIN:
      drawFit(hasLocal  ? localVid  : null, 0, 0, CANVAS_W, CANVAS_H, 'You');
      if (hasRemote) drawPiP(remoteVid, 'Host');
      break;

    case LAYOUT.SCREEN:
      // remoteVid now carries the host's screen share
      drawFit(hasRemote ? remoteVid : null, 0, 0, CANVAS_W, CANVAS_H, 'Screen');
      if (hasLocal) drawPiP(localVid, 'You');
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
  setStatus('Recording…', 'recording');
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: getMimeType() });
    const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await uploadFile(blob, `guest-${ts}.webm`);
  };
  recorder.stop();
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
      setStatus('Upload complete!', 'success');
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
  document.getElementById('uploadProgress').style.display = 'block';
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';
}
function hideProgress() {
  document.getElementById('uploadProgress').style.display = 'none';
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className   = 'status ' + type;
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

init();
