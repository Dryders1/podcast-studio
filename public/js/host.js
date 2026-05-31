'use strict';

const CANVAS_W  = 1280;
const CANVAS_H  = 720;
const BANNER_H  = 52;    // height of podcast name banner at top
const LERP      = 0.10;

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

const roomId       = new URLSearchParams(location.search).get('room');
let socket         = null;
let pc             = null;
let localStream    = null;
let remoteStream   = null;
let screenStream   = null;
let mediaStream    = null;
let imageStream    = null;   // captureStream from offscreen canvas (image share)
let contentImage   = null;   // HTMLImageElement for drawing image locally
let contentType    = null;   // 'screen' | 'video' | 'image'
let currentLayout  = LAYOUT.SPLIT;
let isRecording    = false;
let recorder       = null;
let chunks         = [];
let isMuted        = false;
let isCamOff       = false;
let guestConnected = false;

// ── Speaker detection state ────────────────────────────────────────────────
let audioCtx       = null;
let localAnalyser  = null;
let remoteAnalyser = null;
let detectionMode  = 'off';   // 'off' | 'auto' | 'subtle'
let autoDetecting  = false;   // true when detection is active
let activeSpeaker  = null;    // 'local' | 'remote' | null
let speakTimer     = null;    // delay before switching
let holdTimer      = null;    // hold after speaker stops

// ── DOM ────────────────────────────────────────────────────────────────────

const canvas  = document.getElementById('studioCanvas');
const ctx     = canvas.getContext('2d');
canvas.width  = CANVAS_W;
canvas.height = CANVAS_H;

const localVid  = makeVid(true);
const remoteVid = makeVid(false);
const screenVid = makeVid(true);
const mediaVid  = makeVid(false);

function makeVid(muted) {
  const v = document.createElement('video');
  v.autoplay = v.playsInline = true;
  v.muted = muted;
  return v;
}

// ── Animated panel system ──────────────────────────────────────────────────
// Each panel tracks current and target rect, lerped every frame.
// Panels slide smoothly between layouts giving a fluid, modern feel.

function makePanel(x, y, w, h, alpha = 1) {
  return { cX:x, cY:y, cW:w, cH:h, cA:alpha, tX:x, tY:y, tW:w, tH:h, tA:alpha };
}

const W2  = CANVAS_W / 2;
const W3  = CANVAS_W / 3;
const W23 = CANVAS_W * 2 / 3;
const VH  = CANVAS_H - BANNER_H;   // video area height (below banner)
const H2  = VH / 2;

