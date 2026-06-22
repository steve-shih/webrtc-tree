import { io } from 'socket.io-client';
import { RTCTreeClient } from 'webrtc-tree/client';

const socket = io();
const videoPlayer = document.getElementById('videoPlayer');
const statusText = document.getElementById('status');

// 建立 WebRTC Client
const client = new RTCTreeClient({
  onStatusChange: (status) => {
    statusText.innerText = `狀態：${status}`;
  },
  onStreamReady: (stream) => {
    videoPlayer.srcObject = stream;
  },
  sendMessageFn: (targetPeerId, message) => {
    // 透過 Socket 傳送信令
    socket.emit('rtc-signal', {
      toPeerId: targetPeerId,
      message: message
    });
  },
  fetchParentIdFn: () => {
    return new Promise((resolve) => {
      socket.emit('join-room', (parentId) => {
        resolve(parentId);
      });
    });
  }
});

// 當收到信令
socket.on('rtc-signal', (message) => {
  // 注意：這裡假設後端會將 fromPeerId 也包含進來。
  // 我們需要在 server.js 裡面補傳 fromPeerId。
  // 但是因為在上面的 sendMessageFn 我們沒包裝 fromPeerId，我們可以直接修改 Server 讓它知道發送者是誰。
  // 稍後 server.js 會轉發原始的 message。我們在 server.js 的 rtc-signal 把 message 包成 { fromPeerId, payload }，
  // 或者在前端加上。
});

// 我們來修正一下接收的邏輯
socket.on('rtc-message', (data) => {
  const { fromPeerId, payload } = data;
  client.receiveMessage(fromPeerId, payload);
});

// 修正前面的 sendMessageFn
client.options.sendMessageFn = (targetPeerId, payload) => {
  socket.emit('rtc-message', {
    toPeerId: targetPeerId,
    payload: payload
  });
};

document.getElementById('btnStreamer').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    videoPlayer.srcObject = stream;
    videoPlayer.muted = true; // 自己看自己要靜音
    
    socket.emit('create-room');
    socket.on('room-created', async () => {
      await client.initStreamer(socket.id, stream);
    });
  } catch (e) {
    alert('無法取得攝影機權限');
  }
};

document.getElementById('btnViewer').onclick = async () => {
  await client.initViewer(socket.id);
};
