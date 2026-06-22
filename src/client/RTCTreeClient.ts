export interface RTCTreeClientOptions {
  // 為了向下相容
  onStreamReceived?: (stream: MediaStream) => void;
  
  // 管線 - 本地渲染 (輸入)
  onStreamReady?: (stream: MediaStream) => void;
  onIncomingVideo?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onIncomingAudio?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onIncomingData?: (data: any) => void;

  // 管線 - 轉發 (輸出)
  onOutgoingVideo?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onOutgoingAudio?: (track: MediaStreamTrack) => MediaStreamTrack | void;
  onOutgoingData?: (data: any) => any | void; // 如果回傳 null 或 undefined，則過濾掉該資料

  // 基礎建設掛鉤 (Hooks)
  onStatusChange?: (status: string) => void;
  onError?: (error: any) => void;
  fetchParentIdFn?: () => Promise<string | null>;
  reportDeadFn?: (deadPeerId: string) => Promise<void>;
  reportStatsFn?: (pingMs: number, bitrateKbps: number) => Promise<void>;
  onDelayConfigured?: (expectedDelayMs: number) => void;
  statsIntervalMs?: number;
  
  // 信令 (Signaling)
  sendMessageFn?: (targetPeerId: string, message: any) => void;
  rtcConfiguration?: RTCConfiguration;
}

export class RTCTreeClient {
  private myPeerId: string | null = null;
  
  // 管線串流
  private myRenderStream: MediaStream | null = null;
  private myOutgoingStream: MediaStream | null = null;
  
  // 連線狀態
  private childrenPCs: Record<string, RTCPeerConnection> = {};
  private activeDataConns: Record<string, RTCDataChannel> = {};
  private parentPC: RTCPeerConnection | null = null;
  private parentDataConn: RTCDataChannel | null = null;
  private targetParentId: string | null = null;

  
  // 內部狀態
  private isStreamer: boolean = false;
  private isReconnecting: boolean = false;
  private expectedDelayMs: number = 0;
  private maxChildren: number = 4;
  
  private statsTimer: any = null;

