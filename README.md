# rtcTree - WebRTC Mesh 拓撲與狀態管理套件

`rtcTree` 是一個強大的 WebRTC 網狀 (Mesh) 拓撲管理與 P2P 直播分發套件。它能夠有效減少直播主 (Streamer) 的上傳頻寬壓力，透過「觀眾轉發給觀眾」的層級拓撲，實現低延遲、高擴展的直播架構。

## 特色功能

- **自動分配與層級拓撲 (Auto Topology)**：利用 BFS 演算法自動將新加入的節點分配至負載最輕的區域。
- **自我修復機制 (Self-Healing)**：當上層節點斷線時，下層節點會自動重新尋找新的父節點，維持網格穩定。
- **兩點交換 (Node Swapping)**：可隨時將網路品質優良的節點移至上層，或是降級不穩定的節點。
- **品質回報與監測 (Stats & Monitoring)**：客戶端會定期回報 Ping 與 Bitrate，伺服器可計算每層的平均品質。
- **階層式延遲管理 (Layer Delay)**：支援設定基礎延遲 (`baseDelayMs`) 與逐層遞增延遲 (`layerDelayMs`)。
- **物件化樹狀圖輸出 (Nested Tree Object)**：支援匯出完整的嵌套 JSON 物件結構，可直接用於前端拓撲視覺化。

## 架構說明

本專案採用 **Domain-Driven Design (DDD)** 的精神拆分為伺服器與客戶端：
- **`RTCTreeCoordinator` (Server-side)**：負責記憶體中的節點狀態管理、路由分配、拓撲計算與修復決策。
- **`RTCTreeClient` (Client-side)**：封裝 `peerjs`，負責處理 P2P 連線、影音串流接收與發送、以及定時的網路狀態回報。

---

## 安裝與使用

### Server-Side (伺服器端)

在後端伺服器 (如 Node.js 或透過 API 橋接) 初始化 Coordinator：

```typescript
import { RTCTreeCoordinator } from 'rtcTree/server';

const coordinator = new RTCTreeCoordinator();

// 1. 建立房間 (直播主加入)
coordinator.createRoom('room_123', 'streamer_peer_id', {
  maxNodesPerLayer: [1, 4, 16, 64], // 第一層 4 人，第二層 16 人...
  baseDelayMs: 1000,
  layerDelayMs: 300
});

// 2. 觀眾加入，分配父節點
const parentPeerId = coordinator.joinNode('room_123', 'viewer_peer_id_1');
console.log(`分配給觀眾的父節點是: ${parentPeerId}`);

// 3. 取得目前拓撲圖
const treeObj = coordinator.getTreeObject('room_123');
console.dir(treeObj, { depth: null });
```

### Client-Side (瀏覽器端)

在前端網頁中載入 Client，並實作與伺服器溝通的 API 函數：

```typescript
import { RTCTreeClient } from 'rtcTree/client';

const client = new RTCTreeClient({
  // 向伺服器請求一個父節點來連線
  fetchParentIdFn: async () => {
    const res = await fetch('/api/live/join', { method: 'POST', body: JSON.stringify({ peerId: myPeerId }) });
    return (await res.json()).parentPeerId;
  },
  // 回報上層節點斷線
  reportDeadFn: async (deadPeerId) => {
    await fetch('/api/live/report_dead', { method: 'POST', body: JSON.stringify({ deadPeerId }) });
  },
  // 回報網路狀態 (Ping, Bitrate)
  reportStatsFn: async (pingMs, bitrateKbps) => {
    await fetch('/api/live/report_stats', { method: 'POST', body: JSON.stringify({ pingMs, bitrateKbps }) });
  },
  // 當接收到影像串流
  onStreamReceived: (stream) => {
    const videoElement = document.getElementById('live-video') as HTMLVideoElement;
    videoElement.srcObject = stream;
  },
  // 狀態改變時的提示
  onStatusChange: (status) => console.log('狀態:', status),
  // 伺服器期望的延遲時間 (由客戶端決定如何套用，如 video.currentTime)
  onDelayConfigured: (expectedDelayMs) => {
    console.log(`目前這層的預期延遲是: ${expectedDelayMs} ms`);
  }
});

// 如果是直播主：
await client.initStreamer(localCameraStream, 4);

// 如果是觀眾：
await client.initViewer(4);
```

## 進階 API 參考

### `swapNodes(roomId, peerA, peerB)`
強制交換兩個非直系節點的位置，適用於管理員介入優化網路架構：
```typescript
const success = coordinator.swapNodes('room_123', 'peer_user_A', 'peer_user_B');
```

### `getLayerStats(roomId, layer)`
取得特定層級目前的平均網路品質：
```typescript
const stats = coordinator.getLayerStats('room_123', 1);
console.log(`第一層平均 Ping: ${stats.averagePing}ms, 平均流量: ${stats.averageBitrate}Kbps`);
```

## 授權
MIT License
