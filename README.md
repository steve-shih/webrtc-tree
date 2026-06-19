# webrtc-tree

A lightweight, auto-balancing WebRTC Mesh Tree topology coordinator and client for scalable peer-to-peer live streaming.

## Overview

In traditional P2P mesh networks, every peer connects to every other peer, causing an $O(N^2)$ bandwidth explosion. 
`webrtc-tree` solves this by organizing peers into a **Breadth-First Search (BFS) Tree topology**. 

By defining maximum capacities per layer (e.g. `[1, 4, 8, 16, 64]`), the tree ensures that the streamer only sends data to a handful of direct children, who then act as relay nodes to forward the stream to the next layer. 

### Features
- 🌲 **Auto-Balancing**: Viewers are automatically assigned to the shallowest available node to minimize latency.
- 🔄 **Self-Healing**: If a parent node disconnects, its children automatically report the failure and reconnect to a new branch.
- 📦 **Dual Ecosystem**: Includes a lightweight Node.js Server coordinator and a browser-ready WebRTC Client.
- 🦾 **TypeScript Native**: Full type-safety right out of the box.

---

## Installation

```bash
npm install webrtc-tree
```

---

## Usage

### 1. Server-Side (Node.js)
The server acts as a pure-logic state coordinator. It keeps track of the topology without ever touching the actual video streams.

```typescript
import { RTCTreeCoordinator } from 'webrtc-tree/server';

const coordinator = new RTCTreeCoordinator();

const ROOM_ID = 'live-room-1';
const STREAMER_ID = 'streamer-peer-id';

// Configure max nodes per layer:
// Streamer (Layer 0) connects to max 4 viewers (Layer 1).
// Layer 1 connects to max 8 viewers (Layer 2).
const topologyConfig = { maxNodesPerLayer: [1, 4, 8, 16, 64] };

// Initialize room
coordinator.createRoom(ROOM_ID, STREAMER_ID, topologyConfig);

// When a new viewer joins, get their designated parent ID
const viewerId = 'viewer-peer-123';
const assignedParentId = coordinator.joinNode(ROOM_ID, viewerId);

// If a viewer disconnects, report it to self-heal the tree
coordinator.reportDeadNode(ROOM_ID, viewerId);
```

### 2. Client-Side (Browser)
The client wraps `PeerJS` to handle the actual WebRTC media transmission.

#### For the Streamer
```typescript
import { RTCTreeClient } from 'webrtc-tree/client';

const client = new RTCTreeClient({
  onStatusChange: (status) => console.log(status),
  onError: (err) => console.error(err)
});

// Assuming you have the local camera stream
const myStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

// Initialize as the root streamer (Layer 0)
// Max direct children = 4
const streamerPeerId = await client.initStreamer(myStream, 4);
console.log("Streamer is live with Peer ID:", streamerPeerId);
```

#### For the Viewer
```typescript
import { RTCTreeClient } from 'webrtc-tree/client';

const client = new RTCTreeClient({
  // Function to ask your Node.js backend for a parent node
  fetchParentIdFn: async () => {
    const res = await fetch('/api/get-parent');
    const data = await res.json();
    return data.parentId;
  },
  // Function to report a dead node to your backend
  reportDeadFn: async (deadId) => {
    await fetch('/api/report-dead', { method: 'POST', body: JSON.stringify({ deadId }) });
  },
  // Fired when the stream is successfully received or re-connected
  onStreamReceived: (stream) => {
    const videoElement = document.getElementById('remoteVideo');
    videoElement.srcObject = stream;
    videoElement.play();
  },
  onStatusChange: (status) => console.log("Status:", status)
});

// Initialize as a viewer relay node
// Max relay children = 2 (Depends on your layer config)
await client.initViewer(2);
```

---

## Architecture Pattern (Microservice)
For the best scalability, it is highly recommended to deploy the `webrtc-tree/server` logic as a standalone Node.js microservice (e.g., using WebSockets or REST). Your main backend (Python, Go, etc.) can focus on business logic while this service purely orchestrates WebRTC routing.

## License
ISC
