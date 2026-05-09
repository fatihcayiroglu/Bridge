// client/js/core/rnnoise-worklet.js
// AudioWorkletProcessor: RNNoise WebAssembly Ã§aÄŸrÄ±sÄ±nÄ± ses thread'inde yapar.
// ScriptProcessorNode yerine (deprecated + main thread blocking) AudioWorklet kullanÄ±r.
// Ana thread'den mesaj olarak WASM binary alÄ±r; postMessage ile hazÄ±r sinyali gÃ¶nderir.

'use strict';

// ── WASM module interface ──────────────────────────────────────────────────
interface RNNoiseWasmExports {
  malloc(size: number): number;
  free(ptr: number): void;
  rnnoise_create(model: number): number;
  rnnoise_destroy(state: number): void;
  rnnoise_process_frame(state: number, outPtr: number, inPtr: number): number;
  memory: WebAssembly.Memory;
}

class RNNoiseProcessor extends AudioWorkletProcessor {
  // ── Property declarations ────────────────────────────────────────────────
  private _ready:    boolean;
  private _mod:      RNNoiseWasmExports | null;
  private _state:    number | null;
  private _leftover: Float32Array;
  private _frameLen: number;
  // AudioWorkletProcessor.port is typed in lib.dom but declare here for safety
  declare port: MessagePort;

  constructor(options) {
    super(options);
    this._ready      = false;
    this._mod        = null;
    this._state      = null;
    this._leftover   = new Float32Array(0);
    this._frameLen   = 480; // 10ms @ 48kHz â€” RNNoise sabit frame boyutu

    this.port.onmessage = async (e) => {
      if (e.data.type === 'init-wasm') {
        await this._initWasm(e.data.wasmBinary);
      } else if (e.data.type === 'destroy') {
        this._destroy();
      }
    };
  }

  async _initWasm(wasmBinary) {
    try {
      // WebAssembly.instantiate direkt binary Ã¼zerinden Ã§alÄ±ÅŸÄ±r (fetch yok)
      const { instance } = await WebAssembly.instantiate(wasmBinary, {
        env: {
          memory: new WebAssembly.Memory({ initial: 256 }),
          // RNNoise'un ihtiyaÃ§ duyduÄŸu minimal stub'lar
          __assert_fail: () => {},
          emscripten_resize_heap: () => 0,
        },
      });

      // Emscripten'in module wrapper'Ä± varsa kullan, yoksa instance direkt
      // rnnoise-wasm paketi emscripten Ã§Ä±ktÄ±sÄ± olduÄŸundan exports Ã¼zerinden eriÅŸiriz
      this._mod   = instance.exports;
      this._state = this._mod.rnnoise_create ? this._mod.rnnoise_create(0) : null;

      if (!this._state) {
        // Fallback: wasmBinary bir ArrayBuffer, emscripten runtime bekleniyor
        // Ana thread'e bildir â€” main thread emscripten init ile tekrar baÅŸlatacak
        this.port.postMessage({ type: 'wasm-needs-emscripten' });
        return;
      }

      this._ready = true;
      this.port.postMessage({ type: 'wasm-ready' });
    } catch (err) {
      this.port.postMessage({ type: 'wasm-error', message: err.message });
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) return true;

    const inData  = input[0];
    const outData = output[0];

    if (!this._ready || !this._mod || !this._state) {
      // Bypass: ham ses aktar
      outData.set(inData);
      return true;
    }

    // Ã–nceki artÄ±k Ã¶rnekleri yeni giriÅŸle birleÅŸtir
    const combined = new Float32Array(this._leftover.length + inData.length);
    combined.set(this._leftover);
    combined.set(inData, this._leftover.length);

    const mod      = this._mod;
    const state    = this._state;
    const frameLen = this._frameLen;

    // PCM tampon pointer'Ä± (float32 = 4 byte/sample)
    const pcmPtr = mod.malloc(frameLen * 4);

    let offset = 0;
    while (offset + frameLen <= combined.length) {
      const frame = combined.subarray(offset, offset + frameLen);

      // Float32 [-1,1] â†’ Int16 [-32768,32767]  (RNNoise beklentisi)
      const i16 = new Int16Array(frameLen);
      for (let i = 0; i < frameLen; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, frame[i] * 32768));
      }

      // HEAP'e yaz
      new Int16Array(mod.memory.buffer, pcmPtr, frameLen).set(i16);

      // RNNoise iÅŸle (in-place: aynÄ± pointer giriÅŸ & Ã§Ä±kÄ±ÅŸ)
      mod.rnnoise_process_frame(state, pcmPtr, pcmPtr);

      // HEAP'ten oku â†’ Float32
      const processed = new Int16Array(mod.memory.buffer, pcmPtr, frameLen);
      for (let i = 0; i < frameLen && (offset + i) < outData.length; i++) {
        outData[offset + i] = processed[i] / 32768;
      }

      offset += frameLen;
    }

    mod.free(pcmPtr);

    // Ä°ÅŸlenemeyen artÄ±k Ã¶rnekleri sakla
    this._leftover = combined.slice(offset);

    // Doldurulamayan output pozisyonlarÄ±nÄ± sÄ±fÄ±rla
    for (let i = offset; i < outData.length; i++) outData[i] = 0;

    return true; // processor'Ä± aktif tut
  }

  _destroy() {
    if (this._mod && this._state && this._mod.rnnoise_destroy) {
      try { this._mod.rnnoise_destroy(this._state); } catch {}
    }
    this._ready = false;
    this._mod   = null;
    this._state = null;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);

