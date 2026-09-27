import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { decodeAudio, encodeAudio, floatToPcm, pcmToFloat, PlaybackClock } from '../src/audio/dsp';
import { AudioEngine } from '../src/audio/engine';

describe('PCM audio', () => {
  it('encodes signed little-endian PCM16 and bounds amplitude', () => {
    expect([...floatToPcm(new Float32Array([-2, 0, 2]))]).toEqual([0, 128, 0, 0, 255, 127]);
    expect(pcmToFloat(new Uint8Array([0, 128]))[0]).toBe(-1);
    expect(() => pcmToFloat(new Uint8Array([0]))).toThrow();
  });
  it('roundtrips base64', () => {
    const bytes = floatToPcm(new Float32Array([0.5, -0.5]));
    expect(decodeAudio(encodeAudio(bytes))).toEqual(bytes);
  });
  it('resamples 48 kHz to 24 kHz across AudioWorklet blocks', () => {
    let Processor: any;
    const frames: Float32Array[] = [];
    vm.runInNewContext(readFileSync('public/pcm-worklet.js', 'utf8'), {
      AudioWorkletProcessor: class { port = { postMessage: (samples: Float32Array) => frames.push(samples) }; },
      sampleRate: 48000,
      Float32Array,
      registerProcessor: (_name: string, constructor: any) => { Processor = constructor; },
    });
    const processor = new Processor();
    for (let frame = 0; frame < 15; frame++) processor.process([[new Float32Array(128).fill(0.4)]], [[new Float32Array(128)]]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(480);
    expect(frames[0][0]).toBeCloseTo(0.4);
  });
  it('retains timeline gaps and rebases late playback safely', () => {
    const clock = new PlaybackClock();
    const first = clock.schedule(0, 0.1, 5);
    const next = clock.schedule(500, 0.1, 5.1);
    expect(next - first).toBeCloseTo(0.5);
    expect(clock.schedule(600, 0.1, 10)).toBeGreaterThan(10);
  });
  it.each([16000, 24000, 44100, 48000])('preserves one second of mono audio at %i Hz', rate => {
    let Processor: any;
    const frames: Float32Array[] = [];
    vm.runInNewContext(readFileSync('public/pcm-worklet.js', 'utf8'), {
      AudioWorkletProcessor: class { port = { postMessage: (samples: Float32Array) => frames.push(samples) }; },
      sampleRate: rate,
      Float32Array,
      registerProcessor: (_name: string, constructor: any) => { Processor = constructor; },
    });
    const processor = new Processor();
    for (let offset = 0; offset < rate; offset += 128) {
      const size = Math.min(128, rate - offset);
      processor.process([[new Float32Array(size).fill(0.2), new Float32Array(size).fill(0.6)]], [[new Float32Array(size)]]);
    }
    expect(frames).toHaveLength(50);
    expect(frames.at(-1)![479]).toBeCloseTo(0.4);
  });
});

describe('WebRTC output', () => {
  it('plays the remote track natively, supports mute and retries blocked playback', async () => {
    const play = vi.fn(async () => {});
    const pause = vi.fn();
    const setSinkId = vi.fn(async () => {});
    const audio = { play, pause, setSinkId, setAttribute: vi.fn(), srcObject: null as MediaStream | null, muted: false, paused: false, autoplay: false };
    vi.stubGlobal('Audio', class { constructor() { return audio; } });
    const monitor = { gain: { value: 1 }, connect: vi.fn(function () { return monitor; }), disconnect: vi.fn() };
    const analyser = { fftSize: 0, connect: vi.fn(() => monitor) };
    const source = { connect: vi.fn(() => analyser), disconnect: vi.fn() };
    const context = {
      state: 'running', destination: {}, createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser), createGain: vi.fn(() => monitor),
      resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    const engine = new AudioEngine();
    engine.context = context as unknown as AudioContext;
    engine.outputGain = { gain: { value: 1 } } as GainNode;
    const stream = {} as MediaStream;
    try {
      await engine.remoteStream(stream);
      expect(audio.srcObject).toBe(stream);
      expect(play).toHaveBeenCalledOnce();
      expect(monitor.gain.value).toBe(0);
      engine.speakerMuted(true);
      expect(audio.muted).toBe(true);
      await engine.outputDevice('speaker-id');
      expect(setSinkId).toHaveBeenCalledWith('speaker-id');
      audio.paused = true;
      await engine.resume();
      expect(play).toHaveBeenCalledTimes(2);
      engine.stop();
      expect(pause).toHaveBeenCalled();
      expect(audio.srcObject).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});
