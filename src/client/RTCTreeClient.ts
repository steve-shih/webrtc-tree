import Peer, { MediaConnection, DataConnection } from 'peerjs';

export interface RTCTreeClientOptions {
  // Backward compatibility
  onStreamReceived?: (stream: MediaStream) => void;
  
  // Pipeline - Local Render (Incoming)
  onStreamReady?: (stream: MediaStream) => void;
  onIncomingVideo?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onIncomingAudio?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onIncomingData?: (data: any) => void;

  // Pipeline - Forwarding (Outgoing)
  onOutgoingVideo?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onOutgoingAudio?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onOutgoingData?: (data: any) => any | void; // If it returns null/undefined, it filters the data

  // Infrastructure Hooks
  onStatusChange?: (status: string) => void;
  onError?: (error: any) => void;
  fetchParentIdFn?: () => Promise<string | null>;
  reportDeadFn?: (deadPeerId: string) => Promise<void>;
  reportStatsFn?: (pingMs: number, bitrateKbps: number) => Promise<void>;
  onDelayConfigured?: (expectedDelayMs: number) => void;
  statsIntervalMs?: number;
}

export class RTCTreeClient {
  private peer: Peer | null = null;
  private myPeerId: string | null = null;
  
  // Pipeline Streams
  private myRenderStream: MediaStream | null = null;
  private myOutgoingStream: MediaStream | null = null;
  
  // Connections
  private activeMediaCalls: Record<string, MediaConnection> = {};
  private activeDataConns: Record<string, DataConnection> = {};
  private parentMediaConn: MediaConnection | null = null;
  private parentDataConn: DataConnection | null = null;
  
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
   * Pipeline Processor
   */
  private processStream(rawStream: MediaStream, isLocalStreamer: boolean) {
    let renderVideoTrack = rawStream.getVideoTracks()[0];
    let renderAudioTrack = rawStream.getAudioTracks()[0];
    let outgoingVideoTrack = renderVideoTrack;
    let outgoingAudioTrack = renderAudioTrack;

    if (isLocalStreamer) {
      if (this.options.onOutgoingVideo && renderVideoTrack) {
        outgoingVideoTrack = this.options.onOutgoingVideo(renderVideoTrack) || renderVideoTrack;
      }
      if (this.options.onOutgoingAudio && renderAudioTrack) {
        outgoingAudioTrack = this.options.onOutgoingAudio(renderAudioTrack) || renderAudioTrack;
      }
      
      const outTracks = [outgoingVideoTrack, outgoingAudioTrack].filter(Boolean) as MediaStreamTrack[];
      this.myOutgoingStream = new MediaStream(outTracks);
      this.myRenderStream = this.myOutgoingStream; // Streamer usually previews what they send
    } else {
      // Incoming Pipeline (Local View)
      if (this.options.onIncomingVideo && renderVideoTrack) {
        renderVideoTrack = this.options.onIncomingVideo(renderVideoTrack) || renderVideoTrack;
      }
      if (this.options.onIncomingAudio && renderAudioTrack) {
        renderAudioTrack = this.options.onIncomingAudio(renderAudioTrack) || renderAudioTrack;
      }
      const renderTracks = [renderVideoTrack, renderAudioTrack].filter(Boolean) as MediaStreamTrack[];
      this.myRenderStream = new MediaStream(renderTracks);
      
      // Outgoing Pipeline (Forwarding)
      outgoingVideoTrack = rawStream.getVideoTracks()[0];
      outgoingAudioTrack = rawStream.getAudioTracks()[0];
      
      if (this.options.onOutgoingVideo && outgoingVideoTrack) {
        outgoingVideoTrack = this.options.onOutgoingVideo(outgoingVideoTrack) || outgoingVideoTrack;
      }
      if (this.options.onOutgoingAudio && outgoingAudioTrack) {
        outgoingAudioTrack = this.options.onOutgoingAudio(outgoingAudioTrack) || outgoingAudioTrack;
      }
      const outTracks = [outgoingVideoTrack, outgoingAudioTrack].filter(Boolean) as MediaStreamTrack[];
      this.myOutgoingStream = new MediaStream(outTracks);
    }
    
    if (this.options.onStreamReady && this.myRenderStream) {
      this.options.onStreamReady(this.myRenderStream);
    } else if (this.options.onStreamReceived && this.myRenderStream) {
      this.options.onStreamReceived(this.myRenderStream);
    }
  }

