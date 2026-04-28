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
      battery:   prev ? prev.battery : -1,
      torchOn:   prev ? prev.torchOn : false,
    });

    socket.join(rid);
    broadcastRoomUpdate();
    console.log(`[Camera] JOIN: ${rid} (socket ${socket.id})`);
    
    // 如果已有 Viewer 在等，立刻通知相機發起連線
    if (viewerIds.size > 0) {
        console.log(`[Camera] Notifying camera in ${rid} about ${viewerIds.size} waiting viewers`);
        // 廣播給房間內所有人（包含剛加入的相機）
        io.to(rid).emit('viewer-joined', 'existing-viewer');
    }
  });

  socket.on('join-viewer', (roomId) => {
    const rid = String(roomId).trim().toLowerCase();
    myRole        = 'viewer';
    viewingRoomId = rid;

    const room = rooms.get(rid);
    if (!room) {
        // 即使房間沒創立也允許加入，預留給先開監控的情況
        rooms.set(rid, { id: rid, label: '正在搜尋...', online: false, viewerIds: new Set(), battery: -1, torchOn: false });
    }

    const currentRoom = rooms.get(rid);
    currentRoom.viewerIds.add(socket.id);
    socket.join(rid);
    console.log(`[Viewer] JOIN: ${rid} (socket ${socket.id})`);

    // 重點：對整個房間廣播，確保相機一定收得到
    io.to(rid).emit('viewer-joined', socket.id);
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
    console.log(`[Command] RELAY: ${command} to room ${rid}`);
    // 直接對整個房間廣播指令，最穩定
    io.to(rid).emit('camera-command', { roomId: rid, command });
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
        io.to(viewingRoomId).emit('viewer-left', socket.id);
        broadcastRoomUpdate();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CameraMonitor server listening on port ${PORT}`);
});
