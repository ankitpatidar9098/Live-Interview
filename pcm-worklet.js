// AudioWorklet processor for 16 kHz PCM chunking
// This file must be a real file on disk — Blob URLs are not supported in Electron AudioWorklet

const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

class PCMSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this._buf.push(ch[i]);
    }

    while (this._buf.length >= CHUNK_SAMPLES) {
      const chunk = this._buf.splice(0, CHUNK_SAMPLES);
      this.port.postMessage(new Float32Array(chunk));
    }

    return true;
  }
}

registerProcessor('pcm-sender', PCMSender);