  /**
   * 初始化為直播主 (Streamer)
   */
  public initStreamer(stream: MediaStream, maxChildren: number = 4): Promise<string> {
    this.isStreamer = true;
    this.processStream(stream, true);
    
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
            if (Object.keys(this.activeMediaCalls).length < maxChildren) {
              this.activeDataConns[conn.peer] = conn;
              const call = this.peer!.call(conn.peer, this.myOutgoingStream!);
              this.activeMediaCalls[conn.peer] = call;
            } else {
              conn.send({ type: 'SYS_REJECT_FULL' });
            }
          } else if (data && data.type === 'USER_DATA') {
            this.handleIncomingData(data.payload);
          }
        });

        conn.on('close', () => {
          this.cleanupChild(conn.peer);
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
            if (Object.keys(this.activeMediaCalls).length < maxChildren && this.myOutgoingStream) {
              this.activeDataConns[conn.peer] = conn;
              const call = this.peer!.call(conn.peer, this.myOutgoingStream);
              this.activeMediaCalls[conn.peer] = call;
            } else {
              conn.send({ type: 'SYS_REJECT_FULL' });
            }
          } else if (data && data.type === 'USER_DATA') {
            this.handleIncomingData(data.payload);
          }
        });

        conn.on('close', () => {
          this.cleanupChild(conn.peer);
        });
      });

      this.peer.on('call', (call) => {
        this.options.onStatusChange?.("接收影像中...");
        this.parentMediaConn = call;
        call.answer(); 
        
        call.on('stream', (remoteStream) => {
          this.processStream(remoteStream, false);
          this.options.onStatusChange?.(""); 
        });

        call.on('close', () => {
          this.handleParentDisconnect(call.peer);
        });
      });
    });
  }

  /**
   * Data Broadcasting
   */
  public broadcastData(payload: any) {
    let finalPayload = payload;
    
    if (this.options.onOutgoingData) {
      finalPayload = this.options.onOutgoingData(payload);
    }
    
    if (finalPayload === null || finalPayload === undefined) return; // Blocked

    const wrapper = { type: 'USER_DATA', payload: finalPayload };
    for (const [peerId, conn] of Object.entries(this.activeDataConns)) {
      conn.send(wrapper);
    }
  }

  private handleIncomingData(payload: any) {
    if (this.options.onIncomingData) {
      this.options.onIncomingData(payload);
    }
    
    // Viewer should forward to children after incoming processing
    if (!this.isStreamer) {
      this.broadcastData(payload);
    }
  }

  private cleanupChild(peerId: string) {
    if (this.activeMediaCalls[peerId]) {
      this.activeMediaCalls[peerId].close();
      delete this.activeMediaCalls[peerId];
    }
    if (this.activeDataConns[peerId]) {
      delete this.activeDataConns[peerId];
    }
  }

  /**
   * Network Connections & Reconnections
   */
  public setExpectedDelay(delayMs: number): void {
    this.expectedDelayMs = delayMs;
    this.options.onDelayConfigured?.(this.expectedDelayMs);
  }

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
      this.parentDataConn = conn;

      const timeoutId = setTimeout(() => {
        conn.close();
        this.handleParentDisconnect(targetPeerId);
      }, 5000);

      conn.on('open', () => {
        clearTimeout(timeoutId);
        conn.send('VIEWER_READY');
      });

      conn.on('data', (data: any) => {
        if (data && data.type === 'SYS_REJECT_FULL') {
          clearTimeout(timeoutId);
          conn.close();
          this.handleParentDisconnect(targetPeerId);
        } else if (data && data.type === 'SYS_RECONNECT') {
          clearTimeout(timeoutId);
          conn.close();
          if (this.parentMediaConn) {
             this.parentMediaConn.close();
          }
          this.handleParentDisconnect(targetPeerId);
        } else if (data && data.type === 'USER_DATA') {
          this.handleIncomingData(data.payload);
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
    
    this.parentMediaConn = null;
    this.parentDataConn = null;

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
      if (!this.options.reportStatsFn || !this.parentMediaConn?.peerConnection) return;
      
      const pc = this.parentMediaConn.peerConnection;
      pc.getStats().then(stats => {
        let currentPing = 50; 
        let currentBitrate = 0;
        
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            currentBitrate = (report.bytesReceived || 0) * 8 / 1000; 
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
