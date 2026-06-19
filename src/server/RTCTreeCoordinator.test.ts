import { RTCTreeCoordinator } from './RTCTreeCoordinator';

describe('RTCTreeCoordinator', () => {
  let coordinator: RTCTreeCoordinator;
  const roomId = 'test-room';
  const streamerId = 'peer-streamer';

  beforeEach(() => {
    coordinator = new RTCTreeCoordinator();
  });

  test('should create a room and streamer should be at layer 0', () => {
    coordinator.createRoom(roomId, streamerId, { maxNodesPerLayer: [1, 4, 8, 16] });
    const tree = coordinator.getTree(roomId);
    expect(tree).toBeDefined();
    expect(tree![streamerId]).toBeDefined();
    expect(tree![streamerId].layer).toBe(0);
    expect(tree![streamerId].children.length).toBe(0);
  });

  test('should distribute viewers according to maxNodesPerLayer [1, 4, 8]', () => {
    // 1 Streamer
    // Layer 1: Max 4
    // Layer 2: Max 8 (each Layer 1 node handles 2 children)
    coordinator.createRoom(roomId, streamerId, { maxNodesPerLayer: [1, 4, 8] });

    // Join 4 viewers
    for (let i = 1; i <= 4; i++) {
      const parent = coordinator.joinNode(roomId, `peer-v${i}`);
      expect(parent).toBe(streamerId);
    }

    const tree = coordinator.getTree(roomId);
    expect(tree![streamerId].children.length).toBe(4);

    // Join 5th viewer, should go to layer 2
    const parent5 = coordinator.joinNode(roomId, `peer-v5`);
    expect(parent5).not.toBe(streamerId);
    expect(['peer-v1', 'peer-v2', 'peer-v3', 'peer-v4']).toContain(parent5);

    // Join up to 12 total viewers (4 in L1, 8 in L2)
    for (let i = 6; i <= 12; i++) {
      coordinator.joinNode(roomId, `peer-v${i}`);
    }

    // Now L1 has 4 nodes, L2 has 8 nodes. Total 13 nodes (including streamer)
    const treeState = coordinator.getTree(roomId)!;
    let l1Count = 0;
    let l2Count = 0;
    for (const node of Object.values(treeState)) {
      if (node.layer === 1) l1Count++;
      if (node.layer === 2) l2Count++;
    }
    expect(l1Count).toBe(4);
    expect(l2Count).toBe(8);

    // Join 13th viewer. Tree should be FULL because config only specifies up to L2 (maxNodesPerLayer length is 3)
    const parent13 = coordinator.joinNode(roomId, 'peer-v13');
    expect(parent13).toBeNull();
  });

  test('should self-heal when a node is removed', () => {
    coordinator.createRoom(roomId, streamerId, { maxNodesPerLayer: [1, 4] });
    coordinator.joinNode(roomId, 'peer-v1');
    coordinator.joinNode(roomId, 'peer-v2');

    let tree = coordinator.getTree(roomId)!;
    expect(tree[streamerId].children).toEqual(['peer-v1', 'peer-v2']);

    // Remove v1
    coordinator.reportDeadNode(roomId, 'peer-v1');
    tree = coordinator.getTree(roomId)!;

    expect(tree['peer-v1']).toBeUndefined();
    expect(tree[streamerId].children).toEqual(['peer-v2']);

    // Re-join v1 (simulate reconnection)
    const parent = coordinator.joinNode(roomId, 'peer-v1');
    expect(parent).toBe(streamerId);
    tree = coordinator.getTree(roomId)!;
    expect(tree[streamerId].children).toEqual(['peer-v2', 'peer-v1']);
  });
});
