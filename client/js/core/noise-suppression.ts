// client/js/core/noise-suppression.js
// GÃ¼rÃ¼ltÃ¼ bastÄ±rma:
//   ScriptProcessorNode (deprecated) â†’ AudioWorkletProcessor
//   WASM binary direkt fetch â†’ WorkletNode'a transferable ArrayBuffer olarak aktarÄ±m
//   Emscripten JS fallback (eski CDN paketi) hÃ¢lÃ¢ destekleniyor
//
// Modlar:
//   'basic'    â†’ HighPass + DynamicsCompressor (her tarayÄ±cÄ±da Ã§alÄ±ÅŸÄ±r)
//   'advanced' â†’ Notch + LowPass + Compressor zinciri
//   'rnnoise'  â†’ RNNoise WebAssembly AudioWorklet (ML tabanlÄ±, ses thread'inde)

'use strict';

const RNNOISE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@rnnoise/rnnoise-wasm@0.1.0/dist/rnnoise.wasm';
const RNNOISE_JS_URL   = 'https://cdn.jsdelivr.net/npm/@rnnoise/rnnoise-wasm@0.1.0/dist/rnnoise.js';
const WORKLET_PATH     = '/js/core/rnnoise-worklet.js';

declare var RNNoise: unknown;

class BridgeNoiseSuppression {
  // ── Property declarations ─────────────────────────────────────────────────
  enabled: boolean;
  mode: string;
  rnnoiseReady = false;
  _audioCtx: AudioContext | null = null;
  _sourceNode: MediaStreamAudioSourceNode | null = null;
  _destNode: AudioNode | null = null;
  _filterChain: AudioNode[] = [];
  _outputStream: MediaStream | null = null;
  _inputStream: MediaStream | null = null;
  _rnnoiseWorklet: AudioWorkletNode | null = null;
  _rnnoiseWasmBin: ArrayBuffer | null = null;
  _workletReady = false;
  _useEmscriptenFallback = false;
  _rnnoiseEmscripten: unknown = null;
  _rnnoiseEmscriptenState: unknown = null;
  stats: { framesProcessed: number; noiseReduced: number; cpuLoad: number };

  constructor() {
    this.enabled = this._loadPref('ns-enabled', true);
    this.mode    = this._loadPref('ns-mode', 'advanced');
    this.stats   = { framesProcessed: 0, noiseReduced: 0, cpuLoad: 0 };
    this.enabled      = this._loadPref('ns-enabled', true);
    this.mode         = this._loadPref('ns-mode', 'advanced');
    this.rnnoiseReady = false;

    this._audioCtx       = null;
    this._sourceNode     = null;
    this._destNode       = null;
    this._filterChain    = [];
    this._outputStream   = null;
    this._inputStream    = null;

    // AudioWorklet tabanlÄ± RNNoise (v65)
    this._rnnoiseWorklet        = null;  // AudioWorkletNode
    this._rnnoiseWasmBin        = null;  // ArrayBuffer
    this._workletReady          = false;
    this._useEmscriptenFallback = false;
    this._rnnoiseEmscripten     = null;
    this._rnnoiseEmscriptenState= null;

    this.stats = { framesProcessed: 0, noiseReduced: 0, cpuLoad: 0 };
  }

  _loadPref(key, def) {
    try {
      const v = localStorage.getItem(`bridge-${key}`);
      if (v === null) return def;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return v;
    } catch { return def; }
  }
  _savePref(key, val) {
    try { localStorage.setItem(`bridge-${key}`, String(val)); } catch {} }

