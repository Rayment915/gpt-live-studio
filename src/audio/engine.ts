import { decodeAudio, encodeAudio, floatToPcm, pcmToFloat, PlaybackClock } from './dsp';

export class AudioEngine {
  context?: AudioContext;
  stream?: MediaStream;
  inputAnalyser?: AnalyserNode;
  outputAnalyser?: AnalyserNode;
  outputGain?: GainNode;
  private capture?: AudioWorkletNode;
  private inputSource?: MediaStreamAudioSourceNode;
  private playback = new Set<AudioBufferSourceNode>();
  private clock = new PlaybackClock();
  private remote?: MediaStreamAudioSourceNode;
  private remoteMonitor?: GainNode;
  private remoteAudio?: HTMLAudioElement;
  private speakerIsMuted = false;
  private uploadGeneration = 0;
  private microphoneGeneration = 0;
  uploading = false;
  muted = false;

  async initialize() {
    this.context = new AudioContext({ sampleRate: 24000 });
    await this.context.resume();
    this.outputGain = this.context.createGain();
    this.outputAnalyser = this.context.createAnalyser();
    this.outputAnalyser.fftSize = 256;
    this.outputGain.connect(this.outputAnalyser).connect(this.context.destination);
  }

  async microphone(deviceId?: string): Promise<MediaStream> {
    const generation = ++this.microphoneGeneration;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.microphoneGeneration || !this.context || this.context.state === 'closed') {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('麦克风请求已取消');
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = stream;
    this.inputSource?.disconnect();
    this.inputSource = this.context!.createMediaStreamSource(stream);
    this.inputAnalyser = this.context!.createAnalyser();
    this.inputAnalyser.fftSize = 256;
    this.inputSource.connect(this.inputAnalyser);
    if (this.capture) this.inputSource.connect(this.capture);
    return stream;
  }

  async capturePcm(send: (audio: string) => void) {
    await this.context!.audioWorklet.addModule('/pcm-worklet.js');
    this.capture = new AudioWorkletNode(this.context!, 'pcm-capture');
    this.capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (!this.uploading && !this.muted) send(encodeAudio(floatToPcm(data)));
    };
    this.inputSource!.connect(this.capture);
    this.capture.connect(this.context!.destination);
  }

  async remoteStream(stream: MediaStream) {
    if (!this.context || this.context.state === 'closed') return;
    this.remote?.disconnect();
    this.remoteMonitor?.disconnect();
    this.remoteAudio?.pause();
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
    this.remote = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 256;
    this.remoteMonitor = this.context.createGain();
    this.remoteMonitor.gain.value = 0;
    this.remote.connect(analyser).connect(this.remoteMonitor).connect(this.context.destination);
    this.outputAnalyser = analyser;
    this.remoteAudio = new Audio();
    this.remoteAudio.autoplay = true;
    this.remoteAudio.setAttribute('playsinline', '');
    this.remoteAudio.muted = this.speakerIsMuted;
    this.remoteAudio.srcObject = stream;
    await this.remoteAudio.play();
  }

  play(base64: string, startMs: number) {
    if (!this.context || this.context.state === 'closed') return;
    const samples = pcmToFloat(decodeAudio(base64));
    const buffer = this.context.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputGain!);
    source.start(this.clock.schedule(startMs, buffer.duration, this.context.currentTime));
    this.playback.add(source);
    source.onended = () => { this.playback.delete(source); source.disconnect(); };
  }

  async upload(file: File, send: (audio: string) => void, progress: (value: number) => void) {
    if (file.size > 20 * 1024 * 1024) throw new Error('音频文件最多 20 MB');
    if (!this.context) throw new Error('请先开始 WebSocket 会话');
    this.cancelUpload();
    const generation = this.uploadGeneration;
    const context = this.context;
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (generation !== this.uploadGeneration || this.context !== context) return;
    if (decoded.duration <= 0 || decoded.duration > 120) throw new Error('音频需大于 0 秒，最长 120 秒');
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 24000), 24000);
    const source = offline.createBufferSource(); source.buffer = decoded;
    source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering();
    if (generation !== this.uploadGeneration || this.context !== context) return;
    const samples = rendered.getChannelData(0);
    this.uploading = true;
    const started = performance.now();
    try {
      for (let offset = 0; offset < samples.length; offset += 480) {
        if (generation !== this.uploadGeneration) break;
        if (this.muted) throw new Error('上传已停止：输入处于静音状态');
        send(encodeAudio(floatToPcm(samples.subarray(offset, offset + 480))));
        progress(Math.min(100, Math.round((offset + 480) / samples.length * 100)));
        await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (offset + 480) / 24 - performance.now())));
      }
    } finally { if (generation === this.uploadGeneration) this.uploading = false; }
  }

  cancelUpload() { this.uploadGeneration++; this.uploading = false; }
  speakerMuted(value: boolean) {
    this.speakerIsMuted = value;
    if (this.outputGain) this.outputGain.gain.value = value ? 0 : 1;
    if (this.remoteAudio) this.remoteAudio.muted = value;
  }
  async outputDevice(deviceId: string) {
    const target = (this.remoteAudio ?? this.context) as (HTMLAudioElement | AudioContext) & { setSinkId?: (id: string) => Promise<void> };
    if (!target?.setSinkId) throw new Error('此浏览器不支持扬声器切换，请在系统设置中选择输出设备');
    await target.setSinkId(deviceId);
  }
  async resume() {
    await this.context?.resume();
    if (this.remoteAudio?.paused) await this.remoteAudio.play();
  }

  stop() {
    this.microphoneGeneration++;
    this.cancelUpload();
    this.stream?.getTracks().forEach(track => track.stop());
    this.capture?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.inputSource?.disconnect(); this.remote?.disconnect(); this.remoteMonitor?.disconnect();
    this.remoteAudio?.pause();
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
    this.remoteAudio = undefined;
    for (const source of this.playback) { try { source.stop(); } catch {} }
    this.playback.clear();
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
