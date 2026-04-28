const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 10000,
  pingInterval: 5000,
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
    const rid = String(roomId).trim();
    myRole   = 'camera';
    myRoomId = rid;

    // 清理可能存在的舊連線狀態
    const prev = rooms.get(rid);
    rooms.set(rid, {
      id:        rid,
      label:     label,
      online:    true,
      lastSeen:  new Date().toISOString(),
      socketId:  socket.id,
      viewerIds: prev ? prev.viewerIds : new Set(),
      battery:   prev ? prev.battery : -1,
      torchOn:   prev ? prev.torchOn : false,
    });

    socket.join(rid);
    broadcastRoomUpdate();
    console.log(`[Camera] ${label} joined room: ${rid}. Current members in room: ${io.sockets.adapter.rooms.get(rid)?.size || 0}`);
  });

  socket.on('join-viewer', (roomId) => {
    const rid = String(roomId).trim();
    myRole        = 'viewer';
    viewingRoomId = rid;

    const room = rooms.get(rid);
    if (!room) {
        console.log(`[Viewer] Room ${rid} not found. Attempting join anyway.`);
    }

    if (room) { room.viewerIds.add(socket.id); }
    socket.join(rid);

    console.log(`[Viewer] Joined room: ${rid}, requesting offer from camera...`);
    // 廣播給房間內所有人（主要是相機）
    socket.to(rid).emit('viewer-joined', socket.id);
    broadcastRoomUpdate();
  });

  // WebRTC 轉發
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, roomId: myRoomId, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // 相機狀態
  socket.on('camera-status', (status) => {
    const rid = String(status.roomId).trim();
    const room = rooms.get(rid);
    if (room) {
      room.battery = status.battery;
      room.torchOn = status.torchOn;
      room.lastSeen = new Date().toISOString();
      socket.to(rid).emit('camera-status', { ...status, roomId: rid });
      broadcastRoomUpdate();
    }
  });

  // 遠端指令 - 採用雙重保險發送
  socket.on('camera-command', ({ roomId, command }) => {
    const rid = String(roomId).trim();
    const room = rooms.get(rid);
    console.log(`[Command] ${command} for room ${rid}`);
    
    // 1. 對房間頻道廣播 (推薦)
    io.to(rid).emit('camera-command', { roomId: rid, command });
    
    // 2. 如果知道特定的 socketId，額外補發 (雙保險)
    if (room && room.socketId && room.socketId !== socket.id) {
        io.to(room.socketId).emit('camera-command', { roomId: rid, command });
    }
  });

  socket.on('disconnect', () => {
    if (myRole === 'camera' && myRoomId) {
      const room = rooms.get(myRoomId);
      if (room && room.socketId === socket.id) {
        room.online   = false;
        room.socketId = null;
        io.to(myRoomId).emit('camera-offline', myRoomId);
        broadcastRoomUpdate();
      }
    } else if (myRole === 'viewer' && viewingRoomId) {
      const room = rooms.get(viewingRoomId);
      if (room) {
        room.viewerIds.delete(socket.id);
        socket.to(viewingRoomId).emit('viewer-left', socket.id);
        broadcastRoomUpdate();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CameraMonitor server listening on port ${PORT}`);
});
