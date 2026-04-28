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

// rooms: Map<roomId, { id, label, online, lastSeen, socketId, viewerIds: Set<string>, battery, torchOn }>
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
    const viewerIds = prev ? prev.viewerIds : new Set();
    
    rooms.set(rid, {
      id:        rid,
      label:     label,
      online:    true,
      lastSeen:  new Date().toISOString(),
      socketId:  socket.id,
      viewerIds: viewerIds,
      battery:   prev ? prev.battery : -1,
      torchOn:   prev ? prev.torchOn : false,
    });

    socket.join(rid);
    broadcastRoomUpdate();
    console.log(`[Camera] JOIN: ${label} (${rid}) on socket ${socket.id}`);
    
    // 如果已有 Viewer 在等，立刻通知相機
    if (viewerIds.size > 0) {
        viewerIds.forEach(vId => {
            console.log(`[Camera] notifying existing viewer ${vId} to this new camera socket`);
            socket.emit('viewer-joined', vId);
        });
    }
  });

  socket.on('join-viewer', (roomId) => {
    const rid = String(roomId).trim();
    myRole        = 'viewer';
    viewingRoomId = rid;

    const room = rooms.get(rid);
    if (!room) {
        console.log(`[Viewer] JOIN FAIL: Room ${rid} not found`);
        return;
    }

    room.viewerIds.add(socket.id);
    socket.join(rid);
    console.log(`[Viewer] JOIN: Room ${rid}, socket ${socket.id}`);

    if (room.socketId) {
        console.log(`[Viewer] notifying camera ${room.socketId}`);
        io.to(room.socketId).emit('viewer-joined', socket.id);
    }
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

  socket.on('camera-command', ({ roomId, command }) => {
    const rid = String(roomId).trim();
    const room = rooms.get(rid);
    if (room && room.socketId) {
      console.log(`[Command] RELAY: ${command} -> room ${rid} (socket ${room.socketId})`);
      io.to(room.socketId).emit('camera-command', { roomId: rid, command });
    } else {
      console.log(`[Command] FAIL: Room ${rid} not found or offline`);
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
        console.log(`[Camera] DISCONNECT: ${myRoomId}`);
      }
    } else if (myRole === 'viewer' && viewingRoomId) {
      const room = rooms.get(viewingRoomId);
      if (room) {
        room.viewerIds.delete(socket.id);
        if (room.socketId) {
            io.to(room.socketId).emit('viewer-left', socket.id);
        }
        broadcastRoomUpdate();
        console.log(`[Viewer] DISCONNECT: Room ${viewingRoomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CameraMonitor server listening on port ${PORT}`);
});
