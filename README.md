# rtcTree - WebRTC Mesh 拓撲與狀態管理套件

`rtcTree` 是一個強大的 WebRTC 網狀 (Mesh) 拓撲管理與 P2P 直播分發套件。除了能有效減少直播主的上傳頻寬壓力外，它還具備了「**全客製化媒體管線 (Media Pipeline)**」的能力，讓您能夠在轉發的過程中掛載濾鏡、處理文字與音訊。

## 特色功能

- **自動分配與層級拓撲 (Auto Topology)**：利用 BFS 演算法自動將新加入的節點分配至負載最輕的區域。
- **自我修復機制 (Self-Healing)**：當上層節點斷線時，下層節點會自動重新尋找新的父節點。
- **兩點交換 (Node Swapping)**：可隨時將網路品質優良的節點移至上層。
- **品質回報與監測 (Stats & Monitoring)**：客戶端定期回報 Ping 與 Bitrate，供伺服器計算平均品質。
- **雙向媒體管線 (Media Pipeline)**：支援將影像、聲音、文字獨立拆分處理。能清楚定義「收到後如何本地顯示 (Incoming)」以及「如何修改再轉發 (Outgoing)」。

---

## 安裝與使用

### Server-Side (伺服器端)
```typescript
import { RTCTreeCoordinator } from 'rtcTree/server';

const coordinator = new RTCTreeCoordinator();

// 1. 建立房間
coordinator.createRoom('room_123', 'streamer_peer_id', {
  maxNodesPerLayer: [1, 4, 16, 64],
  baseDelayMs: 1000,
  layerDelayMs: 300
});

// 2. 觀眾加入
const parentPeerId = coordinator.joinNode('room_123', 'viewer_peer_id_1');
```

### Client-Side (瀏覽器端) - 基礎初始化
```typescript
import { RTCTreeClient } from 'rtcTree/client';

const client = new RTCTreeClient({
  fetchParentIdFn: async () => /* 向後端要 parent ID */,
  reportDeadFn: async (deadPeerId) => /* 回報斷線 */,
  onStreamReady: (stream) => {
    // 綁定到 Video
    document.getElementById('live-video').srcObject = stream;
  }
});
```

---

## 🚀 核心亮點：雙向媒體管線 (Media Pipeline)

`rtcTree` 允許您完全解耦 **影像、聲音與文字**，並透過 Hook 函數決定如何處理。

### 1. 傳進來後處理 (Incoming Local Render)
這些 Hook 允許您修改「**自己本地要看到/聽到**」的串流。修改結果**不會**影響轉發給下線的串流。

```typescript
const client = new RTCTreeClient({
  // ...其他選項
  
  // (影像) 本地端套用黑白濾鏡來觀看，但不影響其他觀眾
  onIncomingVideo: (track) => {
    return applyBlackAndWhiteFilter(track); 
  },
  
  // (聲音) 收到音訊後，本地端直接靜音
  onIncomingAudio: (track) => {
    track.enabled = false;
    return track; 
  },
  
  // (文字) 收到上層廣播的聊天訊息，顯示在本地對話框
  onIncomingData: (data) => {
    appendChatMessageToUI(data.message);
  }
});
```

### 2. 處理完傳出去 (Outgoing Forwarding)
這些 Hook 允許您在「**把串流轉發給下線前**」進行修改。非常適合直播主套用美顏，或中介節點加上浮水印。

```typescript
const client = new RTCTreeClient({
  // ...其他選項
  
  // (影像) 直播主發送前套用美顏濾鏡
  onOutgoingVideo: (track) => {
    return applyBeautyFilter(track); 
  },
  
  // (文字) 攔截或修改要廣播給下線的文字訊息 (例如髒話過濾)
  onOutgoingData: (data) => {
    if (data.message.includes('髒話')) {
      return null; // 回傳 null 會攔截此訊息，不會往下線廣播
    }
    return data;
  }
});

// 發送廣播文字！訊息會透過 Mesh 網路傳遞給所有子節點
client.broadcastData({ message: "大家好，歡迎來到直播間！" });
```

## 授權
MIT License
