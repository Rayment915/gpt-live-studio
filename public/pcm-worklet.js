class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(480);
    this.length = 0;
    this.phase = 0;
    this.sum = 0;
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[index] / channels.length;
      let remaining = 24000 / sampleRate;
      while (remaining > 1e-9) {
        const weight = Math.min(1 - this.phase, remaining);
        this.sum += mixed * weight;
        this.phase += weight;
        remaining -= weight;
        if (this.phase >= 1 - 1e-9) {
          this.buffer[this.length++] = this.sum;
          this.phase = 0;
          this.sum = 0;
          if (this.length === this.buffer.length) {
            this.port.postMessage(this.buffer, [this.buffer.buffer]);
            this.buffer = new Float32Array(480);
            this.length = 0;
          }
        }
      }
    }
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
