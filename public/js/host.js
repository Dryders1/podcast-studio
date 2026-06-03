'use strict';

const CANVAS_W  = 1280;
const CANVAS_H  = 720;
const BANNER_H  = 52;    // height of podcast name banner at top
const LERP      = 1;   // 1 = instant cut between layouts (no slide animation)

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
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80',               username: 'f7de7dd72c1ab64e2cae90a2', credential: '/lGT+0H5L5zbllWL' },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'f7de7dd72c1ab64e2cae90a2', credential: '/lGT+0H5L5zbllWL' },
    { urls: 'turn:global.relay.metered.ca:443',              username: 'f7de7dd72c1ab64e2cae90a2', credential: '/lGT+0H5L5zbllWL' },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'f7de7dd72c1ab64e2cae90a2', credential: '/lGT+0H5L5zbllWL' },
  ],
};

// ── State ──────────────────────────────────────────────────────────────────

const roomId       = new URLSearchParams(location.search).get('room');
let socket         = null;
let pc             = null;
let localStream    = null;
let remoteStream   = null;
let screenStream   = null;
let contentImage   = null;   // HTMLImageElement for drawing the shared image
let canvasStream   = null;   // the composited "program feed" sent to the guest
let contentType    = null;   // 'screen' | 'video' | 'image'
let currentLayout  = LAYOUT.SPLIT;
let isRecording    = false;
let recorder       = null;
let chunks         = [];
let isMuted        = false;
let isCamOff       = false;
let guestConnected = false;

