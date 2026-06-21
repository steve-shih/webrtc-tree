export interface RTCTreeNode {
  children: string[];
  parent: string | null;
  layer: number;
  pingMs?: number;
  bitrateKbps?: number;
  joinedAt: number;
}

export interface RoomConfig {
  maxNodesPerLayer: number[]; // e.g. [1, 4, 8, 16, 64]
  baseDelayMs?: number;       
  layerDelayMs?: number;      
  autoBalanceStrategy?: 'chronological' | 'quality'; // Default: chronological
  autoBalanceIntervalMs?: number; 
}

export interface LayerStats {
  averagePing: number;
  averageBitrate: number;
  nodeCount: number;
}

export class RTCTreeCoordinator {
  private trees: Record<string, Record<string, RTCTreeNode>> = {};
  private configs: Record<string, RoomConfig> = {};
  private timers: Record<string, any> = {};

  // For backend to know who to notify for SYS_RECONNECT
  public onPeersNeedReconnect?: (roomId: string, peerIds: string[]) => void;

  public createRoom(roomId: string, streamerPeerId: string, config: RoomConfig): void {
    this.configs[roomId] = {
      baseDelayMs: 1000,
      layerDelayMs: 300,
      autoBalanceStrategy: 'chronological',
      autoBalanceIntervalMs: 10000,
      ...config
    };
    
    this.trees[roomId] = {};
    this.trees[roomId][streamerPeerId] = { 
      children: [], 
      parent: null, 
      layer: 0, 
      pingMs: 0, 
      bitrateKbps: 0,
      joinedAt: Date.now()
    };

    if (this.configs[roomId].autoBalanceStrategy === 'quality' && this.configs[roomId].autoBalanceIntervalMs) {
      this.startAutoBalance(roomId);
    }
  }

  private startAutoBalance(roomId: string) {
    if (this.timers[roomId]) clearInterval(this.timers[roomId]);
    
    const interval = this.configs[roomId].autoBalanceIntervalMs || 10000;
    this.timers[roomId] = setInterval(() => {
      this.evaluateAndBalance(roomId);
    }, interval);
  }

  public getAssignedParent(roomId: string, peerId: string): string | null {
    const tree = this.trees[roomId];
    if (tree && tree[peerId] && tree[peerId].parent) {
      return tree[peerId].parent; // Return pre-assigned/promoted parent
    }
    return this.joinNode(roomId, peerId); // Fallback to BFS
  }

  public joinNode(roomId: string, newPeerId: string): string | null {
    const tree = this.trees[roomId];
    const config = this.configs[roomId];
    if (!tree || !config) return null;

    let rootId: string | null = null;
    for (const [id, node] of Object.entries(tree)) {
      if (node.layer === 0) {
        rootId = id;
        break;
      }
    }

    if (!rootId) return null;

    if (tree[newPeerId]) {
      // Clean up previous position cleanly without triggering promotion
      const oldParent = tree[newPeerId].parent;
      if (oldParent && tree[oldParent]) {
         tree[oldParent].children = tree[oldParent].children.filter(id => id !== newPeerId);
      }
      for(const child of tree[newPeerId].children) {
         if(tree[child]) tree[child].parent = null;
      }
      delete tree[newPeerId];
    }

    const layerCounts: Record<number, number> = {};
    for (const node of Object.values(tree)) {
      layerCounts[node.layer] = (layerCounts[node.layer] || 0) + 1;
    }

    const queue: string[] = [rootId];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentNode = tree[currentId];
      const currentLayer = currentNode.layer;
      
      const nextLayer = currentLayer + 1;

      if (nextLayer >= config.maxNodesPerLayer.length) {
        queue.push(...currentNode.children);
        continue;
      }

      const nextLayerMax = config.maxNodesPerLayer[nextLayer];
      const currentNextLayerCount = layerCounts[nextLayer] || 0;

      if (currentNextLayerCount >= nextLayerMax) {
        queue.push(...currentNode.children);
        continue;
      }

      const currentLayerMax = config.maxNodesPerLayer[currentLayer];
      const maxChildrenPerNode = Math.floor(nextLayerMax / currentLayerMax) || 1;

      if (currentNode.children.length < maxChildrenPerNode) {
        currentNode.children.push(newPeerId);
        tree[newPeerId] = {
          children: [],
          parent: currentId,
          layer: nextLayer,
          pingMs: 0,
          bitrateKbps: 0,
          joinedAt: Date.now()
        };
        return currentId;
      }

      queue.push(...currentNode.children);
    }

