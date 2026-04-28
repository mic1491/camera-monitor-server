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
    const rid = String(roomId).trim().toLowerCase();
    myRole   = 'camera';
    myRoomId = rid;

    // 如果該房間已有相機，先強制清理
    const prev = rooms.get(rid);
    if (prev && prev.socketId && prev.socketId !== socket.id) {
        console.log(`[Camera] Evicting old socket ${prev.socketId} for room ${rid}`);
        io.to(prev.socketId).emit('camera-offline', rid);
    }

    rooms.set(rid, {
      id:        rid,
      label:     label,
      online:    true,
      lastSeen:  new Date().toISOString(),
      socketId:  socket.id,
      viewerIds: prev ? prev.viewerIds : new Set(),
      battery:   -1,
      torchOn:   false,
    });

    socket.join(rid);
    broadcastRoomUpdate();
    console.log(`[Camera] JOIN: ${rid} (socket: ${socket.id})`);
    
    const currentRoom = rooms.get(rid);
    if (currentRoom.viewerIds.size > 0) {
        console.log(`[Camera] ${rid} has ${currentRoom.viewerIds.size} waiting viewers. Requesting initial offer.`);
        socket.emit('viewer-joined', 'existing');
    }
  });

  socket.on('join-viewer', (roomId) => {
    const rid = String(roomId).trim().toLowerCase();
    myRole        = 'viewer';
    viewingRoomId = rid;

    if (!rooms.has(rid)) {
        rooms.set(rid, { id: rid, label: '搜尋中...', online: false, viewerIds: new Set(), battery: -1, torchOn: false });
    }

    const room = rooms.get(rid);
    room.viewerIds.add(socket.id);
    socket.join(rid);
    console.log(`[Viewer] JOIN: ${rid} (socket: ${socket.id})`);

    if (room.online && room.socketId) {
        console.log(`[Viewer] Requesting offer from camera ${room.socketId}`);
        io.to(room.socketId).emit('viewer-joined', socket.id);
    }
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

  socket.on('camera-status', (status) => {
    const rid = String(status.roomId).trim().toLowerCase();
    const room = rooms.get(rid);
    if (room) {
      room.battery = status.battery;
      room.torchOn = status.torchOn;
      room.lastSeen = new Date().toISOString();
      socket.to(rid).emit('camera-status', { ...status, roomId: rid });
      broadcastRoomUpdate();
    }
  });

  socket.on('camera-command', ({ roomId, command }) => {
    const rid = String(roomId).trim().toLowerCase();
    const room = rooms.get(rid);
    console.log(`[Command] RELAY: ${command} to room ${rid}`);
    
    if (room && room.online && room.socketId) {
        console.log(`[Command] Sending to camera socket: ${room.socketId}`);
        io.to(room.socketId).emit('camera-command', { roomId: rid, command });
    } else {
        console.log(`[Command] FAILED: Camera for room ${rid} is offline or no socketId`);
    }
    // 雙重保險：房間廣播
    socket.to(rid).emit('camera-command', { roomId: rid, command });
  });

  socket.on('disconnect', () => {
    if (myRole === 'camera' && myRoomId) {
      const room = rooms.get(myRoomId);
      if (room && room.socketId === socket.id) {
        room.online   = false;
        room.socketId = null;
        io.to(myRoomId).emit('camera-offline', myRoomId);
        broadcastRoomUpdate();
        console.log(`[Camera] LEFT: ${myRoomId}`);
      }
    } else if (myRole === 'viewer' && viewingRoomId) {
      const room = rooms.get(viewingRoomId);
      if (room) {
        room.viewerIds.delete(socket.id);
        socket.to(viewingRoomId).emit('viewer-left', socket.id);
        broadcastRoomUpdate();
        console.log(`[Viewer] LEFT: ${viewingRoomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CameraMonitor server listening on port ${PORT}`);
});
