<div align="center">
  <h1>rtcTree</h1>
  <p><b>Advanced Auto-Balancing WebRTC Mesh Topology Manager</b></p>
</div>

`rtcTree` is a decentralized WebRTC topology management library engineered for peer-to-peer (P2P) live streaming distribution. It intelligently offloads the streamer's upload bandwidth by distributing media streams across viewers using an auto-balancing mesh network.

## Table of Contents
- [Installation](#installation)
- [Architecture Overview](#architecture-overview)
- [Core Features](#core-features)
- [Server-Side API (Coordinator)](#server-side-api-coordinator)
- [Client-Side API (Client)](#client-side-api-client)
- [Media Pipeline Hooks](#media-pipeline-hooks)
- [Auto-Balancing Strategies](#auto-balancing-strategies)

---

## Installation

Install via npm:

```bash
npm install webrtc-tree
```

---

## Architecture Overview

`rtcTree` operates on a hybrid architecture:
1. **Server Coordinator (`RTCTreeCoordinator`)**: Maintains a lightweight structural map of the network topology. It calculates routing, network quality, and connection assignments without ever processing or receiving the actual media streams.
2. **Client Node (`RTCTreeClient`)**: Runs in the browser, manages the actual WebRTC `PeerJS` connections, processes media pipelines, and forwards streams to downstream viewers.

---

## Core Features

- **Media Pipeline**: Decouple and independently process video, audio, and data tracks before local rendering or downstream forwarding.
- **Smart Auto-Balancing**: Periodically evaluates connection quality (ping/bitrate) to promote strong nodes and demote weak ones.
- **Self-Healing Topology**: If a parent node drops, the mesh automatically restructures, placing children under the most optimal available nodes.
- **Data Channel Broadcasting**: Send and intercept custom JSON payloads across the entire mesh hierarchy.

---

## Server-Side API (Coordinator)

The Coordinator must run in a Node.js backend environment to keep track of the mesh state.

### `import { RTCTreeCoordinator } from 'webrtc-tree/server';`

### `createRoom(roomId, streamerPeerId, config)`
Initializes a new streaming room topology.

```typescript
const coordinator = new RTCTreeCoordinator();

coordinator.createRoom('room_123', 'streamer_id', {
  maxNodesPerLayer: [1, 4, 16, 64],
  baseDelayMs: 1000,
  layerDelayMs: 300,
  autoBalanceStrategy: 'quality', // 'chronological' | 'quality'
  autoBalanceIntervalMs: 10000    // Evaluation interval
});
```

### `getAssignedParent(roomId, peerId)`
Retrieves the optimal parent ID for a joining or reconnecting client.

```typescript
const parentId = coordinator.getAssignedParent('room_123', 'viewer_id');
```

### `getTotalNodes(roomId)`
Returns the total number of connected peers in the room.

```typescript
const count = coordinator.getTotalNodes('room_123');
```

### `onPeersNeedReconnect` (Event Callback)
Triggered when the Coordinator's `quality` auto-balancer decides to swap nodes. You must notify these peers via your own WebSocket/SSE to force a reconnection.

```typescript
coordinator.onPeersNeedReconnect = (roomId, peerIds) => {
  // Send WebSocket message instructing peers to disconnect and ask for a new parent
};
```

---

## Client-Side API (Client)

The Client handles the P2P connection logic in the browser environment.

### `import { RTCTreeClient } from 'webrtc-tree/client';`

### Initialization

```typescript
const client = new RTCTreeClient({
  fetchParentIdFn: async () => {
    // Call your backend API to invoke coordinator.getAssignedParent
    const response = await fetch('/api/get-parent');
    return (await response.json()).parentId;
  },
  reportDeadFn: async (deadPeerId) => {
    // Report dropped connections to backend
  },
  onStreamReady: (stream) => {
    // Attach stream to video element
    videoElement.srcObject = stream;
  }
});

// Start process
await client.initViewer();
```

---

## Media Pipeline Hooks

The pipeline allows intercepting streams at two specific stages: `Incoming` (for local display) and `Outgoing` (for forwarding). 

Provide these hooks within the `RTCTreeClient` constructor options:

```typescript
const client = new RTCTreeClient({
  // ...

  // 1. INCOMING: Modify what the local user sees/hears
  onIncomingVideo: (track) => applyLocalFilter(track),
  onIncomingAudio: (track) => {
    track.enabled = false; // Mute locally
    return track;
  },
  onIncomingData: (data) => console.log('Chat message:', data),

  // 2. OUTGOING: Modify what is forwarded to downstream viewers
  onOutgoingVideo: (track) => applyBeautyFilter(track),
  onOutgoingData: (data) => {
    if (data.includes('spam')) return null; // Intercept and block forwarding
    return data;
  }
});
```

---

## Auto-Balancing Strategies

Define the strategy in the `RoomConfig` during `createRoom`.

### 1. `chronological` (Default)
- **Placement**: First-come, first-serve. Nodes fill layers sequentially via BFS.
- **Healing**: If a node disconnects, a child or a newly joining node takes its place sequentially.

### 2. `quality`
- **Active Evaluation**: Periodically checks the Ping and Bitrate of all nodes.
- **Node Swapping**: If a downstream node exhibits significantly better network quality than an upstream node, the server swaps their positions.
- **Smart Promotion**: When a node disconnects, the coordinator evaluates its children and immediately promotes the child with the best network score to assume the vacant position.

---

## License
MIT License
