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

// ── REST: room management ──────────────────────────────────────────────────

app.post('/room/create', (req, res) => {
  const roomId = uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  rooms[roomId] = { created: Date.now() };
  res.json({ roomId });
});

// ── REST: file handling ────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadsDir, req.params.roomId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({ storage });

app.post('/upload/:roomId', upload.single('file'), (req, res) => {
  res.json({ success: true, filename: req.file.filename });
});

app.get('/room/:roomId/files', (req, res) => {
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
  const fp = path.join(uploadsDir, req.params.roomId, decodeURIComponent(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('File not found');
  res.download(fp);
});

// ── Socket.io signaling ────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentRole = null;

  socket.on('join-room', ({ roomId, role }) => {
    socket.join(roomId);
    currentRoom = roomId;
    currentRole = role;
    socket.emit('joined', { roomId });
    socket.to(roomId).emit('peer-joined', { role });
  });

  // WebRTC signaling — pass through to the other peer
  socket.on('signal', ({ roomId, data }) => {
    socket.to(roomId).emit('signal', data);
  });

  // Layout changes from host → guest
  socket.on('layout-change', ({ roomId, layout }) => {
    socket.to(roomId).emit('layout-change', layout);
  });

  // Recording commands: host triggers guest to start/stop recording
  socket.on('recording-start', ({ roomId }) => {
    socket.to(roomId).emit('recording-start');
  });

  socket.on('recording-stop', ({ roomId }) => {
    socket.to(roomId).emit('recording-stop');
  });

  // Screen share state so guest canvas can react
  socket.on('screen-share-change', ({ roomId, active }) => {
    socket.to(roomId).emit('screen-share-change', active);
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('peer-disconnected', { role: currentRole });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Podcast Studio running → http://localhost:${PORT}`);
});
