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
    logToClient(`[Server] Camera ${label} joined room ${rid}`);
    
    const currentRoom = rooms.get(rid);
    if (currentRoom.viewerIds.size > 0) {
        logToClient(`[Server] Notifying new camera about ${currentRoom.viewerIds.size} waiting viewers`);
        socket.emit('viewer-joined', 'existing-viewer');
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
    logToClient(`[Server] Viewer joined room ${rid}`);

    if (room.socketId) {
        io.to(room.socketId).emit('viewer-joined', socket.id);
    }
    // 同時對房間廣播
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
    
    // 終極發送：對該房間內的所有裝置發送（包含相機）
    io.in(rid).emit('camera-command', { roomId: rid, command });
    
    // 同時檢查是否有相機在線
    const room = rooms.get(rid);
    if (!room || !room.online) {
        logToClient(`[Server] Warning: Target room ${rid} is offline according to Map`);
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
        console.log(`[Server] Camera left room ${myRoomId}`);
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