let pipStyle = 'pip'; // 'pip' | 'full'

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

  // ── While sharing content: content stays the star (2/3 left); the layout
  //    button chooses which face(s) sit in the right column. Content never
  //    disappears until "Stop Sharing".
  if (contentType) {
    target(panels.content, 0, BY, W23, BH, 1);
    if (layout === LAYOUT.HOST_MAIN) {            // content + just you
      target(panels.local,  W23,      BY, W3, BH, 1);
      target(panels.remote, CANVAS_W, BY, W3, BH, 0);
    } else if (layout === LAYOUT.GUEST_MAIN) {    // content + just guest
      target(panels.remote, W23,      BY, W3, BH, 1);
      target(panels.local,  CANVAS_W, BY, W3, BH, 0);
    } else {                                      // content + both faces stacked
      target(panels.local,  W23, BY,        W3, H2, 1);
      target(panels.remote, W23, BY + H2,   W3, H2, 1);
    }
    return;
  }

  switch (layout) {
    case LAYOUT.SPLIT:
      target(panels.local,   0,                       BY,              W2,       BH,  1);
      target(panels.remote,  W2,                      BY,              W2,       BH,  1);
      target(panels.content, CANVAS_W,                BY,              W23,      BH,  0);
      break;

    case LAYOUT.HOST_MAIN:
      if (pipStyle === 'full') {
        target(panels.local,   0,        BY, CANVAS_W, BH,    1);
        target(panels.remote,  CANVAS_W, BY, W2,       BH,    0);
      } else {
        target(panels.local,   0,                      BY,              CANVAS_W, BH,    1);
        target(panels.remote,  CANVAS_W - PIP_W - PAD, CANVAS_H - PIP_H - PAD, PIP_W, PIP_H, 1);
      }
      target(panels.content, CANVAS_W, BY, W23, BH, 0);
      break;

    case LAYOUT.GUEST_MAIN:
      if (pipStyle === 'full') {
        target(panels.remote, 0,        BY, CANVAS_W, BH,    1);
        target(panels.local,  CANVAS_W, BY, W2,       BH,    0);
      } else {
        target(panels.remote, 0,                      BY,              CANVAS_W, BH,    1);
        target(panels.local,  CANVAS_W - PIP_W - PAD, CANVAS_H - PIP_H - PAD, PIP_W, PIP_H, 1);
      }
      target(panels.content, CANVAS_W, BY, W23, BH, 0);
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
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
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

  socket.on('joined', () => setStatus('Waiting for guest…', 'info'));
  socket.on('join-error', msg => setStatus(msg || 'Could not join room', 'error'));

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

  // Send the GUEST the composited canvas (the "program feed") — exactly the
  // picture the host sees — plus the host mic. This means the guest always sees
  // the full composition (content + both faces), in every layout.
  // Both tracks go in ONE stream so the guest receives video + audio together.
  if (!canvasStream) canvasStream = canvas.captureStream(30);
  const programVideo = canvasStream.getVideoTracks()[0];
  const micAudio     = localStream.getAudioTracks()[0];
  const programStream = new MediaStream();
  if (programVideo) programStream.addTrack(programVideo);
  if (micAudio)     programStream.addTrack(micAudio);
  if (programVideo) pc.addTrack(programVideo, programStream);
  if (micAudio)     pc.addTrack(micAudio, programStream);

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

// Cap rendering to ~30fps to halve canvas CPU load on modest machines
const FRAME_MS = 1000 / 30;
let lastFrameTime = 0;

function renderLoop(now) {
  requestAnimationFrame(renderLoop);
  if (now && now - lastFrameTime < FRAME_MS) return;
  lastFrameTime = now || 0;

  stepPanels();

  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const hasLocal   = localStream  && localVid.readyState   >= 2;
  const hasRemote  = remoteStream && remoteVid.readyState  >= 2;
  const hasScreen  = screenStream && screenVid.readyState  >= 2;
  const hasMedia   = mediaVid.readyState >= 2;

  // Determine what the content panel shows
  const contentVid = contentType === 'video'  ? (hasMedia  ? mediaVid  : null)
                   : contentType === 'screen' ? (hasScreen ? screenVid : null)
                   : null;

  // Draw largest panel first so a smaller picture-in-picture lands on top
  const drawList = [
    { isImage: contentType === 'image' && !!contentImage,
      video: contentVid,                  panel: panels.content, label: 'Content' },
    { isImage: false, video: hasRemote ? remoteVid : null, panel: panels.remote, label: 'Guest' },
    { isImage: false, video: hasLocal  ? localVid  : null, panel: panels.local,  label: 'You'   },
  ];
  drawList.sort((a, b) => (b.panel.cW * b.panel.cH) - (a.panel.cW * a.panel.cH));
  for (const d of drawList) {
    if (d.isImage) drawImagePanel(d.panel);
    else           drawPanel(d.video, d.panel, d.label);
  }

  // Centre divider for the camera-only SPLIT layout
  if (currentLayout === LAYOUT.SPLIT && !contentType) {
    const alpha = Math.min(panels.local.cA, panels.remote.cA);
    ctx.fillStyle = `rgba(255,255,255,${0.08 * alpha})`;
    ctx.fillRect(panels.local.cX + panels.local.cW - 1, 0, 2, CANVAS_H);
  }

  // Border between the content panel and the face column (while sharing)
  if (contentType && panels.content.cA > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${0.06 * panels.content.cA})`;
    ctx.fillRect(panels.content.cX + panels.content.cW - 1, 0, 2, CANVAS_H);
  }

  drawBanner();
  if (isRecording) drawRecBadge();
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

// ── Device selection + mic meter ───────────────────────────────────────────

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
      o.value = d.deviceId;
      o.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === curCam) o.selected = true;
      camSel.appendChild(o);
    });

    micSel.innerHTML = '';
    mics.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
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
               width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { deviceId: micId ? { exact: micId } : undefined,
               echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });

    const newA = newStream.getAudioTracks()[0];

    // The camera feeds the canvas (program feed) automatically via localVid, so
    // we only need to swap the MIC track in the peer connection.
    if (pc) {
      const as = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (as && newA) as.replaceTrack(newA);
    }

    // Stop old tracks and adopt the new stream
    localStream.getTracks().forEach(t => t.stop());
    localStream = newStream;
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {});

    setupLocalAnalyser();             // rebuild meter + detection source
    setStatus('Device switched', 'success');
  } catch (e) {
    setStatus('Could not switch device', 'error');
  }
}

function updateMicMeter() {
  const fill = document.getElementById('micMeterFill');
  if (!fill || !localAnalyser) return;
  const level = getRMS(localAnalyser);
  const pct = Math.min(100, Math.round(level * 280));
  fill.style.width = pct + '%';
  fill.classList.toggle('hot', pct > 85);
}

function getSwitchDelay() {
  const s = parseInt(document.getElementById('sensitivity').value);
  return 2500 - (s / 100) * 2000; // 2500ms (slow) → 500ms (fast)
}

function runSpeakerDetection() {
  if (!autoDetecting || detectionMode === 'off' || contentType) return;

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
  // Auto speaker detection runs only in plain Split, never while sharing content
  autoDetecting = detectionMode !== 'off' && layout === LAYOUT.SPLIT && !contentType;
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

// With the program-feed model the host just draws the content into its own
// canvas — the canvas stream carries it to the guest automatically. No more
// track-swapping or offscreen canvases.

function stopContentShare() {
  if (contentType === 'screen') {
    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
    screenVid.srcObject = null;
  } else if (contentType === 'video') {
    mediaVid.pause();
    mediaVid.src = '';
    document.getElementById('mediaControls').style.display = 'none';
  } else if (contentType === 'image') {
    contentImage = null;
  }
  contentType = null;
  setShareActive(false);
  setLayout(LAYOUT.SPLIT);
}

// Screen / window / tab
async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenVid.srcObject = screenStream;
    await screenVid.play().catch(() => {});
    screenStream.getVideoTracks()[0].addEventListener('ended', stopContentShare);
    contentType = 'screen';
    setLayout(LAYOUT.SPLIT);   // content + both faces stacked
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
    mediaVid.play();
    contentType = 'video';
    setLayout(LAYOUT.SPLIT);
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
    contentImage = img;          // drawn directly into the canvas program feed
    contentType = 'image';
    setLayout(LAYOUT.SPLIT);
    setShareActive(true);
  };
  img.src = URL.createObjectURL(file);
}

// ── Recording ──────────────────────────────────────────────────────────────

function getMimeType() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// Chunked recording: each piece is uploaded to the server as it's produced,
// so the full file never sits in browser memory. A crash loses only seconds.
let recFilename    = null;
let uploadQueue    = [];
let queueRunning   = false;

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  uploadQueue = [];
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  recFilename = `host-${ts}.webm`;

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
  recorder.start(2000); // emit a chunk every 2 seconds

  socket.emit('recording-start', { roomId });
  const btn = document.getElementById('recordBtn');
  btn.classList.add('active');
  btn.innerHTML = '<span class="rec-dot"></span> Stop Recording';
  setStatus('Recording…', 'recording');
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  isUploading = true;
  while (uploadQueue.length) {
    const chunk = uploadQueue.shift();
    try {
      await fetch(`/upload-chunk/${roomId}/${encodeURIComponent(recFilename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
    } catch (_) {
      // Re-queue the chunk and pause briefly before retrying
      uploadQueue.unshift(chunk);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  queueRunning = false;
  if (!isRecording) isUploading = false;
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  socket.emit('recording-stop', { roomId });

  recorder.onstop = async () => {
    setStatus('Saving…', 'info');
    // Wait for any remaining chunks to finish uploading
    while (uploadQueue.length || queueRunning) {
      await new Promise(r => setTimeout(r, 200));
    }
    isUploading = false;
    setStatus('Saved — recording uploaded', 'success');
    loadFiles();
  };
  recorder.stop();

  const btn = document.getElementById('recordBtn');
  btn.classList.remove('active');
  btn.innerHTML = '<span class="rec-dot"></span> Start Recording';
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
    xhr.onload = () => {
      isUploading = false;
      showProgress(100);
      setStatus(`Uploaded: ${filename}`, 'success');
      loadFiles();
      setTimeout(hideProgress, 3000);
      resolve();
    };
    xhr.onerror = () => { isUploading = false; setStatus('Upload failed', 'error'); hideProgress(); resolve(); };
    showProgress(0);
    xhr.send(form);
  });
}

// Warn before closing if an upload is still running
window.addEventListener('beforeunload', e => {
  if (isUploading || isRecording) {
    e.preventDefault();
    e.returnValue = 'A recording or upload is still in progress. Leave anyway?';
    return e.returnValue;
  }
});

// Download every recorded file in the room, one after another
async function downloadAll() {
  try {
    const files = await fetch(`/room/${roomId}/files`).then(r => r.json());
    if (!Array.isArray(files) || !files.length) {
      setStatus('No files to download yet', 'warning');
      return;
    }
    for (const f of files) {
      if (typeof f.url !== 'string' || !f.url.startsWith('/download/')) continue;
      const a = document.createElement('a');
      a.href = f.url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Small gap so the browser queues each download
      await new Promise(r => setTimeout(r, 600));
    }
    setStatus('Downloading all recordings…', 'success');
  } catch (_) {
    setStatus('Could not download files', 'error');
  }
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
    list.textContent = '';
    if (!files.length) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No recordings yet';
      list.appendChild(p);
      return;
    }
    // Build safely with textContent so filenames can't inject HTML
    for (const f of files) {
      const item = document.createElement('div');
      item.className = 'file-item';

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.name;

      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = fmtBytes(f.size);

      const dl = document.createElement('a');
      dl.className = 'file-dl';
      dl.download = '';
      dl.textContent = '↓';
      // Only allow our own relative download URLs
      dl.href = typeof f.url === 'string' && f.url.startsWith('/download/') ? f.url : '#';

      item.append(name, size, dl);
      list.appendChild(item);
    }
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
document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);

