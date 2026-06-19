export interface RTCTreeNode {
  children: string[];
  parent: string | null;
  layer: number;
}

export interface RoomConfig {
  maxNodesPerLayer: number[]; // e.g. [1, 4, 8, 16, 64]
}

export class RTCTreeCoordinator {
  // roomId -> peerId -> Node Data
  private trees: Record<string, Record<string, RTCTreeNode>> = {};
  private configs: Record<string, RoomConfig> = {};

  /**
   * 建立一個新的直播房間拓撲結構
   * @param roomId 房間 ID
   * @param streamerPeerId 直播主的 Peer ID
   * @param config 拓撲設定，例如 maxNodesPerLayer: [1, 4, 8, 16, 64]
   */
  public createRoom(roomId: string, streamerPeerId: string, config: RoomConfig): void {
    this.configs[roomId] = config;
    this.trees[roomId] = {};
    // Streamer is at layer 0
    this.trees[roomId][streamerPeerId] = { children: [], parent: null, layer: 0 };
  }

  /**
   * 新節點加入，透過 BFS 分配最合適的父節點
   * @param roomId 房間 ID
   * @param newPeerId 新節點的 Peer ID
   * @returns 分配到的父節點 Peer ID，若無法分配則回傳 null
   */
  public joinNode(roomId: string, newPeerId: string): string | null {
    const tree = this.trees[roomId];
    const config = this.configs[roomId];
    if (!tree || !config) return null;

    // 尋找樹根 (layer 0 的節點，通常是 streamer)
    let rootId: string | null = null;
    for (const [id, node] of Object.entries(tree)) {
      if (node.layer === 0) {
        rootId = id;
        break;
      }
    }

    if (!rootId) return null;

    // 如果該節點已經在樹中，先將其從原本的位置移除 (防止重複加入或狀態不一致)
    if (tree[newPeerId]) {
      this.removeNode(roomId, newPeerId);
    }

    // 計算目前每一層的總節點數
    const layerCounts: Record<number, number> = {};
    for (const node of Object.values(tree)) {
      layerCounts[node.layer] = (layerCounts[node.layer] || 0) + 1;
    }

    // BFS 尋找未滿載的節點
    const queue: string[] = [rootId];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentNode = tree[currentId];
      const currentLayer = currentNode.layer;
      
      // 下一層的索引
      const nextLayer = currentLayer + 1;

      // 如果已經達到最大層數設定，該節點不能再有子節點
      if (nextLayer >= config.maxNodesPerLayer.length) {
        // Continue searching in queue
        queue.push(...currentNode.children);
        continue;
      }

      // 檢查下一層是否已經達到整體上限
      const nextLayerMax = config.maxNodesPerLayer[nextLayer];
      const currentNextLayerCount = layerCounts[nextLayer] || 0;

      if (currentNextLayerCount >= nextLayerMax) {
        // 下一層已經滿了，把目前節點的子節點加入 queue 繼續尋找更下層
        queue.push(...currentNode.children);
        continue;
      }

      // 如果下一層還沒滿，那我們要決定「目前這個節點」還能不能接客
      // 算法：該層平均每個節點可以接的子節點數
      // 例如 layer 1 最大 4 人，layer 2 最大 8 人，代表 layer 1 每個節點最多接 8/4 = 2 人
      const currentLayerMax = config.maxNodesPerLayer[currentLayer];
      const maxChildrenPerNode = Math.floor(nextLayerMax / currentLayerMax) || 1;

      if (currentNode.children.length < maxChildrenPerNode) {
        // 找到可以接客的節點了！
        currentNode.children.push(newPeerId);
        tree[newPeerId] = {
          children: [],
          parent: currentId,
          layer: nextLayer
        };
        return currentId;
      }

      // 目前節點滿了，把它的小孩加進 queue
      queue.push(...currentNode.children);
    }

    return null; // 樹已滿或無法分配
  }

  /**
   * 節點斷線，將其從樹中移除，並讓其子節點變成孤兒 (等待重新 join)
   */
  public removeNode(roomId: string, deadPeerId: string): void {
    const tree = this.trees[roomId];
    if (!tree) return;

    const deadNode = tree[deadPeerId];
    if (!deadNode) return;

    // 將自己從父節點的 children 中移除
    if (deadNode.parent && tree[deadNode.parent]) {
      const parentNode = tree[deadNode.parent];
      parentNode.children = parentNode.children.filter(id => id !== deadPeerId);
    }

    // 將子節點的 parent 設為 null (它們需要重新連線)
    for (const childId of deadNode.children) {
      if (tree[childId]) {
        tree[childId].parent = null;
      }
    }

    delete tree[deadPeerId];
  }

  /**
   * 報告節點失效 (Self-Healing 觸發點)
   */
  public reportDeadNode(roomId: string, deadPeerId: string): void {
    this.removeNode(roomId, deadPeerId);
  }

  /**
   * 取得房間目前的樹狀結構 (For Debug/Monitor)
   */
  public getTree(roomId: string): Record<string, RTCTreeNode> | null {
    return this.trees[roomId] || null;
  }
}
