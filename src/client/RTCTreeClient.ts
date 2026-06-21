import Peer, { MediaConnection } from 'peerjs';

export interface RTCTreeClientOptions {
  onStreamReceived?: (stream: MediaStream) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: any) => void;
  fetchParentIdFn?: () => Promise<string | null>; // Client uses this to ask Server for a parent
  reportDeadFn?: (deadPeerId: string) => Promise<void>; // Client uses this to tell Server a node is dead
  reportStatsFn?: (pingMs: number, bitrateKbps: number) => Promise<void>; // Report stats
  onDelayConfigured?: (expectedDelayMs: number) => void; // Triggered when server defines delay
  statsIntervalMs?: number; // Default 5000ms
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
  private expectedDelayMs: number = 0;
  
  private statsTimer: any = null;

  constructor(private options: RTCTreeClientOptions) {
    if (!this.options.statsIntervalMs) {
      this.options.statsIntervalMs = 5000;
    }
  }

  /**
   * 初始化為直播主 (Streamer)
   */
  public initStreamer(stream: MediaStream, maxChildren: number = 4): Promise<string> {
    this.isStreamer = true;
    this.myStream = stream;
    this.expectedDelayMs = 0;
    this.options.onDelayConfigured?.(this.expectedDelayMs);

    return new Promise((resolve, reject) => {
      this.peer = new Peer();

      this.peer.on('open', (id) => {
        this.myPeerId = id;
        this.options.onStatusChange?.("直播已開始");
        this.startStatsReporting();
        resolve(id);
      });

      this.peer.on('error', (err) => {
        this.options.onError?.(err);
        reject(err);
      });

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
   */
  public initViewer(maxChildren: number = 4, expectedDelayMs: number = 1000): Promise<string> {
    this.isStreamer = false;
    this.expectedDelayMs = expectedDelayMs;
    this.options.onDelayConfigured?.(this.expectedDelayMs);

    return new Promise((resolve, reject) => {
      this.peer = new Peer();

      this.peer.on('open', async (id) => {
        this.myPeerId = id;
        this.options.onStatusChange?.("正在分配節點...");
        resolve(id);
        
        await this.connectToMesh();
        this.startStatsReporting();
      });

      this.peer.on('error', (err) => {
        this.options.onError?.(err);
        reject(err);
      });

      this.peer.on('connection', (conn) => {
        conn.on('data', (data: any) => {
          if (data === 'VIEWER_READY') {
            if (Object.keys(this.activeCalls).length < maxChildren && this.myStream) {
              // 注意：當前層若有 delay，傳遞給下一層的 Stream 是不受前端 delay 影響的原始 stream
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
          this.handleParentDisconnect(call.peer);
        });
      });
    });
  }

  /**
   * 設定目前的期望延遲 (由外部或伺服器呼叫)
   */
  public setExpectedDelay(delayMs: number): void {
    this.expectedDelayMs = delayMs;
    this.options.onDelayConfigured?.(this.expectedDelayMs);
  }

  /**
   * 取得目前的期望延遲
   */
  public getExpectedDelay(): number {
    return this.expectedDelayMs;
  }

  private async connectToMesh(): Promise<void> {
    if (!this.options.fetchParentIdFn) {
      throw new Error("fetchParentIdFn is required for viewers");
    }

    try {
      const targetPeerId = await this.options.fetchParentIdFn();
      if (!targetPeerId) {
        this.options.onStatusChange?.("暫無可用節點，請稍後重試");
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

    setTimeout(async () => {
      this.isReconnecting = false;
      await this.connectToMesh();
    }, 2000);
  }

  private startStatsReporting() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    
    this.statsTimer = setInterval(() => {
      if (!this.options.reportStatsFn || !this.parentConnection?.peerConnection) return;
      
      const pc = this.parentConnection.peerConnection;
      pc.getStats().then(stats => {
        let currentPing = 50; // Mock base or use stats if available
        let currentBitrate = 0;
        
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            // Simplified calculation for demo purposes
            currentBitrate = (report.bytesReceived || 0) * 8 / 1000; // kbps total (needs delta in real impl)
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
             currentPing = report.currentRoundTripTime ? report.currentRoundTripTime * 1000 : 50;
          }
        });
        
        this.options.reportStatsFn!(currentPing, currentBitrate).catch(console.error);
      });
    }, this.options.statsIntervalMs);
  }

  public destroy() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }
}