  constructor(private options: RTCTreeClientOptions) {
    if (!this.options.statsIntervalMs) {
      this.options.statsIntervalMs = 5000;
    }
    if (!this.options.rtcConfiguration) {
      this.options.rtcConfiguration = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      };
    }
  }

  /**
   * 管線處理器
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
      this.myRenderStream = this.myOutgoingStream; // 直播主通常會預覽自己送出的串流
    } else {
      // 輸入管線 (本地觀看)
      if (this.options.onIncomingVideo && renderVideoTrack) {
        renderVideoTrack = this.options.onIncomingVideo(renderVideoTrack) || renderVideoTrack;
      }
      if (this.options.onIncomingAudio && renderAudioTrack) {
        renderAudioTrack = this.options.onIncomingAudio(renderAudioTrack) || renderAudioTrack;
      }
      const renderTracks = [renderVideoTrack, renderAudioTrack].filter(Boolean) as MediaStreamTrack[];
      this.myRenderStream = new MediaStream(renderTracks);
      
      // 輸出管線 (轉發)
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
      
      // 如果有現存的子節點連線，更新它們的影音軌
      for (const pc of Object.values(this.childrenPCs)) {
        const senders = pc.getSenders();
        this.myOutgoingStream.getTracks().forEach(track => {
          const sender = senders.find(s => s.track?.kind === track.kind);
          if (sender) {
            sender.replaceTrack(track);
          } else {
            pc.addTrack(track, this.myOutgoingStream!);
          }
        });
      }
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
  public initStreamer(myPeerId: string, stream: MediaStream, maxChildren: number = 4): Promise<string> {
    this.isStreamer = true;
    this.myPeerId = myPeerId;
    this.maxChildren = maxChildren;
    this.processStream(stream, true);
    
    this.expectedDelayMs = 0;
    this.options.onDelayConfigured?.(this.expectedDelayMs);

    this.options.onStatusChange?.("直播已開始");
    this.startStatsReporting();

    return Promise.resolve(this.myPeerId);
  }

  /**
   * 初始化為觀眾 (Viewer)
   */
  public initViewer(myPeerId: string, maxChildren: number = 4, expectedDelayMs: number = 1000): Promise<string> {
    this.isStreamer = false;
    this.myPeerId = myPeerId;
    this.maxChildren = maxChildren;
    this.expectedDelayMs = expectedDelayMs;
    this.options.onDelayConfigured?.(this.expectedDelayMs);

    this.options.onStatusChange?.("正在分配節點...");
    
    this.connectToMesh();
    this.startStatsReporting();

    return Promise.resolve(this.myPeerId);
  }

  /**
   * 信令處理器
   */
  public receiveMessage(fromPeerId: string, message: any) {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'OFFER':
        this.handleOffer(fromPeerId, message.sdp);
        break;
      case 'ANSWER':
        this.handleAnswer(fromPeerId, message.sdp);
        break;
      case 'ICE_CANDIDATE':
        this.handleIceCandidate(fromPeerId, message.candidate);
        break;
      case 'SYS_REJECT_FULL':
        this.handleParentDisconnect(fromPeerId); 
        break;
      case 'SYS_RECONNECT':
        if (this.parentPC) this.parentPC.close();
        this.handleParentDisconnect(fromPeerId);
        break;
    }
  }

  private sendSignaling(targetPeerId: string, type: string, payload: any) {
    if (this.options.sendMessageFn) {
      this.options.sendMessageFn(targetPeerId, { type, ...payload });
    }
  }

  private async handleOffer(fromPeerId: string, sdp: any) {
    if (Object.keys(this.childrenPCs).length >= this.maxChildren) {
      this.sendSignaling(fromPeerId, 'SYS_REJECT_FULL', {});
      return;
    }

    const pc = new RTCPeerConnection(this.options.rtcConfiguration);
    this.childrenPCs[fromPeerId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignaling(fromPeerId, 'ICE_CANDIDATE', { candidate: event.candidate });
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      this.activeDataConns[fromPeerId] = channel;
      this.setupDataChannel(channel, fromPeerId, true);
    };

    if (this.myOutgoingStream) {
      this.myOutgoingStream.getTracks().forEach(track => {
        pc.addTrack(track, this.myOutgoingStream!);
      });
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.cleanupChild(fromPeerId);
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignaling(fromPeerId, 'ANSWER', { sdp: answer });
    } catch (e) {
      console.error('Error handling offer:', e);
      this.cleanupChild(fromPeerId);
    }
  }

  private async handleAnswer(fromPeerId: string, sdp: any) {
    if (this.targetParentId !== fromPeerId) return; // 確保只接收目標父節點的 Answer
    if (this.parentPC && this.parentPC.signalingState !== 'closed') {
      try {
        await this.parentPC.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (e) {
        console.error('Error setting remote description from answer:', e);
      }
    }
  }

  private async handleIceCandidate(fromPeerId: string, candidate: any) {
    let pc: RTCPeerConnection | null = null;
    
    if (this.childrenPCs[fromPeerId]) {
      pc = this.childrenPCs[fromPeerId];
    } else if (this.targetParentId === fromPeerId && this.parentPC) {
      pc = this.parentPC;
    }

    if (pc && pc.remoteDescription) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('Error adding ICE candidate:', e);
      }
    }
  }

  /**
   * 資料廣播
   */
  public broadcastData(payload: any) {
    let finalPayload = payload;
    
    if (this.options.onOutgoingData) {
      finalPayload = this.options.onOutgoingData(payload);
    }
    
    if (finalPayload === null || finalPayload === undefined) return;

    const wrapper = JSON.stringify({ type: 'USER_DATA', payload: finalPayload });
    for (const [peerId, conn] of Object.entries(this.activeDataConns)) {
      if (conn.readyState === 'open') {
        conn.send(wrapper);
      }
    }
  }

  private handleIncomingData(payload: any) {
    if (this.options.onIncomingData) {
      this.options.onIncomingData(payload);
    }
    
    if (!this.isStreamer) {
      this.broadcastData(payload);
    }
  }

  private cleanupChild(peerId: string) {
    if (this.childrenPCs[peerId]) {
      this.childrenPCs[peerId].close();
      delete this.childrenPCs[peerId];
    }
    if (this.activeDataConns[peerId]) {
      this.activeDataConns[peerId].close();
      delete this.activeDataConns[peerId];
    }
  }

  /**
   * 網路連線與重新連線機制
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

      this.targetParentId = targetPeerId;
      this.options.onStatusChange?.("連線中...");
      
      const pc = new RTCPeerConnection(this.options.rtcConfiguration);
      this.parentPC = pc;

      // 加入 transceiver 來接收影音
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      // 設定資料通道
      const dc = pc.createDataChannel('tree-data');
      this.parentDataConn = dc;
      this.setupDataChannel(dc, targetPeerId, false);

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          this.processStream(event.streams[0], false);
          this.options.onStatusChange?.("");
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendSignaling(targetPeerId, 'ICE_CANDIDATE', { candidate: event.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          this.handleParentDisconnect(targetPeerId);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.sendSignaling(targetPeerId, 'OFFER', { sdp: offer });

    } catch (e) {
      this.options.onStatusChange?.("連線失敗");
      console.error(e);
    }
  }

  private setupDataChannel(channel: RTCDataChannel, peerId: string, isChild: boolean) {
    channel.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) { return; }

      if (data && data.type === 'USER_DATA') {
        this.handleIncomingData(data.payload);
      }
    };

    channel.onclose = () => {
      if (isChild) {
        this.cleanupChild(peerId);
      } else {
        this.handleParentDisconnect(peerId);
      }
    };
  }

  private async handleParentDisconnect(deadPeerId: string) {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    this.options.onStatusChange?.("上層節點斷線，重新尋找路徑...");
    
    if (this.parentPC) {
      this.parentPC.close();
      this.parentPC = null;
    }
    if (this.parentDataConn) {
      this.parentDataConn.close();
      this.parentDataConn = null;
    }
    this.targetParentId = null;

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
      if (!this.options.reportStatsFn || !this.parentPC) return;
      
      this.parentPC.getStats().then(stats => {
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
    if (this.parentPC) {
      this.parentPC.close();
      this.parentPC = null;
    }
    for (const [peerId, pc] of Object.entries(this.childrenPCs)) {
      pc.close();
    }
    this.childrenPCs = {};
  }
}