    return null;
  }

  public removeNode(roomId: string, deadPeerId: string): void {
    const tree = this.trees[roomId];
    const config = this.configs[roomId];
    if (!tree || !config) return;

    const deadNode = tree[deadPeerId];
    if (!deadNode) return;

    let promotedChildId: string | null = null;

    if (config.autoBalanceStrategy === 'quality' && deadNode.children.length > 0) {
      // Mode 2: Quality - Find best child to replace
      let bestChild = deadNode.children[0];
      let bestScore = Infinity; 
      
      for (const childId of deadNode.children) {
        const child = tree[childId];
        if (!child) continue;
        const score = this.calculateNodeScore(child);
        if (score < bestScore) {
          bestScore = score;
          bestChild = childId;
        }
      }
      promotedChildId = bestChild;
    }

    const parentId = deadNode.parent;

    if (promotedChildId) {
      const promotedNode = tree[promotedChildId];
      
      // Update promoted node
      promotedNode.parent = parentId;
      promotedNode.layer = deadNode.layer;
      
      // Re-link parent to promoted child
      if (parentId && tree[parentId]) {
        tree[parentId].children = tree[parentId].children.filter(id => id !== deadPeerId);
        tree[parentId].children.push(promotedChildId);
      }
      
      // Siblings become children of the promoted node
      const otherChildren = deadNode.children.filter(id => id !== promotedChildId);
      promotedNode.children.push(...otherChildren);
      
      for (const childId of otherChildren) {
        if (tree[childId]) {
          tree[childId].parent = promotedChildId;
        }
      }
    } else {
      // Mode 1: Chronological OR no children - normal disconnect
      if (parentId && tree[parentId]) {
        tree[parentId].children = tree[parentId].children.filter(id => id !== deadPeerId);
      }
      for (const childId of deadNode.children) {
        if (tree[childId]) {
          tree[childId].parent = null; 
        }
      }
    }

    delete tree[deadPeerId];
  }

  public reportDeadNode(roomId: string, deadPeerId: string): void {
    this.removeNode(roomId, deadPeerId);
  }

  public reportStats(roomId: string, peerId: string, ping: number, bitrate: number): void {
    const tree = this.trees[roomId];
    if (tree && tree[peerId]) {
      tree[peerId].pingMs = ping;
      tree[peerId].bitrateKbps = bitrate;
    }
  }

  private calculateNodeScore(node: RTCTreeNode): number {
    // Lower score is better. Ping matters more, High bitrate lowers score.
    return (node.pingMs || 50) - ((node.bitrateKbps || 0) / 10);
  }

  public evaluateAndBalance(roomId: string): void {
    const tree = this.trees[roomId];
    const config = this.configs[roomId];
    if (!tree || !config || config.autoBalanceStrategy !== 'quality') return;

    // Group nodes by layer
    const layerGroups: Record<number, string[]> = {};
    for (const [id, node] of Object.entries(tree)) {
      if (!layerGroups[node.layer]) layerGroups[node.layer] = [];
      layerGroups[node.layer].push(id);
    }

    const layers = Object.keys(layerGroups).map(Number).sort((a, b) => a - b);
    const swappedPeers: string[] = [];

    // Compare layer N with layer N+1
    for (let i = 0; i < layers.length - 1; i++) {
      const currentLayer = layers[i];
      const nextLayer = layers[i + 1];
      
      if (currentLayer === 0) continue; // Skip streamer

      const currentNodes = layerGroups[currentLayer];
      const nextNodes = layerGroups[nextLayer];

      // Find worst node in current layer
      let worstCurrentNode = currentNodes[0];
      let worstScore = -Infinity;
      for (const id of currentNodes) {
        const score = this.calculateNodeScore(tree[id]);
        if (score > worstScore) {
          worstScore = score;
          worstCurrentNode = id;
        }
      }

      // Find best node in next layer
      let bestNextNode = nextNodes[0];
      let bestScore = Infinity;
      for (const id of nextNodes) {
        const score = this.calculateNodeScore(tree[id]);
        if (score < bestScore) {
          bestScore = score;
          bestNextNode = id;
        }
      }

      // If the node in the lower layer is significantly better than the node in upper layer
      if (worstScore - bestScore > 20) {
        const success = this.swapNodes(roomId, worstCurrentNode, bestNextNode);
        if (success) {
          swappedPeers.push(worstCurrentNode, bestNextNode);
        }
      }
    }

    if (swappedPeers.length > 0 && this.onPeersNeedReconnect) {
      this.onPeersNeedReconnect(roomId, swappedPeers);
    }
  }

  public swapNodes(roomId: string, peerA: string, peerB: string): boolean {
    const tree = this.trees[roomId];
    if (!tree || !tree[peerA] || !tree[peerB]) return false;
    if (tree[peerA].layer === 0 || tree[peerB].layer === 0) return false;

    const nodeA = tree[peerA];
    const nodeB = tree[peerB];

    if (nodeA.parent === peerB || nodeB.parent === peerA) return false;

    const parentA = nodeA.parent;
    const parentB = nodeB.parent;

    if (parentA && tree[parentA]) {
      tree[parentA].children = tree[parentA].children.map(id => id === peerA ? peerB : id);
    }
    if (parentB && tree[parentB]) {
      tree[parentB].children = tree[parentB].children.map(id => id === peerB ? peerA : id);
    }

    nodeA.parent = parentB;
    nodeB.parent = parentA;

    const childrenA = [...nodeA.children];
    const childrenB = [...nodeB.children];

    nodeA.children = childrenB;
    nodeB.children = childrenA;

    for (const childId of childrenB) {
      if (tree[childId]) tree[childId].parent = peerA;
    }
    for (const childId of childrenA) {
      if (tree[childId]) tree[childId].parent = peerB;
    }

    const layerA = nodeA.layer;
    nodeA.layer = nodeB.layer;
    nodeB.layer = layerA;

    return true;
  }

  public getTreeObject(roomId: string): any {
    const tree = this.trees[roomId];
    if (!tree) return null;

    let rootId: string | null = null;
    for (const [id, node] of Object.entries(tree)) {
      if (node.layer === 0) {
        rootId = id;
        break;
      }
    }

    if (!rootId) return null;

    const buildNode = (id: string): any => {
      const node = tree[id];
      if (!node) return null;

      const children = node.children.map(childId => buildNode(childId)).filter(Boolean);
      
      return {
        id,
        layer: node.layer,
        pingMs: node.pingMs,
        bitrateKbps: node.bitrateKbps,
        children: children.length > 0 ? children : undefined
      };
    };

    return buildNode(rootId);
  }
  
  public getTree(roomId: string): Record<string, RTCTreeNode> | null {
    return this.trees[roomId] || null;
  }
  
  /**
   * 取得目前房間的總節點數
   */
  public getTotalNodes(roomId: string): number {
    const tree = this.trees[roomId];
    if (!tree) return 0;
    return Object.keys(tree).length;
  }
  
  public getLayerStats(roomId: string, layer: number): LayerStats | null {
    const tree = this.trees[roomId];
    if (!tree) return null;

    let totalPing = 0;
    let totalBitrate = 0;
    let count = 0;

    for (const node of Object.values(tree)) {
      if (node.layer === layer) {
        totalPing += (node.pingMs || 0);
        totalBitrate += (node.bitrateKbps || 0);
        count++;
      }
    }

    if (count === 0) return { averagePing: 0, averageBitrate: 0, nodeCount: 0 };
    return {
      averagePing: totalPing / count,
      averageBitrate: totalBitrate / count,
      nodeCount: count
    };
  }

  public getNodeExpectedDelay(roomId: string, peerId: string): number {
    const tree = this.trees[roomId];
    const config = this.configs[roomId];
    if (!tree || !config || !tree[peerId]) return 0;
    
    const layer = tree[peerId].layer;
    const base = config.baseDelayMs || 0;
    const layerDelay = config.layerDelayMs || 0;
    
    return base + (layer * layerDelay);
  }
  
  public destroy(roomId: string) {
    if (this.timers[roomId]) {
      clearInterval(this.timers[roomId]);
      delete this.timers[roomId];
    }
    delete this.trees[roomId];
    delete this.configs[roomId];
  }
}