document.getElementById('cameraSelect').addEventListener('change', switchDevices);
document.getElementById('micSelect').addEventListener('change', switchDevices);
// Refresh the device list if hardware is plugged/unplugged
navigator.mediaDevices.addEventListener('devicechange', populateDevices);
// Live mic level meter
setInterval(updateMicMeter, 80);

document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => setLayout(btn.dataset.layout));
});

// Spotlight style
document.querySelectorAll('input[name="pipStyle"]').forEach(radio => {
  radio.addEventListener('change', () => {
    pipStyle = radio.value;
    if (currentLayout === LAYOUT.HOST_MAIN || currentLayout === LAYOUT.GUEST_MAIN) {
      applyLayoutTargets(currentLayout);
    }
  });
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

// ── Keyboard shortcuts (for Logitech console / hotkeys) ─────────────────────
// Each maps to an existing on-screen control so behaviour stays in sync.
// Map these same keys on your console in Logi Options+.

function clickEl(id) {
  const el = document.getElementById(id);
  if (el) el.click();
}

function clickLayout(layout) {
  const btn = document.querySelector(`.layout-btn[data-layout="${layout}"]`);
  if (btn) btn.click();
}

document.addEventListener('keydown', (e) => {
  // Don't fire while typing in a text field (podcast name, episode, room code)
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case 'r': e.preventDefault(); clickEl('recordBtn');        break; // Record on/off
    case 'm': e.preventDefault(); clickEl('micBtn');           break; // Mute mic
    case 'c': e.preventDefault(); clickEl('camBtn');           break; // Camera on/off
    case 's': e.preventDefault(); clickEl('shareContentBtn');  break; // Share content
    case 'd': e.preventDefault(); clickEl('downloadAllBtn');   break; // Download all
    case '1': e.preventDefault(); clickLayout('split');        break;
    case '2': e.preventDefault(); clickLayout('host-main');    break; // You Main
    case '3': e.preventDefault(); clickLayout('guest-main');   break; // Guest Main
    case '4': e.preventDefault(); clickLayout('screen');       break;
    case ' ': // Space = play/pause a shared video, if one is active
      if (document.getElementById('mediaControls').style.display !== 'none') {
        e.preventDefault();
        clickEl('mediaPlayBtn');
      }
      break;
    case 'arrowleft':  // nudge shared video back 5s
      if (contentType === 'video' && mediaVid.duration) {
        e.preventDefault();
        mediaVid.currentTime = Math.max(0, mediaVid.currentTime - 5);
      }
      break;
    case 'arrowright': // nudge shared video forward 5s
      if (contentType === 'video' && mediaVid.duration) {
        e.preventDefault();
        mediaVid.currentTime = Math.min(mediaVid.duration, mediaVid.currentTime + 5);
      }
      break;
  }
});

// Run detection 10x per second
setInterval(runSpeakerDetection, 100);

setInterval(loadFiles, 15000);
init();
