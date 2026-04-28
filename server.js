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
    const rid = String(roomId).trim();
    myRole   = 'camera';
    myRoomId = rid;

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
    console.log(`[Camera] Joined room: ${rid}, socketId: ${socket.id}`);
  });

  socket.on('join-viewer', (roomId) => {
    const rid = String(roomId).trim();
    myRole        = 'viewer';
    viewingRoomId = rid;

    const room = rooms.get(rid);
    if (!room) {
        console.log(`[Viewer] Failed to join: Room ${rid} not found`);
        return;
    }

    room.viewerIds.add(socket.id);
    socket.join(rid);

    console.log(`[Viewer] Joined room: ${rid}, notifying camera(s) in room`);
    // 改用房間廣播發送 viewer-joined，確保相機一定收得到
    socket.to(rid).emit('viewer-joined', socket.id);
    
    broadcastRoomUpdate();
  });

  // WebRTC 轉發：offer / answer / ice-candidate
  socket.on('offer', ({ to, offer }) => {
    // offer 包含 roomId，方便接收端過濾
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

  // 遠端指令 (Viewer -> Server -> Camera)
  socket.on('camera-command', ({ roomId, command }) => {
    const rid = String(roomId).trim();
    const room = rooms.get(rid);
    if (room) {
      console.log(`[Command] Broadcast ${command} to room ${rid}`);
      io.to(rid).emit('camera-command', { roomId: rid, command });
    } else {
      console.log(`[Command] Failed: Room ${rid} not found.`);
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
        console.log(`[Camera] Offline: ${myRoomId}`);
      }
    } else if (myRole === 'viewer' && viewingRoomId) {
      const room = rooms.get(viewingRoomId);
      if (room) {
        room.viewerIds.delete(socket.id);
        socket.to(viewingRoomId).emit('viewer-left', socket.id);
        broadcastRoomUpdate();
        console.log(`[Viewer] Left room: ${viewingRoomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CameraMonitor server listening on port ${PORT}`);
});
