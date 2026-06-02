const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// In-memory room registry
const rooms = {};
const ROOM_TTL = 24 * 60 * 60 * 1000; // rooms expire after 24 hours

// ── Validation helpers ──────────────────────────────────────────────────────

// Room IDs are exactly 8 uppercase hex characters
const ROOM_ID_RE = /^[0-9A-F]{8}$/;

function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_RE.test(id);
}

function roomExists(id) {
  return isValidRoomId(id) && Object.prototype.hasOwnProperty.call(rooms, id);
}

// Strip any directory components from an uploaded filename and keep it safe
function safeFilename(name) {
  const base = path.basename(String(name || ''));         // remove path parts
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');   // allowlist chars
  return cleaned.slice(0, 120) || 'recording.webm';
}

// Confirm a resolved path stays inside the uploads directory
function isInsideUploads(resolved) {
  const root = path.resolve(uploadsDir) + path.sep;
  return path.resolve(resolved).startsWith(root);
}

// ── REST: room management ──────────────────────────────────────────────────

app.post('/room/create', (req, res) => {
  const roomId = uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  rooms[roomId] = { created: Date.now() };
  res.json({ roomId });
});

// ── REST: file handling ────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!roomExists(req.params.roomId)) {
      return cb(new Error('Invalid room'));
    }
    const dir = path.join(uploadsDir, req.params.roomId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
});

// Only accept webm audio/video recordings
function fileFilter(req, file, cb) {
  const okMime = /^(video|audio)\/webm$/.test(file.mimetype);
  const okExt  = /\.webm$/i.test(file.originalname || '');
  if (okMime && okExt) return cb(null, true);
  cb(new Error('Only .webm recordings are allowed'));
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB max per file
    files: 1,
  },
});

app.post('/upload/:roomId', (req, res) => {
  if (!roomExists(req.params.roomId)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ success: true, filename: req.file.filename });
  });
});

// Chunked/progressive upload — appends each chunk to the file as it arrives,
// so a full recording never has to sit in browser memory. Much safer for long
// sessions and weaker machines.
app.post('/upload-chunk/:roomId/:filename',
  express.raw({ type: () => true, limit: '50mb' }),
  (req, res) => {
    if (!roomExists(req.params.roomId)) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const safeName = safeFilename(req.params.filename);
    if (!/\.webm$/i.test(safeName)) {
      return res.status(400).json({ error: 'Only .webm recordings are allowed' });
    }
    const dir = path.join(uploadsDir, req.params.roomId);
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, safeName);
    if (!isInsideUploads(fp)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty chunk' });
    }
    try {
      fs.appendFileSync(fp, req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Write failed' });
    }
  }
);

app.get('/room/:roomId/files', (req, res) => {
  if (!roomExists(req.params.roomId)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  const dir = path.join(uploadsDir, req.params.roomId);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).map(name => ({
    name,
    size: fs.statSync(path.join(dir, name)).size,
    url: `/download/${req.params.roomId}/${encodeURIComponent(name)}`,
  }));
  res.json(files);
});

app.get('/download/:roomId/:filename', (req, res) => {
  if (!roomExists(req.params.roomId)) {
    return res.status(404).send('Room not found');
  }
  const safeName = safeFilename(req.params.filename);
  const fp = path.join(uploadsDir, req.params.roomId, safeName);

  // Defence in depth: ensure the resolved path is inside uploads
  if (!isInsideUploads(fp) || !fs.existsSync(fp)) {
    return res.status(404).send('File not found');
  }
  res.download(fp);
});

// ── Socket.io signaling ────────────────────────────────────────────────────

const VALID_ROLES   = new Set(['host', 'guest']);
const VALID_LAYOUTS = new Set(['split', 'host-main', 'guest-main', 'screen', 'media']);

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentRole = null;

  socket.on('join-room', ({ roomId, role } = {}) => {
    if (!roomExists(roomId) || !VALID_ROLES.has(role)) {
      socket.emit('join-error', 'Invalid or expired room');
      return;
    }
    socket.join(roomId);
    currentRoom = roomId;
    currentRole = role;
    socket.emit('joined', { roomId });
    socket.to(roomId).emit('peer-joined', { role });
  });

  // Only relay events for the room this socket actually joined
  function inRoom(roomId) {
    return currentRoom && roomId === currentRoom;
  }

  socket.on('signal', ({ roomId, data } = {}) => {
    if (inRoom(roomId)) socket.to(roomId).emit('signal', data);
  });

  socket.on('layout-change', ({ roomId, layout } = {}) => {
    if (inRoom(roomId) && VALID_LAYOUTS.has(layout)) {
      socket.to(roomId).emit('layout-change', layout);
    }
  });

  socket.on('recording-start', ({ roomId } = {}) => {
    if (inRoom(roomId)) socket.to(roomId).emit('recording-start');
  });

  socket.on('recording-stop', ({ roomId } = {}) => {
    if (inRoom(roomId)) socket.to(roomId).emit('recording-stop');
  });

  socket.on('screen-share-change', ({ roomId, active } = {}) => {
    if (inRoom(roomId)) socket.to(roomId).emit('screen-share-change', !!active);
  });

  socket.on('media-share-change', ({ roomId, active } = {}) => {
    if (inRoom(roomId)) socket.to(roomId).emit('media-share-change', !!active);
  });

  socket.on('media-control', ({ roomId, action } = {}) => {
    if (inRoom(roomId)) socket.to(roomId).emit('media-control', action);
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('peer-disconnected', { role: currentRole });
    }
  });
});

// ── Cleanup: expire old rooms periodically ──────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, info] of Object.entries(rooms)) {
    if (now - info.created > ROOM_TTL) delete rooms[id];
  }
}, 60 * 60 * 1000); // hourly

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Podcast Studio running → http://localhost:${PORT}`);
});
