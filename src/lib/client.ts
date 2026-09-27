import type { Event, SessionConfig, Transport } from '../../shared/protocol';
import type { SceneId } from '../../shared/scenarios';
import { AudioEngine } from '../audio/engine';

export class LiveClient {
  audio = new AudioEngine();
  peer?: RTCPeerConnection;
  socket?: WebSocket;
  id?: string;
  disposed = false;
  private seen = new Set<number>();
  private heartbeat?: ReturnType<typeof setTimeout>;

  constructor(public csrf: string, private onEvent: (event: Event) => void, private onClosed: () => void, private onError: (message: string) => void) {}

  async request(path: string, body: unknown) {
    const result = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Csrf': this.csrf }, body: JSON.stringify(body), signal: AbortSignal.timeout(path === '/api/sessions' ? 70_000 : 20_000) });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error ?? `请求失败 ${result.status}`);
    return data;
  }

  async start(config: SessionConfig, transport: Transport, deviceId: string, inputSource: 'microphone' | 'file' = 'microphone', scene?: SceneId) {
    await this.audio.initialize();
    const stream = transport === 'webrtc' || inputSource === 'microphone' ? await this.audio.microphone(deviceId) : undefined;
    if (this.disposed) { this.audio.stop(); return; }
    let sdp: string | undefined;
    if (transport === 'webrtc') {
      this.peer = new RTCPeerConnection();
      stream!.getTracks().forEach(track => this.peer!.addTrack(track, stream!));
      this.peer.createDataChannel('oai-events');
      this.peer.ontrack = event => {
        void this.audio.remoteStream(event.streams[0] ?? new MediaStream([event.track])).catch(() => this.onError('浏览器阻止了语音播放，请点击「没有声音？恢复播放」，并检查输出设备'));
      };
      this.peer.onconnectionstatechange = () => {
        if (this.peer?.connectionState === 'failed') { this.onError('WebRTC 网络连接失败；可结束后切换 WebSocket 模式重试'); void this.close(); }
      };
      await this.peer.setLocalDescription(await this.peer.createOffer());
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2000);
        this.peer!.onicegatheringstatechange = () => { if (this.peer?.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
        if (this.peer!.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
      sdp = this.peer.localDescription!.sdp;
    }
    if (this.disposed) { this.dispose(); return; }
    const created = await this.request('/api/sessions', { transport, session: config, sdp, scene });
    this.id = created.id;
    if (this.disposed) { await this.request(`/api/sessions/${this.id}/commands`, { event: { type: 'session.close' } }); return; }
    if (transport === 'webrtc') await this.peer!.setRemoteDescription({ type: 'answer', sdp: created.sdp });
    await new Promise<void>((resolve, reject) => {
      this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/sessions/${this.id}/events`);
      const timeout = setTimeout(() => { reject(new Error('事件流连接超时')); this.dispose(); }, 15_000);
      this.socket.onopen = () => { clearTimeout(timeout); resolve(); };
      this.socket.onmessage = ({ data }) => {
        try {
          const event: Event = JSON.parse(data);
          if (event._seq && this.seen.has(event._seq)) return;
          if (event._seq) { this.seen.add(event._seq); if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!); }
          if (event.type === 'session.output_audio.delta') this.audio.play(event.delta, event.start_ms);
          if (event.type === 'session.input_audio.muted') this.audio.muted = true;
          if (event.type === 'session.input_audio.unmuted') this.audio.muted = false;
          this.onEvent(event);
          if (event.type === 'session.closed' || event.type === 'studio.closing') {
            this.audio.cancelUpload(); this.audio.muted = true;
            this.audio.stream?.getTracks().forEach(track => track.stop());
          }
          if (event.type === 'error') this.onError(event.error?.message ?? '模型返回错误');
          if (event.type === 'studio.error') this.onError(event.message);
        } catch (error) { this.onError(String(error)); }
      };
      this.socket.onerror = () => { clearTimeout(timeout); reject(new Error('事件流无法连接')); this.onError('事件流连接失败'); };
      this.socket.onclose = () => { clearTimeout(timeout); reject(new Error('事件流已关闭')); this.dispose(); this.onClosed(); };
    });
    if (transport === 'websocket' && stream) await this.audio.capturePcm(audio => this.sendAudio(audio));
  }

  sendAudio(audio: string) {
    if (this.disposed || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 512 * 1024) { this.onError('本地音频积压，已结束会话'); void this.close(); return; }
    this.socket.send(JSON.stringify({ type: 'session.input_audio.append', audio }));
  }

  async send(event: Event, experimental = false) {
    if (!this.id || this.disposed) throw new Error('请先开始会话');
    return this.request(`/api/sessions/${this.id}/commands`, { event: { ...event, event_id: event.event_id ?? crypto.randomUUID() }, experimental });
  }

  async changeMicrophone(deviceId: string) {
    const stream = await this.audio.microphone(deviceId);
    const sender = this.peer?.getSenders().find(item => item.track?.kind === 'audio');
    if (sender) await sender.replaceTrack(stream.getAudioTracks()[0]);
  }

  async tool(callId: string, mode: 'demo' | 'manual', output?: string) {
    return this.request(`/api/sessions/${this.id}/tools/${encodeURIComponent(callId)}`, { approved: true, mode, output });
  }

  async close() {
    clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => { this.dispose(); this.onClosed(); }, 14_000);
    this.audio.cancelUpload();
    this.audio.muted = true;
    this.audio.stream?.getTracks().forEach(track => track.stop());
    try { if (this.id) await this.send({ type: 'session.close' }); }
    catch (error) { this.onError(String(error)); }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.heartbeat);
    this.audio.stop();
    this.peer?.close();
    this.socket?.close();
  }
}