  async init() {
    this._tryLoadRNNoise();
    return this;
  }

//   WASM binary'yi fetch et, AudioWorklet'e hazÄ±rla
  async _tryLoadRNNoise() {
    try {
      if (typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet yok');
      const resp = await fetch(RNNOISE_WASM_URL);
      if (!resp.ok) throw new Error(`WASM ${resp.status}`);
      this._rnnoiseWasmBin = await resp.arrayBuffer();
      this.rnnoiseReady    = true;
      console.log('[NS] RNNoise WASM binary hazÄ±r âœ“ â€” AudioWorklet modu aktif');
      window.dispatchEvent(new CustomEvent('bridge:ns-rnnoise-ready'));
    } catch (e) {
      console.info('[NS] AudioWorklet modu baÅŸarÄ±sÄ±z, Emscripten deneniyor:', e.message);
      this._tryLoadRNNoiseEmscripten();
    }
  }

  async _tryLoadRNNoiseEmscripten() {
    try {
      await this._loadScript(RNNOISE_JS_URL);
      if (typeof RNNoise !== 'undefined') {
        this._rnnoiseEmscripten      = await RNNoise();
        this._rnnoiseEmscriptenState = this._rnnoiseEmscripten._rnnoise_create(0);
        this._useEmscriptenFallback  = true;
        this.rnnoiseReady            = true;
        console.log('[NS] RNNoise Emscripten fallback hazÄ±r âœ“');
        window.dispatchEvent(new CustomEvent('bridge:ns-rnnoise-ready'));
      }
    } catch (e) {
      console.info('[NS] RNNoise yÃ¼klenemedi, geliÅŸmiÅŸ mod kullanÄ±lÄ±yor:', e.message);
    }
  }

  _loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async process(rawStream) {
    if (!rawStream?.getAudioTracks().length) return rawStream;
    this._inputStream = rawStream;
    if (!this.enabled) return rawStream;
    const mode = (this.mode === 'rnnoise' && this.rnnoiseReady) ? 'rnnoise' : this.mode;
    try {
      if (mode === 'rnnoise') {
        return this._useEmscriptenFallback
          ? await this._processRNNoiseEmscripten(rawStream)
          : await this._processRNNoiseWorklet(rawStream);
      }
      return await this._processWebAudio(rawStream, mode === 'advanced');
    } catch (e) {
      console.warn('[NS] Ä°ÅŸleme hatasÄ±, ham stream dÃ¶ndÃ¼rÃ¼lÃ¼yor:', e);
      return rawStream;
    }
  }

  async _processWebAudio(rawStream, advanced = true) {
    this._cleanup();
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    this._audioCtx = ctx;
    const source = ctx.createMediaStreamSource(rawStream);
    this._sourceNode = source;
    const chain = [];

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = advanced ? 80 : 60; hp.Q.value = 0.7;
    chain.push(hp);

    if (advanced) {
      [50, 60].forEach(freq => {
        const n = ctx.createBiquadFilter();
        n.type = 'notch'; n.frequency.value = freq; n.Q.value = 30;
        chain.push(n);
      });
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 8000; lp.Q.value = 0.5;
      chain.push(lp);
    }

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -40; comp.knee.value = 10;
    comp.ratio.value = advanced ? 8 : 4;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    chain.push(comp);

    const gain = ctx.createGain();
    gain.gain.value = 1.1;
    chain.push(gain);

    let prev = source;
    for (const node of chain) { prev.connect(node); prev = node; }
    const dest = ctx.createMediaStreamDestination();
    prev.connect(dest);
    this._destNode = dest; this._filterChain = chain;
    const outStream = dest.stream;
    rawStream.getVideoTracks().forEach(t => outStream.addTrack(t));
    this._outputStream = outStream;
    console.log(`[NS] Web Audio (${advanced ? 'geliÅŸmiÅŸ' : 'temel'}) âœ“`);
    return outStream;
  }

//   RNNoise via AudioWorkletNode â€” ses thread'inde, glitch yok
  async _processRNNoiseWorklet(rawStream) {
    if (!this._rnnoiseWasmBin) return this._processWebAudio(rawStream, true);
    this._cleanup();

    const ctx = new AudioContext({ sampleRate: 48000 });
    this._audioCtx = ctx;

    try {
      await ctx.audioWorklet.addModule(WORKLET_PATH);
    } catch (e) {
      console.warn('[NS] Worklet modÃ¼lÃ¼ yÃ¼klenemedi:', e.message);
      return this._processWebAudio(rawStream, true);
    }

    const workletNode = new AudioWorkletNode(ctx, 'rnnoise-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });

    // WASM binary transferable olarak gÃ¶nder (sÄ±fÄ±r kopya)
    const wasmCopy = this._rnnoiseWasmBin.slice(0);
    workletNode.port.postMessage({ type: 'init-wasm', wasmBinary: wasmCopy }, [wasmCopy]);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 6000);
        workletNode.port.onmessage = (e) => {
          clearTimeout(timer);
          if (e.data.type === 'wasm-ready') { this._workletReady = true; resolve(); }
          else if (e.data.type === 'wasm-needs-emscripten') reject(new Error('needs-emscripten'));
          else if (e.data.type === 'wasm-error') reject(new Error(e.data.message));
          else if (e.data.type === 'stats') {
            this.stats.framesProcessed += e.data.frames || 0;
            this.stats.cpuLoad = e.data.cpuLoad || 0;
          }
        };
      });
    } catch (err) {
      console.warn('[NS] Worklet init baÅŸarÄ±sÄ±z:', err.message);
      workletNode.disconnect();
      return this._processWebAudio(rawStream, true);
    }

    const source = ctx.createMediaStreamSource(rawStream);
    const dest   = ctx.createMediaStreamDestination();
    source.connect(workletNode);
    workletNode.connect(dest);

    this._sourceNode    = source;
    this._rnnoiseWorklet = workletNode;
    this._destNode      = dest;

    const outStream = dest.stream;
    rawStream.getVideoTracks().forEach(t => outStream.addTrack(t));
    this._outputStream = outStream;
    console.log('[NS] RNNoise AudioWorklet (ML) aktif âœ“');
    return outStream;
  }

  // Emscripten ScriptProcessor fallback (deprecated ama hÃ¢lÃ¢ Ã§alÄ±ÅŸÄ±r)
  async _processRNNoiseEmscripten(rawStream) {
    if (!this._rnnoiseEmscripten) return this._processWebAudio(rawStream, true);
    this._cleanup();

    const ctx      = new AudioContext({ sampleRate: 48000 });
    this._audioCtx = ctx;
    const source   = ctx.createMediaStreamSource(rawStream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mod       = this._rnnoiseEmscripten;
    const state     = this._rnnoiseEmscriptenState;
    const frameLen  = 480;
    let leftover    = new Float32Array(0);

    processor.onaudioprocess = (e) => {
      const input  = e.inputBuffer.getChannelData(0);
      const output = e.outputBuffer.getChannelData(0);
      const combined = new Float32Array(leftover.length + input.length);
      combined.set(leftover); combined.set(input, leftover.length);
      let offset = 0;
      const pcmPtr = mod._malloc(frameLen * 4);
      while (offset + frameLen <= combined.length) {
        const i16 = new Int16Array(frameLen);
        for (let i = 0; i < frameLen; i++)
          i16[i] = Math.max(-32768, Math.min(32767, combined[offset + i] * 32768));
        mod.HEAP16.set(i16, pcmPtr >> 1);
        mod._rnnoise_process_frame(state, pcmPtr, pcmPtr);
        const result = mod.HEAP16.subarray(pcmPtr >> 1, (pcmPtr >> 1) + frameLen);
        for (let i = 0; i < frameLen && (offset + i) < output.length; i++)
          output[offset + i] = result[i] / 32768;
        offset += frameLen; this.stats.framesProcessed++;
      }
      mod._free(pcmPtr); leftover = combined.slice(offset);
      for (let i = offset; i < output.length; i++) output[i] = 0;
    };

    const dest = ctx.createMediaStreamDestination();
    source.connect(processor); processor.connect(dest);
    this._sourceNode = source; this._rnnoiseWorklet = processor; this._destNode = dest;
    const outStream = dest.stream;
    rawStream.getVideoTracks().forEach(t => outStream.addTrack(t));
    this._outputStream = outStream;
    console.log('[NS] RNNoise Emscripten (ScriptProcessor) aktif âœ“');
    return outStream;
  }

  setEnabled(val) {
    this.enabled = val; this._savePref('ns-enabled', val);
    val ? this._audioCtx?.resume().catch(() => {}) : this._audioCtx?.suspend().catch(() => {});
    window.dispatchEvent(new CustomEvent('bridge:ns-changed', { detail: { enabled: val, mode: this.mode } }));
  }

  setMode(mode) {
    if (!['basic', 'advanced', 'rnnoise'].includes(mode)) return;
    this.mode = mode; this._savePref('ns-mode', mode);
    if (this._inputStream && this.enabled) {
      this.process(this._inputStream).then(clean => {
        if (!window.bridgeRTC) return;
        const audioTrack = clean.getAudioTracks()[0];
        if (audioTrack) {
          for (const pc of window.bridgeRTC.peers.values()) {
            const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
            if (sender) sender.replaceTrack(audioTrack).catch(() => {});
          }
        }
      });
    }
    window.dispatchEvent(new CustomEvent('bridge:ns-changed', { detail: { enabled: this.enabled, mode } }));
  }

  _cleanup() {
    try {
      this._filterChain.forEach(n => n.disconnect());
      if (this._rnnoiseWorklet) {
        this._rnnoiseWorklet.port?.postMessage?.({ type: 'destroy' });
        this._rnnoiseWorklet.disconnect();
      }
      this._sourceNode?.disconnect();
      this._destNode?.disconnect();
      if (this._audioCtx?.state !== 'closed') this._audioCtx?.close().catch(() => {});
    } catch {}
    this._filterChain = []; this._rnnoiseWorklet = null;
    this._workletReady = false; this._sourceNode = null;
    this._destNode = null; this._audioCtx = null; this._outputStream = null;
  }

  destroy() {
    if (this._rnnoiseEmscripten && this._rnnoiseEmscriptenState) {
      try { this._rnnoiseEmscripten._rnnoise_destroy(this._rnnoiseEmscriptenState); } catch {}
    }
    this._cleanup();
  }

  getStatus() {
    const activeMode = this.mode === 'rnnoise' && this.rnnoiseReady ? 'rnnoise' : this.mode;
    const engine = this._workletReady ? 'AudioWorklet' : this._useEmscriptenFallback ? 'Emscripten' : '';
    return {
      enabled: this.enabled, mode: this.mode, activeMode,
      rnnoiseReady: this.rnnoiseReady, engine,
      label: !this.enabled ? 'KapalÄ±'
        : activeMode === 'rnnoise' ? `RNNoise ML (${engine || 'hazÄ±rlanÄ±yor'})`
        : activeMode === 'advanced' ? 'GeliÅŸmiÅŸ (Web Audio)'
        : 'Temel (Web Audio)',
    };
  }
}

window.BridgeNS = new BridgeNoiseSuppression();
window.BridgeNS.init();

