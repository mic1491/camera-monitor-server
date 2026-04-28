const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.json());

// rooms: { [roomId]: { id, label, online, lastSeen, socketId, viewerIds: Set<string>, battery, torchOn } }
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

app.get('/api/rooms', (_req, res) => {
  res.json(roomSnapshot());
});

io.on('connection', (socket) => {
  let myRole        = null;
  let myRoomId      = null;
  let viewingRoomId = null;

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
      battery:   prev ? prev.battery : -1,
      torchOn:   prev ? prev.torchOn : false,
    });

    socket.join(roomId);
    broadcastRoomUpdate();
    console.log(`[Camera] ${label} (${roomId}) joined. socketId: ${socket.id}`);
  });

  socket.on('join-viewer', (roomId) => {
    myRole        = 'viewer';
    viewingRoomId = roomId;

    const room = rooms.get(roomId);
    if (!room) return;

    room.viewerIds.add(socket.id);
    socket.join(roomId);

    if (room.socketId) {
      console.log(`[Viewer] Joined ${roomId}, notifying camera ${room.socketId}`);
      io.to(room.socketId).emit('viewer-joined', socket.id);
    }
    broadcastRoomUpdate();
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

  // 相機狀態更新 (Camera -> Server)
  socket.on('camera-status', (status) => {
    const { roomId, battery, torchOn } = status;
    const room = rooms.get(roomId);
    if (room) {
      room.battery = battery;
      room.torchOn = torchOn;
      room.lastSeen = new Date().toISOString();
      socket.to(roomId).emit('camera-status', status);
      broadcastRoomUpdate();
    }
  });

  // 遠端指令 (Viewer -> Server -> Camera)
  socket.on('camera-command', ({ roomId, command }) => {
    const room = rooms.get(roomId);
    if (room && room.socketId) {
      console.log(`[Command] Relay ${command} to camera ${room.socketId}`);
      io.to(room.socketId).emit('camera-command', { command });
    } else {
      console.log(`[Command] Failed: Room ${roomId} or camera socket not found`);
    }
  });

  socket.on('disconnect', () => {
    if (myRole === 'camera' && myRoomId) {
      const room = rooms.get(myRoomId);
      if (room) {
        room.online   = false;
        room.socketId = null;
        io.to(myRoomId).emit('camera-offline', myRoomId);
        broadcastRoomUpdate();
      }
    } else if (myRole === 'viewer' && viewingRoomId) {
      const room = rooms.get(viewingRoomId);
      if (room) {
        room.viewerIds.delete(socket.id);
        if (room.socketId) {
            io.to(room.socketId).emit('viewer-left', socket.id);
        }
        broadcastRoomUpdate();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CameraMonitor server listening on port ${PORT}`);
});
