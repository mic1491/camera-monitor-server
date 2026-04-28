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

  const logToClient = (msg) => {
    console.log(msg);
    socket.emit('server-log', msg);
  };

  socket.on('join-camera', ({ roomId, label }) => {
    const rid = String(roomId).trim().toLowerCase();
    myRole   = 'camera';
    myRoomId = rid;

    const prev = rooms.get(rid);
    const viewerIds = prev ? prev.viewerIds : new Set();
    
    rooms.set(rid, {
      id:        rid,
      label:     label,
      online:    true,
      lastSeen:  new Date().toISOString(),
      socketId:  socket.id,
      viewerIds: viewerIds,
      battery:   -1,
      torchOn:   false,
    });

    socket.join(rid);
    broadcastRoomUpdate();
    logToClient(`[Server] Camera ${label} joined room ${rid}`);
    
    // 重要修正：如果有等待中的 Viewer，將他們的真實 socketId 逐一發給相機
    if (viewerIds.size > 0) {
        logToClient(`[Server] Notifying new camera about ${viewerIds.size} waiting viewers individually`);
        viewerIds.forEach(vId => {
            socket.emit('viewer-joined', vId);
        });
    }
  });

  socket.on('join-viewer', (roomId) => {
    const rid = String(roomId).trim().toLowerCase();
    myRole        = 'viewer';
    viewingRoomId = rid;

    if (!rooms.has(rid)) {
        rooms.set(rid, { id: rid, label: '正在連線...', online: false, viewerIds: new Set(), battery: -1, torchOn: false });
    }

    const room = rooms.get(rid);
    room.viewerIds.add(socket.id);
    socket.join(rid);
    logToClient(`[Server] Viewer joined room ${rid}`);

    // 通知房間內的相機有新的觀看者
    if (room.socketId) {
        logToClient(`[Server] Notifying camera socket ${room.socketId}`);
        io.to(room.socketId).emit('viewer-joined', socket.id);
    }
    // 雙重保險廣播
    socket.to(rid).emit('viewer-joined', socket.id);
    
    broadcastRoomUpdate();
  });

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
    logToClient(`[Server] RELAYING command '${command}' to room ${rid}`);
    io.in(rid).emit('camera-command', { roomId: rid, command });
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
