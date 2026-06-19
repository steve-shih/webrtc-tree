import Peer, { MediaConnection } from 'peerjs';

export interface RTCTreeClientOptions {
  onStreamReceived?: (stream: MediaStream) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: any) => void;
  fetchParentIdFn?: () => Promise<string | null>; // Client uses this to ask Server for a parent
  reportDeadFn?: (deadPeerId: string) => Promise<void>; // Client uses this to tell Server a node is dead
}

export class RTCTreeClient {
  private peer: Peer | null = null;
  private myPeerId: string | null = null;
  private myStream: MediaStream | null = null;
  private activeCalls: Record<string, MediaConnection> = {};
  private parentConnection: MediaConnection | null = null;
  
  // State
  private isStreamer: boolean = false;
  private isReconnecting: boolean = false;

  constructor(private options: RTCTreeClientOptions) {}

  /**
   * 初始化為直播主 (Streamer)
   * @param stream 本地攝影機/麥克風的 MediaStream
   * @param maxChildren 第一層最大觀眾數 (Layer 1 Capacity)
   * @returns 建立完成後的 Peer ID
   */
  public initStreamer(stream: MediaStream, maxChildren: number = 4): Promise<string> {
    this.isStreamer = true;
    this.myStream = stream;

    return new Promise((resolve, reject) => {
      this.peer = new Peer();

      this.peer.on('open', (id) => {
        this.myPeerId = id;
        this.options.onStatusChange?.("直播已開始");
        resolve(id);
      });

      this.peer.on('error', (err) => {
        this.options.onError?.(err);
        reject(err);
      });

      // 監聽觀眾連線請求
      this.peer.on('connection', (conn) => {
        conn.on('data', (data: any) => {
          if (data === 'VIEWER_READY') {
            if (Object.keys(this.activeCalls).length < maxChildren) {
              const call = this.peer!.call(conn.peer, this.myStream!);
              this.activeCalls[conn.peer] = call;
            } else {
              conn.send({ type: 'REJECT_FULL' });
            }
          }
        });

        conn.on('close', () => {
          if (this.activeCalls[conn.peer]) {
            this.activeCalls[conn.peer].close();
            delete this.activeCalls[conn.peer];
          }
        });
      });
    });
  }

  /**
   * 初始化為觀眾 (Viewer)
   * @param maxChildren 轉發最大觀眾數 (Layer N Capacity)
   */
  public initViewer(maxChildren: number = 4): Promise<string> {
    this.isStreamer = false;

    return new Promise((resolve, reject) => {
      this.peer = new Peer();

      this.peer.on('open', async (id) => {
        this.myPeerId = id;
        this.options.onStatusChange?.("正在分配節點...");
        resolve(id);
        
        // 開始加入流程
        await this.connectToMesh();
      });

      this.peer.on('error', (err) => {
        this.options.onError?.(err);
        reject(err);
      });

      // 當我們自己也是別人的 parent 時，處理下層觀眾連線
      this.peer.on('connection', (conn) => {
        conn.on('data', (data: any) => {
          if (data === 'VIEWER_READY') {
            if (Object.keys(this.activeCalls).length < maxChildren && this.myStream) {
              const call = this.peer!.call(conn.peer, this.myStream);
              this.activeCalls[conn.peer] = call;
            } else {
              conn.send({ type: 'REJECT_FULL' });
            }
          }
        });

        conn.on('close', () => {
          if (this.activeCalls[conn.peer]) {
            this.activeCalls[conn.peer].close();
            delete this.activeCalls[conn.peer];
          }
        });
      });

      // 接收上層傳來的影像
      this.peer.on('call', (call) => {
        this.options.onStatusChange?.("接收影像中...");
        this.parentConnection = call;
        call.answer(); 
        
        call.on('stream', (remoteStream) => {
          this.myStream = remoteStream;
          this.options.onStatusChange?.(""); 
          this.options.onStreamReceived?.(remoteStream);
        });

        call.on('close', () => {
          // 上層斷線！啟動 Self-Healing
          this.handleParentDisconnect(call.peer);
        });
      });
    });
  }

  private async connectToMesh(): Promise<void> {
    if (!this.options.fetchParentIdFn) {
      throw new Error("fetchParentIdFn is required for viewers");
    }

    try {
      const targetPeerId = await this.options.fetchParentIdFn();
      if (!targetPeerId) {
        this.options.onStatusChange?.("暫無可用節點，請稍後重試");
        // 可以加上 retry 機制
        return;
      }

      this.options.onStatusChange?.("連線中...");
      const conn = this.peer!.connect(targetPeerId);

      const timeoutId = setTimeout(() => {
        conn.close();
        this.handleParentDisconnect(targetPeerId);
      }, 5000);

      conn.on('open', () => {
        clearTimeout(timeoutId);
        conn.send('VIEWER_READY');
      });

      conn.on('data', (data: any) => {
        if (data && data.type === 'REJECT_FULL') {
          clearTimeout(timeoutId);
          conn.close();
          this.handleParentDisconnect(targetPeerId);
        }
      });

      conn.on('close', () => {
        clearTimeout(timeoutId);
        this.handleParentDisconnect(targetPeerId);
      });

      conn.on('error', () => {
        clearTimeout(timeoutId);
        this.handleParentDisconnect(targetPeerId);
      });

    } catch (e) {
      this.options.onStatusChange?.("連線失敗");
      console.error(e);
    }
  }

  private async handleParentDisconnect(deadPeerId: string) {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    this.options.onStatusChange?.("上層節點斷線，重新尋找路徑...");

    if (this.options.reportDeadFn) {
      await this.options.reportDeadFn(deadPeerId).catch(console.error);
    }

    // 延遲一下避免大量 request
    setTimeout(async () => {
      this.isReconnecting = false;
      await this.connectToMesh();
    }, 2000);
  }

  public destroy() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }
}
