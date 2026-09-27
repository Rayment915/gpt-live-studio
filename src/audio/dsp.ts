export function floatToPcm(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function pcmToFloat(bytes: Uint8Array): Float32Array {
  if (bytes.length % 2) throw new Error('PCM16 requires an even number of bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

export function encodeAudio(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 8192) result += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(result);
}

export function decodeAudio(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

export class PlaybackClock {
  anchor: number | null = null;
  end = 0;

  schedule(startMs: number, duration: number, now: number): number {
    if (this.anchor === null) this.anchor = now + 0.08 - startMs / 1000;
    let target = this.anchor + startMs / 1000;
    if (target < now) {
      this.anchor += now + 0.04 - target;
      target = now + 0.04;
    }
    const start = Math.max(target, this.end);
    this.end = start + duration;
    return start;
  }
}
