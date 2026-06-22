import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { RTCTreeCoordinator } from 'webrtc-tree/server';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const coordinator = new RTCTreeCoordinator();
const ROOM_ID = 'test-room';

// Init Vite middleware for frontend
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa'
});
app.use(vite.middlewares);

coordinator.onSignalingMessage = (roomId, fromPeerId, toPeerId, message) => {
  io.to(toPeerId).emit('rtc-message', {
    fromPeerId: fromPeerId,
    payload: message
  });
};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('create-room', () => {
    coordinator.createRoom(ROOM_ID, socket.id, {
      maxNodesPerLayer: [1, 2, 4],
      autoBalanceStrategy: 'chronological'
    });
    socket.emit('room-created', ROOM_ID);
    console.log(`[${socket.id}] 成為直播主建立房間`);
  });

  socket.on('join-room', (callback) => {
    const parentId = coordinator.getAssignedParent(ROOM_ID, socket.id);
    if (parentId) {
      console.log(`[${socket.id}] 加入房間，分配的父節點為: ${parentId}`);
      callback(parentId);
    } else {
      callback(null);
    }
  });

  socket.on('rtc-message', (data) => {
    // 轉發信令給目標
    const { toPeerId, payload } = data;
    coordinator.handleSignaling(ROOM_ID, socket.id, toPeerId, payload);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    coordinator.removeNode(ROOM_ID, socket.id);
  });
});

httpServer.listen(3000, () => {
  console.log('測試伺服器已啟動於 http://localhost:3000');
});