// Initial state: SPLIT layout — panels start below the banner
const panels = {
  local:   makePanel(0,          BANNER_H, W2,  VH, 1),
  remote:  makePanel(W2,         BANNER_H, W2,  VH, 1),
  content: makePanel(CANVAS_W,   BANNER_H, W23, VH, 0),
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

// Layout definitions — where each panel lives per layout
function applyLayoutTargets(layout) {
  const PIP_W = 300, PIP_H = 169, PAD = 16;
  const BY = BANNER_H;                        // banner y offset
  const BH = VH;                              // video height below banner
  switch (layout) {
    case LAYOUT.SPLIT:
      target(panels.local,   0,                       BY,              W2,       BH,  1);
      target(panels.remote,  W2,                      BY,              W2,       BH,  1);
      target(panels.content, CANVAS_W,                BY,              W23,      BH,  0);
      break;

    case LAYOUT.HOST_MAIN:
      target(panels.local,   0,                       BY,              CANVAS_W, BH,  1);
      target(panels.remote,  CANVAS_W - PIP_W - PAD,  CANVAS_H - PIP_H - PAD, PIP_W, PIP_H, 1);
      target(panels.content, CANVAS_W,                BY,              W23,      BH,  0);
      break;

    case LAYOUT.GUEST_MAIN:
      target(panels.remote,  0,                       BY,              CANVAS_W, BH,  1);
      target(panels.local,   CANVAS_W - PIP_W - PAD,  CANVAS_H - PIP_H - PAD, PIP_W, PIP_H, 1);
      target(panels.content, CANVAS_W,                BY,              W23,      BH,  0);
      break;

    case LAYOUT.SCREEN:
      target(panels.content, 0,                       BY,              CANVAS_W, BH,  1);
      target(panels.remote,  CANVAS_W - PIP_W - PAD,  CANVAS_H - PIP_H - PAD, PIP_W, PIP_H, 1);
      target(panels.local,   CANVAS_W,                BY,              W2,       BH,  0);
      break;

    case LAYOUT.MEDIA:
      target(panels.content, 0,    BY,       W23, BH,  1);
      target(panels.local,   W23,  BY,       W3,  H2,  1);
      target(panels.remote,  W23,  BY + H2,  W3,  H2,  1);
      break;
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  if (!roomId) { setStatus('No room ID in URL', 'error'); return; }

  document.getElementById('roomCode').textContent = roomId;
  document.getElementById('inviteLink').value = `${location.origin}/guest.html?room=${roomId}`;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {});
    setupLocalAnalyser();
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
    remoteStream = null;
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
    setupRemoteAnalyser();
    setStatus('Connected — ready to record', 'success');
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

  const hasLocal   = localStream  && localVid.readyState   >= 2;
  const hasRemote  = remoteStream && remoteVid.readyState  >= 2;
  const hasScreen  = screenStream && screenVid.readyState  >= 2;
  const hasMedia   = mediaStream  && mediaVid.readyState   >= 2;

  // Determine what the content panel shows
  const contentVid = contentType === 'video'  ? (hasMedia  ? mediaVid  : null)
                   : contentType === 'screen' ? (hasScreen ? screenVid : null)
                   : null;

  // Draw bottom-up: content first, then cameras on top
  if (contentType === 'image' && contentImage) {
    drawImagePanel(panels.content);
  } else {
    drawPanel(contentVid, panels.content, 'Content');
  }
  drawPanel(hasRemote ? remoteVid : null, panels.remote, 'Guest');
  drawPanel(hasLocal  ? localVid  : null, panels.local,  'You');

  // Divider line for SPLIT layout (fades with panels)
  if (currentLayout === LAYOUT.SPLIT) {
    const alpha = Math.min(panels.local.cA, panels.remote.cA);
    ctx.fillStyle = `rgba(255,255,255,${0.08 * alpha})`;
    ctx.fillRect(panels.local.cX + panels.local.cW - 1, 0, 2, CANVAS_H);
  }

  // Thin border between media panel and camera column
  if (currentLayout === LAYOUT.MEDIA && panels.content.cA > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${0.06 * panels.content.cA})`;
    ctx.fillRect(panels.content.cX + panels.content.cW - 1, 0, 2, CANVAS_H);
    ctx.fillRect(panels.local.cX, panels.local.cY + panels.local.cH - 1, panels.local.cW, 2);
  }

  drawBanner();
  if (isRecording) drawRecBadge();

  requestAnimationFrame(renderLoop);
}

function drawBanner() {
  const name    = document.getElementById('podcastName').value.trim()  || 'Podcast Studio';
  const episode = document.getElementById('episodeTitle').value.trim() || '';
  const colour  = document.getElementById('brandColour').value;

  // Background bar
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, CANVAS_W, BANNER_H);

  // Subtle gradient overlay for depth
  const grad = ctx.createLinearGradient(0, 0, 0, BANNER_H);
  grad.addColorStop(0, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, BANNER_H);

  // Mic icon
  ctx.font = 'bold 22px system-ui';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText('🎙️', 18, BANNER_H / 2);

  // Podcast name
  ctx.font = 'bold 22px system-ui';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(name, 52, BANNER_H / 2);

  // Episode title (right aligned)
  if (episode) {
    ctx.font = '15px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'right';
    ctx.fillText(episode, CANVAS_W - 20, BANNER_H / 2);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawPanel(video, panel, label) {
  const { cX: x, cY: y, cW: w, cH: h, cA: a } = panel;
  if (w < 2 || h < 2 || a < 0.02) return;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, a));

  if (!video || (video.videoWidth === 0)) {
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

function drawImagePanel(panel) {
  const { cX: x, cY: y, cW: w, cH: h, cA: a } = panel;
  if (w < 2 || h < 2 || a < 0.02) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  const scale = Math.min(w / contentImage.naturalWidth, h / contentImage.naturalHeight);
  const iw = contentImage.naturalWidth  * scale;
  const ih = contentImage.naturalHeight * scale;
  ctx.drawImage(contentImage, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  ctx.restore();
}

// ── Speaker detection ──────────────────────────────────────────────────────

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function setupLocalAnalyser() {
  try {
    const ctx = getAudioCtx();
    localAnalyser = ctx.createAnalyser();
    localAnalyser.fftSize = 256;
    ctx.createMediaStreamSource(localStream).connect(localAnalyser);
  } catch (_) {}
}

function setupRemoteAnalyser() {
  try {
    const ctx = getAudioCtx();
    remoteAnalyser = ctx.createAnalyser();
    remoteAnalyser.fftSize = 256;
    ctx.createMediaStreamSource(remoteStream).connect(remoteAnalyser);
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

function getSwitchDelay() {
  const s = parseInt(document.getElementById('sensitivity').value);
  return 2500 - (s / 100) * 2000; // 2500ms (slow) → 500ms (fast)
}

function runSpeakerDetection() {
  if (!autoDetecting || detectionMode === 'off') return;

  const localLevel  = getRMS(localAnalyser);
  const remoteLevel = getRMS(remoteAnalyser);
  const THRESHOLD   = 0.012;

  const localTalking  = localLevel  > THRESHOLD;
  const remoteTalking = remoteLevel > THRESHOLD;

  let dominant = null;
  if (localTalking && !remoteTalking)  dominant = 'local';
  else if (remoteTalking && !localTalking) dominant = 'remote';
  else if (localTalking && remoteTalking)  dominant = localLevel >= remoteLevel ? 'local' : 'remote';

  if (detectionMode === 'subtle') {
    applySubtleSplit(localLevel, remoteLevel);
    return;
  }

  // Auto cut mode
  if (dominant && dominant !== activeSpeaker) {
    clearTimeout(speakTimer);
    speakTimer = setTimeout(() => {
      clearTimeout(holdTimer);
      activeSpeaker = dominant;
      applyAutoSpeakerLayout(dominant);
    }, getSwitchDelay());
  } else if (!dominant && activeSpeaker) {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      activeSpeaker = null;
      // Return to split
      target(panels.local,   0,   BANNER_H, W2,       VH, 1);
      target(panels.remote,  W2,  BANNER_H, W2,       VH, 1);
      target(panels.content, CANVAS_W, BANNER_H, W23, VH, 0);
    }, 2000);
  }
}

function applyAutoSpeakerLayout(speaker) {
  if (speaker === 'local') {
    // Host full screen
    target(panels.local,   0,        BANNER_H, CANVAS_W, VH, 1);
    target(panels.remote,  CANVAS_W, BANNER_H, W2,       VH, 0);
  } else {
    // Guest full screen
    target(panels.remote,  0,        BANNER_H, CANVAS_W, VH, 1);
    target(panels.local,   CANVAS_W, BANNER_H, W2,       VH, 0);
  }
  target(panels.content, CANVAS_W, BANNER_H, W23, VH, 0);
}

function applySubtleSplit(localLevel, remoteLevel) {
  const total = localLevel + remoteLevel;
  let localRatio = 0.5;
  if (total > 0.005) {
    localRatio = Math.max(0.33, Math.min(0.67, localLevel / total));
  }
  const localW = Math.round(CANVAS_W * localRatio);
  target(panels.local,   0,      BANNER_H, localW,           VH, 1);
  target(panels.remote,  localW, BANNER_H, CANVAS_W - localW, VH, 1);
  target(panels.content, CANVAS_W, BANNER_H, W23, VH, 0);
}

// ── Layout ─────────────────────────────────────────────────────────────────

function setLayout(layout) {
  currentLayout = layout;
  applyLayoutTargets(layout);
  socket.emit('layout-change', { roomId, layout });
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === layout);
  });
  // Pause auto detection for manual layouts, resume for split
  autoDetecting = detectionMode !== 'off' && layout === LAYOUT.SPLIT;
  if (!autoDetecting) { clearTimeout(speakTimer); clearTimeout(holdTimer); activeSpeaker = null; }
}

// ── Content share (screen / video / image) ─────────────────────────────────

function showContentMenu() {
  const menu = document.getElementById('contentMenu');
  menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
}

function hideContentMenu() {
  document.getElementById('contentMenu').style.display = 'none';
}

function setShareActive(active) {
  const btn = document.getElementById('shareContentBtn');
  btn.classList.toggle('sharing', active);
  btn.innerHTML = active
    ? '<span class="ctrl-icon">📤</span> Stop Sharing'
    : '<span class="ctrl-icon">📤</span> Share Content';
}

function restoreCameraTrack() {
  if (pc && localStream) {
    const track  = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender && track) sender.replaceTrack(track);
  }
}

function stopContentShare() {
  if (contentType === 'screen') {
    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
    screenVid.srcObject = null;
    socket.emit('screen-share-change', { roomId, active: false });
  } else if (contentType === 'video') {
    mediaVid.pause();
    mediaVid.src = '';
    mediaStream = null;
    document.getElementById('mediaControls').style.display = 'none';
    socket.emit('media-share-change', { roomId, active: false });
  } else if (contentType === 'image') {
    imageStream?.getTracks().forEach(t => t.stop());
    imageStream = null;
    contentImage = null;
    socket.emit('media-share-change', { roomId, active: false });
  }
  contentType = null;
  restoreCameraTrack();
  setShareActive(false);
  setLayout(LAYOUT.SPLIT);
}

// Screen / window / tab
async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenVid.srcObject = screenStream;
    await screenVid.play().catch(() => {});

    const track  = screenStream.getVideoTracks()[0];
    const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
    if (sender && track) sender.replaceTrack(track);

    track.addEventListener('ended', stopContentShare);
    contentType = 'screen';
    socket.emit('screen-share-change', { roomId, active: true });
    setLayout(LAYOUT.SCREEN);
    setShareActive(true);
  } catch (e) {
    if (e.name !== 'NotAllowedError') setStatus('Screen share failed: ' + e.message, 'error');
  }
}

// Video file
function startVideoShare(file) {
  mediaVid.src = URL.createObjectURL(file);
  mediaVid.loop = false;

  mediaVid.addEventListener('loadedmetadata', () => {
    mediaStream = mediaVid.captureStream
      ? mediaVid.captureStream()
      : mediaVid.mozCaptureStream();

    const track  = mediaStream.getVideoTracks()[0];
    const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
    if (sender && track) sender.replaceTrack(track);

    mediaVid.play();
    contentType = 'video';
    socket.emit('media-share-change', { roomId, active: true });
    setLayout(LAYOUT.MEDIA);
    setShareActive(true);
    document.getElementById('mediaControls').style.display = 'flex';
    updateMediaTime();
  }, { once: true });

  mediaVid.addEventListener('timeupdate', updateMediaTime);
  mediaVid.addEventListener('ended', stopContentShare);
}

function updateMediaTime() {
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  document.getElementById('mediaTime').textContent =
    `${fmt(mediaVid.currentTime)} / ${fmt(mediaVid.duration || 0)}`;
  const pct = mediaVid.duration ? (mediaVid.currentTime / mediaVid.duration) * 100 : 0;
  document.getElementById('mediaScrubber').value = pct;
}

// Image / photo
function startImageShare(file) {
  const img = new Image();
  img.onload = () => {
    contentImage = img;

    // Create an offscreen canvas to stream to the guest via WebRTC
    const offscreen = document.createElement('canvas');
    offscreen.width  = 1920;
    offscreen.height = 1080;
    const oc = offscreen.getContext('2d');
    oc.fillStyle = '#000';
    oc.fillRect(0, 0, 1920, 1080);
    const scale = Math.min(1920 / img.naturalWidth, 1080 / img.naturalHeight);
    const iw = img.naturalWidth  * scale;
    const ih = img.naturalHeight * scale;
    oc.drawImage(img, (1920 - iw) / 2, (1080 - ih) / 2, iw, ih);

    imageStream = offscreen.captureStream(1);
    const track  = imageStream.getVideoTracks()[0];
    const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
    if (sender && track) sender.replaceTrack(track);

    contentType = 'image';
    socket.emit('media-share-change', { roomId, active: true });
    setLayout(LAYOUT.MEDIA);
    setShareActive(true);
  };
  img.src = URL.createObjectURL(file);
}

// ── Recording ──────────────────────────────────────────────────────────────

function getMimeType() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  chunks = [];
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
  return new Promise(resolve => {
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
    xhr.onerror = () => { setStatus('Upload failed', 'error'); hideProgress(); resolve(); };
    showProgress(0);
    xhr.send(form);
  });
}

function showProgress(pct) {
  document.getElementById('uploadProgress').style.display = 'block';
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';
}
function hideProgress() { document.getElementById('uploadProgress').style.display = 'none'; }

async function loadFiles() {
  try {
    const files = await fetch(`/room/${roomId}/files`).then(r => r.json());
    const list  = document.getElementById('fileList');
    if (!files.length) { list.innerHTML = '<p class="empty-state">No recordings yet</p>'; return; }
    list.innerHTML = files.map(f => `
      <div class="file-item">
        <span class="file-name">${f.name}</span>
        <span class="file-size">${fmtBytes(f.size)}</span>
        <a href="${f.url}" download class="file-dl">↓</a>
      </div>`).join('');
  } catch (_) {}
}

function fmtBytes(b) {
  return b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

function updateGuestStatus(connected) {
  const el = document.getElementById('guestStatus');
  el.textContent = connected ? '🟢 Guest connected' : '⚪ No guest yet';
  el.className = 'guest-status' + (connected ? ' connected' : '');
}

async function copyLink() {
  await navigator.clipboard.writeText(document.getElementById('inviteLink').value).catch(() => {});
  const btn = document.getElementById('copyBtn');
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

document.getElementById('recordBtn').addEventListener('click', () => {
  isRecording ? stopRecording() : startRecording();
});

// Share Content menu
document.getElementById('shareContentBtn').addEventListener('click', () => {
  if (contentType) { stopContentShare(); return; }
  showContentMenu();
});

document.getElementById('shareScreenOpt').addEventListener('click', () => {
  hideContentMenu();
  startScreenShare();
});

document.getElementById('shareVideoOpt').addEventListener('click', () => {
  hideContentMenu();
  document.getElementById('mediaFileInput').click();
});

document.getElementById('shareImageOpt').addEventListener('click', () => {
  hideContentMenu();
  document.getElementById('imageFileInput').click();
});

document.getElementById('mediaFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) startVideoShare(file);
  e.target.value = '';
});

document.getElementById('imageFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) startImageShare(file);
  e.target.value = '';
});

document.getElementById('mediaPlayBtn').addEventListener('click', () => {
  if (mediaVid.paused) {
    mediaVid.play();
    document.getElementById('mediaPlayBtn').textContent = '⏸ Pause';
  } else {
    mediaVid.pause();
    document.getElementById('mediaPlayBtn').textContent = '▶ Play';
  }
});

document.getElementById('contentStopBtn').addEventListener('click', stopContentShare);

document.getElementById('mediaScrubber').addEventListener('input', e => {
  if (mediaVid.duration) {
    mediaVid.currentTime = (e.target.value / 100) * mediaVid.duration;
  }
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

// Speaker detection controls
document.querySelectorAll('input[name="detection"]').forEach(radio => {
  radio.addEventListener('change', () => {
    detectionMode = radio.value;
    const wrap = document.getElementById('sensitivityWrap');
    wrap.style.display = detectionMode === 'off' ? 'none' : 'block';
    autoDetecting = detectionMode !== 'off' && currentLayout === LAYOUT.SPLIT;
    activeSpeaker = null;
    clearTimeout(speakTimer);
    clearTimeout(holdTimer);
    // Reset to split if auto was running
    if (detectionMode === 'off') applyLayoutTargets(LAYOUT.SPLIT);
  });
});

// Run detection 10x per second
setInterval(runSpeakerDetection, 100);

setInterval(loadFiles, 15000);
init();
