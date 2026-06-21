export interface RTCTreeNode {
  children: string[];
  parent: string | null;
  layer: number;
  pingMs?: number;
  bitrateKbps?: number;
}

export interface RoomConfig {
  maxNodesPerLayer: number[]; // e.g. [1, 4, 8, 16, 64]
  baseDelayMs?: number;       // 基礎延遲
  layerDelayMs?: number;      // 每一層遞增的延遲
}

export interface LayerStats {
  averagePing: number;
  averageBitrate: number;
  nodeCount: number;
}

export class RTCTreeCoordinator {
  // roomId -> peerId -> Node Data
  private trees: Record<string, Record<string, RTCTreeNode>> = {};
  private configs: Record<string, RoomConfig> = {};

  /**
   * 建立一個新的直播房間拓撲結構
   * @param roomId 房間 ID
   * @param streamerPeerId 直播主的 Peer ID
   * @param config 拓撲設定
   */
  public createRoom(roomId: string, streamerPeerId: string, config: RoomConfig): void {
    this.configs[roomId] = {
      baseDelayMs: 1000,
      layerDelayMs: 300,
      ...config
    };
    this.trees[roomId] = {};
    // Streamer is at layer 0
    this.trees[roomId][streamerPeerId] = { children: [], parent: null, layer: 0, pingMs: 0, bitrateKbps: 0 };
  }

  /**
   * 新節點加入，透過 BFS 分配最合適的父節點
   */
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
      this.removeNode(roomId, newPeerId);
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
          bitrateKbps: 0
        };
        return currentId;
      }

      queue.push(...currentNode.children);
    }

    return null;
  }

  /**
   * 節點斷線，將其從樹中移除，並讓其子節點變成孤兒
   */
  public removeNode(roomId: string, deadPeerId: string): void {
    const tree = this.trees[roomId];
    if (!tree) return;

    const deadNode = tree[deadPeerId];
    if (!deadNode) return;

    if (deadNode.parent && tree[deadNode.parent]) {
      const parentNode = tree[deadNode.parent];
      parentNode.children = parentNode.children.filter(id => id !== deadPeerId);
    }

    for (const childId of deadNode.children) {
      if (tree[childId]) {
        tree[childId].parent = null;
      }
    }

    delete tree[deadPeerId];
  }

  public reportDeadNode(roomId: string, deadPeerId: string): void {
    this.removeNode(roomId, deadPeerId);
  }

  /**
   * 回報節點的網路速度與延遲
   */
  public reportStats(roomId: string, peerId: string, ping: number, bitrate: number): void {
    const tree = this.trees[roomId];
    if (tree && tree[peerId]) {
      tree[peerId].pingMs = ping;
      tree[peerId].bitrateKbps = bitrate;
    }
  }

  /**
   * 取得某一層的平均網路品質
   */
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

  /**
   * 計算該節點的預期延遲 (Base Delay + Layer * Layer Delay)
   */
  public getNodeExpectedDelay(roomId: string, peerId: string): number {
    const tree = this.trees[roomId];
    const config = this.configs[roomId];
    if (!tree || !config || !tree[peerId]) return 0;
    
    const layer = tree[peerId].layer;
    const base = config.baseDelayMs || 0;
    const layerDelay = config.layerDelayMs || 0;
    
    return base + (layer * layerDelay);
  }

  /**
   * 兩點交換 (Swap Nodes)
   * 用於將網路優良的節點移至上層，或是將不穩定的節點降級。
   */
  public swapNodes(roomId: string, peerA: string, peerB: string): boolean {
    const tree = this.trees[roomId];
    if (!tree || !tree[peerA] || !tree[peerB]) return false;

    // 不允許交換 Root (Streamer layer 0)
    if (tree[peerA].layer === 0 || tree[peerB].layer === 0) return false;

    const nodeA = tree[peerA];
    const nodeB = tree[peerB];

    // 如果是直系血親 (A是B的父或 B是A的父)，直接交換會導致循環參照或邏輯複雜化
    // 這裡實作簡單版本：只交換同級或非直系節點的位置
    if (nodeA.parent === peerB || nodeB.parent === peerA) {
      // 若為直系，因為時間有限，暫時返回 false，實務上可實作父子互換
      return false; 
    }

    // 1. 交換 parent 指標
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

    // 2. 交換 children 指標 (包含將孩子們的 parent 指向新的父親)
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

    // 3. 交換 layer
    const layerA = nodeA.layer;
    nodeA.layer = nodeB.layer;
    nodeB.layer = layerA;

    return true;
  }

  /**
   * 取得房間目前的樹狀結構扁平紀錄
   */
  public getTree(roomId: string): Record<string, RTCTreeNode> | null {
    return this.trees[roomId] || null;
  }

  /**
   * 取得房間嵌套式的樹狀物件 (Nested Object)，方便前端視覺化套件渲染
   */
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
}
