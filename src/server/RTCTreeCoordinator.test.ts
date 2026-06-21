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
    coordinator.createRoom(roomId, streamerId, { maxNodesPerLayer: [1, 4, 8] });

    for (let i = 1; i <= 4; i++) {
      const parent = coordinator.joinNode(roomId, `peer-v${i}`);
      expect(parent).toBe(streamerId);
    }

    const tree = coordinator.getTree(roomId);
    expect(tree![streamerId].children.length).toBe(4);

    const parent5 = coordinator.joinNode(roomId, `peer-v5`);
    expect(parent5).not.toBe(streamerId);
    expect(['peer-v1', 'peer-v2', 'peer-v3', 'peer-v4']).toContain(parent5);

    for (let i = 6; i <= 12; i++) {
      coordinator.joinNode(roomId, `peer-v${i}`);
    }

    const treeState = coordinator.getTree(roomId)!;
    let l1Count = 0;
    let l2Count = 0;
    for (const node of Object.values(treeState)) {
      if (node.layer === 1) l1Count++;
      if (node.layer === 2) l2Count++;
    }
    expect(l1Count).toBe(4);
    expect(l2Count).toBe(8);

    const parent13 = coordinator.joinNode(roomId, 'peer-v13');
    expect(parent13).toBeNull();
  });

  test('should self-heal when a node is removed', () => {
    coordinator.createRoom(roomId, streamerId, { maxNodesPerLayer: [1, 4] });
    coordinator.joinNode(roomId, 'peer-v1');
    coordinator.joinNode(roomId, 'peer-v2');

    let tree = coordinator.getTree(roomId)!;
    expect(tree[streamerId].children).toEqual(['peer-v1', 'peer-v2']);

    coordinator.reportDeadNode(roomId, 'peer-v1');
    tree = coordinator.getTree(roomId)!;

    expect(tree['peer-v1']).toBeUndefined();
    expect(tree[streamerId].children).toEqual(['peer-v2']);

    const parent = coordinator.joinNode(roomId, 'peer-v1');
    expect(parent).toBe(streamerId);
    tree = coordinator.getTree(roomId)!;
    expect(tree[streamerId].children).toEqual(['peer-v2', 'peer-v1']);
  });

  test('should swap non-direct nodes successfully', () => {
    coordinator.createRoom(roomId, streamerId, { maxNodesPerLayer: [1, 2, 4] });
    coordinator.joinNode(roomId, 'peer-v1'); // Layer 1
    coordinator.joinNode(roomId, 'peer-v2'); // Layer 1
    coordinator.joinNode(roomId, 'peer-v3'); // Layer 2 (child of v1)

    const result = coordinator.swapNodes(roomId, 'peer-v2', 'peer-v3');
    expect(result).toBe(true);

    const tree = coordinator.getTree(roomId)!;
    // v3 應該變成 layer 1 (child of streamer)
    expect(tree['peer-v3'].layer).toBe(1);
    expect(tree['peer-v3'].parent).toBe(streamerId);
    // v2 應該變成 layer 2 (child of v1)
    expect(tree['peer-v2'].layer).toBe(2);
    expect(tree['peer-v2'].parent).toBe('peer-v1');
  });

  test('should return proper nested tree object', () => {
    coordinator.createRoom(roomId, streamerId, { maxNodesPerLayer: [1, 2] });
    coordinator.joinNode(roomId, 'peer-v1');
    coordinator.reportStats(roomId, 'peer-v1', 10, 500);

    const obj = coordinator.getTreeObject(roomId);
    expect(obj.id).toBe(streamerId);
    expect(obj.children.length).toBe(1);
    expect(obj.children[0].id).toBe('peer-v1');
    expect(obj.children[0].pingMs).toBe(10);
    expect(obj.children[0].bitrateKbps).toBe(500);
  });
});
