# rtcTree - Auto-Balancing WebRTC Mesh Library

`rtcTree` is a powerful WebRTC mesh topology manager designed for P2P live streaming distribution. It significantly reduces the streamer's upload bandwidth requirements by intelligently distributing the load across viewers. It also features a fully customizable **Media Pipeline** and two **Auto-Balancing** strategies.

## 🌟 Key Features

- **Media Pipeline**: Fully decouple video, audio, and data. Define exactly how streams should be processed before local rendering (Incoming) and before forwarding to other nodes (Outgoing).
- **Auto-Balancing Strategies**:
  - `chronological` (Default): First-come, first-serve. If a node disconnects, a child naturally takes its place.
  - `quality`: Automatically places nodes with the best network conditions (lowest ping, highest bitrate) closer to the streamer. Automatically demotes unstable nodes.
- **Self-Healing**: When a parent node disconnects, child nodes automatically reconnect to the next best available node.
- **Node Swapping**: The server can dynamically swap nodes to optimize network health.
- **Stats Monitoring**: Clients continuously report Ping and Bitrate to the server for topology calculation.
- **Data Broadcasting**: A robust P2P data channel to broadcast chat messages or JSON payloads across the entire mesh.

---

## 📦 Installation

```bash
npm install webrtc-tree
```

---

## 📖 User Manual

### 1. Server-Side Setup (Node.js)

The `RTCTreeCoordinator` runs on your backend to manage the mesh topology without handling the actual media streams.

```typescript
import { RTCTreeCoordinator } from 'webrtc-tree/server';

const coordinator = new RTCTreeCoordinator();

// 1. Create a live room
coordinator.createRoom('room_123', 'streamer_peer_id', {
  maxNodesPerLayer: [1, 4, 16, 64], // Maximum nodes allowed per layer
  baseDelayMs: 1000,
  layerDelayMs: 300,
  autoBalanceStrategy: 'quality', // 'chronological' or 'quality'
  autoBalanceIntervalMs: 10000    // Run balance checks every 10 seconds
});

// 2. Handle auto-balancing reconnect signals
coordinator.onPeersNeedReconnect = (roomId, peerIds) => {
  // Send a WebSocket message to these peers telling them to reconnect
  // because the coordinator swapped their positions for better quality.
  console.log(`Please tell ${peerIds.join(', ')} to reconnect!`);
};

// 3. When a new viewer joins
// Use getAssignedParent to let the server decide the optimal parent node
const parentId = coordinator.getAssignedParent('room_123', 'viewer_peer_id_1');

// 4. Utility Methods
const totalNodes = coordinator.getTotalNodes('room_123');
const treeTopology = coordinator.getTreeObject('room_123');
```

---

### 2. Client-Side Setup (Browser)

The `RTCTreeClient` runs in the browser and handles the actual WebRTC connections, media processing, and auto-reconnections.

#### Basic Initialization

```typescript
import { RTCTreeClient } from 'webrtc-tree/client';

const client = new RTCTreeClient({
  // Function to ask your backend for a parent ID
  fetchParentIdFn: async () => {
    const res = await fetch('/api/get-parent');
    const data = await res.json();
    return data.parentId; 
  },
  
  // Function to report a dead node to your backend
  reportDeadFn: async (deadPeerId) => {
    await fetch('/api/report-dead', { method: 'POST', body: JSON.stringify({ deadPeerId }) });
  },
  
  // Callback when the final processed stream is ready for local playback
  onStreamReady: (stream) => {
    document.getElementById('live-video').srcObject = stream;
  }
});
```

---

### 3. Media Pipeline Architecture

The `RTCTreeClient` allows you to intercept and modify media streams.

#### Incoming Pipeline (Local Rendering)
Modify streams for **local viewing only** (does not affect forwarded streams).

```typescript
const client = new RTCTreeClient({
  // ...other options
  
  // Apply a local grayscale filter
  onIncomingVideo: (track) => {
    return applyGrayscaleFilter(track); 
  },
  
  // Mute audio locally
  onIncomingAudio: (track) => {
    track.enabled = false;
    return track; 
  },
  
  // Receive broadcasted chat messages
  onIncomingData: (data) => {
    console.log("Received chat message:", data.message);
  }
});
```

#### Outgoing Pipeline (Forwarding)
Modify streams **before** they are sent to child nodes. Ideal for streamers applying beauty filters or intermediate nodes appending watermarks.

```typescript
const client = new RTCTreeClient({
  // ...other options
  
  // Streamer applies a beauty filter before broadcasting
  onOutgoingVideo: (track) => {
    return applyBeautyFilter(track); 
  },
  
  // Intercept or modify data broadcasts
  onOutgoingData: (data) => {
    if (data.message.includes('spam')) {
      return null; // Returning null drops the message (stops forwarding)
    }
    return data;
  }
});

// Broadcast data to the entire mesh
client.broadcastData({ message: "Hello, World!" });
```

## License
MIT License
