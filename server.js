const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.json());

// rooms: { [roomId]: { id, label, online, lastSeen, socketId, viewerIds: Set<string> } }
const rooms = new Map();

function roomSnapshot() {
  return Array.from(rooms.values()).map(r => ({
    id:       r.id,
    label:    r.label,
    online:   r.online,
    lastSeen: r.lastSeen,
    viewers:  r.viewerIds.size,
    battery:  r.battery ?? -1,
    torchOn:  r.torchOn ?? false,
  }));
}

function broadcastRoomUpdate() {
  io.emit('room-update', roomSnapshot());
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/rooms', (_req, res) => {
  res.json(roomSnapshot());
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let myRole        = null;   // 'camera' | 'viewer'
  let myRoomId      = null;
  let viewingRoomId = null;

  // Camera 端加入
  socket.on('join-camera', ({ roomId, label }) => {
    myRole   = 'camera';
    myRoomId = roomId;

    const prev = rooms.get(roomId);
    rooms.set(roomId, {
      id:        roomId,
      label:     label,
      online:    true,
      lastSeen:  new Date().toISOString(),
      socketId:  socket.id,
      viewerIds: prev ? prev.viewerIds : new Set(),
    });

    socket.join(roomId);
    broadcastRoomUpdate();
  });

  // Viewer 端加入某房間
  socket.on('join-viewer', (roomId) => {
    myRole        = 'viewer';
    viewingRoomId = roomId;

    const room = rooms.get(roomId);
    if (!room) return;

    room.viewerIds.add(socket.id);
    socket.join(roomId);

    // 通知 Camera 有新 Viewer
    if (room.socketId) {
      io.to(room.socketId).emit('viewer-joined', socket.id);
    }

    broadcastRoomUpdate();
  });

  // Camera 回報狀態（電量、手電筒）
  socket.on('camera-status', ({ roomId, battery, torchOn }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.battery = battery;
    room.torchOn = torchOn;
    io.to(roomId).emit('camera-status', { roomId, battery, torchOn });
  });

  // Viewer 送指令給 Camera
  socket.on('camera-command', ({ roomId, command }) => {
    const room = rooms.get(roomId);
    if (room?.socketId) {
      io.to(room.socketId).emit('camera-command', { command });
    }
  });

  // WebRTC 轉發：offer / answer / ice-candidate
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, roomId: myRoomId, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // 斷線處理
  socket.on('disconnect', () => {
    if (myRole === 'camera' && myRoomId) {
      const room = rooms.get(myRoomId);
      if (room) {
        room.online   = false;
        room.lastSeen = new Date().toISOString();
        room.socketId = null;
        io.to(myRoomId).emit('camera-offline', myRoomId);
        broadcastRoomUpdate();
      }
    } else if (myRole === 'viewer' && viewingRoomId) {
      const room = rooms.get(viewingRoomId);
      if (room) {
        room.viewerIds.delete(socket.id);
        broadcastRoomUpdate();
      }
    }
  });
});

// ── 啟動 ───────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CameraMonitor server listening on port ${PORT}`);
});
