// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/NoiseSuppressionPanel.svelte
//              client/js/core/noise-suppression-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/noise-suppression.ts
// Gürültü bastırma:
//   ScriptProcessorNode (deprecated) → AudioWorkletProcessor
//   WASM binary direkt fetch → WorkletNode'a transferable ArrayBuffer olarak aktarım
//   Emscripten JS fallback (eski CDN paketi) hâlâ destekleniyor
//
// Modlar:
//   'basic'    → HighPass + DynamicsCompressor (her tarayıcıda çalışır)
//   'advanced' → Notch + LowPass + Compressor zinciri
//   'rnnoise'  → RNNoise WebAssembly AudioWorklet (ML tabanlı, ses thread'inde)

'use strict';
import { BridgeRegistry } from './bridge-registry.js';

import { createLogger } from './logger.js';
const log = createLogger('NS');

// ONNX Runtime (ort) dinamik olarak window'a yüklenir (CDN script tag ile).
// TypeScript tip tanımı — `window as any` cast'lerini önler.
interface OrtTensor {
  new (type: string, data: Float32Array | BigInt64Array, dims: number[]): OrtTensor;
  data: Float32Array | BigInt64Array;
}
interface OrtInferenceSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
interface OrtInstance {
  env: { wasm: { numThreads: number } };
  Tensor: typeof OrtTensor extends new (...args: unknown[]) => OrtTensor ? typeof OrtTensor : never;
  InferenceSession: {
    create(modelBuffer: ArrayBuffer): Promise<OrtInferenceSession>;
  };
}
declare global {
  interface Window { ort?: OrtInstance; }
}


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

    // AudioWorklet tabanlı RNNoise (v65)
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

//   WASM binary'yi fetch et, AudioWorklet'e hazırla
  async _tryLoadRNNoise() {
    try {
      if (typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet yok');
      const resp = await fetch(RNNOISE_WASM_URL);
      if (!resp.ok) throw new Error(`WASM ${resp.status}`);
      this._rnnoiseWasmBin = await resp.arrayBuffer();
      this.rnnoiseReady    = true;
      log.log('[NS] RNNoise WASM binary hazır ✓ — AudioWorklet modu aktif');
      window.dispatchEvent(new CustomEvent('bridge:ns-rnnoise-ready'));
    } catch (e) {
      log.info('[NS] AudioWorklet modu başarısız, Emscripten deneniyor:', e.message);
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
        log.log('[NS] RNNoise Emscripten fallback hazır ✓');
        window.dispatchEvent(new CustomEvent('bridge:ns-rnnoise-ready'));
      }
    } catch (e) {
      log.info('[NS] RNNoise yüklenemedi, gelişmiş mod kullanılıyor:', e.message);
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
      log.warn('[NS] İşleme hatası, ham stream döndürülüyor:', e);
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
    log.log(`[NS] Web Audio (${advanced ? 'gelişmiş' : 'temel'}) ✓`);
    return outStream;
  }

//   RNNoise via AudioWorkletNode — ses thread'inde, glitch yok
  async _processRNNoiseWorklet(rawStream) {
    if (!this._rnnoiseWasmBin) return this._processWebAudio(rawStream, true);
    this._cleanup();

    const ctx = new AudioContext({ sampleRate: 48000 });
    this._audioCtx = ctx;

    try {
      await ctx.audioWorklet.addModule(WORKLET_PATH);
    } catch (e) {
      log.warn('[NS] Worklet modülü yüklenemedi:', e.message);
      return this._processWebAudio(rawStream, true);
    }

    const workletNode = new AudioWorkletNode(ctx, 'rnnoise-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });

    // WASM binary transferable olarak gönder (sıfır kopya)
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
      log.warn('[NS] Worklet init başarısız:', err.message);
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
    log.log('[NS] RNNoise AudioWorklet (ML) aktif ✓');
    return outStream;
  }

  // Emscripten ScriptProcessor fallback (deprecated ama hâlâ çalışır)
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
    log.log('[NS] RNNoise Emscripten (ScriptProcessor) aktif ✓');
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
        const _rtc = BridgeRegistry.get('BridgeRTC') as { peers: Map<unknown, RTCPeerConnection> } | null;
        if (!_rtc) return;
        const audioTrack = clean.getAudioTracks()[0];
        if (audioTrack) {
          for (const pc of _rtc.peers.values()) {
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
      label: !this.enabled ? 'Kapalı'
        : activeMode === 'rnnoise' ? `RNNoise ML (${engine || 'hazırlanıyor'})`
        : activeMode === 'advanced' ? 'Gelişmiş (Web Audio)'
        : 'Temel (Web Audio)',
    };
  }
}

const bridgeNS = new BridgeNoiseSuppression();
bridgeNS.init();
// Sprint 33: BridgeRegistry'e kayıt
BridgeRegistry.register('BridgeNS', bridgeNS);
export { bridgeNS };

// ═══════════════════════════════════════════════════════════════════════════
// Silero VAD — Voice Activity Detection
// ONNX Runtime Web üzerinden tarayıcıda çalışır.
// Model: snakers4/silero-vad (v4 onnx) — MIT lisansı
//
// Kullanım:
//   const vad = new BridgeSileroVAD();
//   await vad.init();
//   vad.attach(mediaStream);  // konuşma eventi başlatır
//   vad.on('speech',   () => { /* konuşma algılandı */ });
//   vad.on('silence',  () => { /* sessizlik */          });
//   vad.destroy();
// ═══════════════════════════════════════════════════════════════════════════

const SILERO_ONNX_URL = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.7/dist/silero_vad.onnx';
const ONNX_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js';

/** Silero VAD durumları */
type VadState = 'idle' | 'loading' | 'ready' | 'error';

class BridgeSileroVAD {
  private _state: VadState = 'idle';
  private _session: unknown = null;        // ort.InferenceSession
  private _audioCtx: AudioContext | null = null;
  private _processor: ScriptProcessorNode | null = null;
  private _source: MediaStreamAudioSourceNode | null = null;
  private _listeners: Map<string, Array<() => void>> = new Map();

  // VAD hiperparametreleri
  private readonly _sampleRate    = 16000;  // Silero 16kHz bekler
  private readonly _frameMs       = 32;     // 32ms çerçeve (512 örnek @ 16kHz)
  private readonly _threshold     = 0.5;    // konuşma eşiği
  private readonly _silencePad    = 300;    // ms — ses bitmeden bu kadar bekle
  private _speakingNow    = false;
  private _silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // İçsel durum vektörü (Silero v4 LSTM state)
  private _h = new Float32Array(2 * 1 * 64);  // [2, 1, 64]
  private _c = new Float32Array(2 * 1 * 64);

  on(event: 'speech' | 'silence', cb: () => void): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(cb);
    return this;
  }

  private _emit(event: 'speech' | 'silence'): void {
    this._listeners.get(event)?.forEach(cb => { try { cb(); } catch {} });
  }

  /** ONNX Runtime + model yükle */
  async init(): Promise<boolean> {
    if (this._state === 'ready') return true;
    this._state = 'loading';
    try {
      // ONNX Runtime Web'i CDN'den yükle (mevcut değilse)
      if (!(window as Record<string, unknown>).ort) {
        await new Promise<void>((res, rej) => {
          const s = document.createElement('script');
          s.src = ONNX_RUNTIME_URL;
          s.onload = () => res();
          s.onerror = () => rej(new Error('ort yüklenemedi'));
          document.head.appendChild(s);
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ort = window.ort;
      if (!ort) throw new Error('ort mevcut değil');
      ort.env.wasm.numThreads = 1;

      this._session = await ort.InferenceSession.create(SILERO_ONNX_URL, {
        executionProviders: ['wasm'],
      });

      this._state = 'ready';
      log.log('[VAD] Silero VAD hazır ✓');
      return true;
    } catch (e) {
      this._state = 'error';
      log.warn('[VAD] Silero yüklenemedi:', (e as Error).message);
      return false;
    }
  }

  /** MediaStream'i dinlemeye başla */
  attach(stream: MediaStream): void {
    if (this._state !== 'ready') { log.warn('[VAD] init() çağrılmadan attach edilemez'); return; }
    this.detach();

    // Resample için AudioContext — 48kHz → 16kHz OfflineAudioContext ile chunk'larda yapılır
    this._audioCtx = new AudioContext({ sampleRate: this._sampleRate });
    this._source   = this._audioCtx.createMediaStreamSource(stream);

    // ScriptProcessorNode hâlâ en geniş desteğe sahip (AudioWorklet VAD için ek worklet gerekir)
    // Frame: 512 örnek @ 16kHz = 32ms — Silero önerilen boyut
    const bufferSize = 512;
    this._processor  = this._audioCtx.createScriptProcessor(bufferSize, 1, 1);

    this._processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      void this._processFrame(inputData);
    };

    this._source.connect(this._processor);
    this._processor.connect(this._audioCtx.destination);
    log.log('[VAD] Stream bağlandı');
  }

  detach(): void {
    try {
      this._processor?.disconnect();
      this._source?.disconnect();
      if (this._audioCtx?.state !== 'closed') this._audioCtx?.close().catch(() => {});
    } catch {}
    this._processor = null;
    this._source    = null;
    this._audioCtx  = null;
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
  }

  private async _processFrame(pcm: Float32Array): Promise<void> {
    if (!this._session) return;
    try {
      const ort = window.ort;
      if (!ort) return;

      // Tensor oluştur
      const inputTensor = new ort.Tensor('float32', pcm, [1, pcm.length]);
      const srTensor    = new ort.Tensor('int64',   BigInt64Array.from([BigInt(this._sampleRate)]), [1]);
      const hTensor     = new ort.Tensor('float32', this._h, [2, 1, 64]);
      const cTensor     = new ort.Tensor('float32', this._c, [2, 1, 64]);

      const results = await (this._session as {
        run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
      }).run({ input: inputTensor, sr: srTensor, h: hTensor, c: cTensor });

      const prob = results['output'].data[0];          // konuşma olasılığı
      this._h.set(results['hn'].data);                 // LSTM state güncelle
      this._c.set(results['cn'].data);

      this._onProb(prob);
    } catch {
      // Sessizce geç — hata VAD'ı kilitlemez
    }
  }

  private _onProb(prob: number): void {
    if (prob >= this._threshold) {
      if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
      if (!this._speakingNow) {
        this._speakingNow = true;
        this._emit('speech');
        window.dispatchEvent(new CustomEvent('bridge:vad-speech'));
      }
    } else {
      if (this._speakingNow && !this._silenceTimer) {
        // Sessizlik padding — ani sessizliklerde false negative azalt
        this._silenceTimer = setTimeout(() => {
          this._speakingNow  = false;
          this._silenceTimer = null;
          this._emit('silence');
          window.dispatchEvent(new CustomEvent('bridge:vad-silence'));
        }, this._silencePad);
      }
    }
  }

  isSpeaking(): boolean { return this._speakingNow; }
  getState(): VadState  { return this._state; }

  destroy(): void {
    this.detach();
    this._session   = null;
    this._state     = 'idle';
    this._listeners.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Adaptive Bitrate Controller
// RTCPeerConnection'ın getStats() API'sinden RTT, jitter ve paket kaybını
// okuyarak Opus bitrate'ini dinamik olarak ayarlar.
//
// Kullanım:
//   const abc = new BridgeAdaptiveBitrate(peerConnection, audioSender);
//   abc.start();   // 3 saniyede bir ölçer, bitrate'i ayarlar
//   abc.stop();
// ═══════════════════════════════════════════════════════════════════════════

interface AbcStats {
  rttMs:        number;
  jitterMs:     number;
  packetLoss:   number;   // 0-1
  bitrate:      number;   // bps
}

class BridgeAdaptiveBitrate {
  private _pc:     RTCPeerConnection;
  private _sender: RTCRtpSender;
  private _timer:  ReturnType<typeof setInterval> | null = null;

  // Bitrate sınırları (bps)
  private readonly _minBps  =  8_000;   //  8 kbps — çok kötü ağ
  private readonly _midBps  = 24_000;   // 24 kbps — orta kalite
  private readonly _goodBps = 48_000;   // 48 kbps — normal
  private readonly _maxBps  = 96_000;   // 96 kbps — mükemmel ağ / müzik kalitesi
  private readonly _pollMs  = 3_000;    // 3 saniyede bir ölç

  private _currentBps = 48_000;
  private _prevPacketsSent   = 0;
  private _prevPacketsLost   = 0;

  constructor(pc: RTCPeerConnection, sender: RTCRtpSender) {
    this._pc     = pc;
    this._sender = sender;
  }

  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => { void this._tick(); }, this._pollMs);
    log.log('[ABR] Adaptive bitrate başlatıldı');
  }

  stop(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  private async _tick(): Promise<void> {
    try {
      const stats = await this._collectStats();
      const target = this._calcTarget(stats);

      if (target !== this._currentBps) {
        this._currentBps = target;
        await this._applyBitrate(target);
        log.log(`[ABR] Bitrate → ${Math.round(target / 1000)}kbps (RTT:${stats.rttMs}ms jitter:${stats.jitterMs}ms loss:${(stats.packetLoss * 100).toFixed(1)}%)`);
        window.dispatchEvent(new CustomEvent('bridge:abr-change', { detail: { bitrateBps: target, ...stats } }));
      }
    } catch (e) {
      log.warn('[ABR] getStats hatası:', (e as Error).message);
    }
  }

  private async _collectStats(): Promise<AbcStats> {
    const report = await this._pc.getStats(this._sender.track);
    let rttMs = 0, jitterMs = 0, packetLoss = 0;

    report.forEach((s: RTCStats & Record<string, unknown>) => {
      if (s.type === 'remote-inbound-rtp' && (s as Record<string, unknown>).kind === 'audio') {
        rttMs      = (((s as Record<string, unknown>).roundTripTime   as number) ?? 0) * 1000;
        jitterMs   = (((s as Record<string, unknown>).jitter          as number) ?? 0) * 1000;
        const sent = (s as Record<string, unknown>).packetsSent  as number ?? 0;
        const lost = (s as Record<string, unknown>).packetsLost  as number ?? 0;
        const deltaSent = sent - this._prevPacketsSent;
        const deltaLost = lost - this._prevPacketsLost;
        packetLoss = deltaSent > 0 ? Math.max(0, Math.min(1, deltaLost / deltaSent)) : 0;
        this._prevPacketsSent = sent;
        this._prevPacketsLost = lost;
      }
    });

    return { rttMs, jitterMs, packetLoss, bitrate: this._currentBps };
  }

  private _calcTarget(s: AbcStats): number {
    // Ağır ağ bozulması → minimum
    if (s.packetLoss > 0.10 || s.rttMs > 500 || s.jitterMs > 60) return this._minBps;
    // Orta bozulma → orta kalite
    if (s.packetLoss > 0.03 || s.rttMs > 200 || s.jitterMs > 30) return this._midBps;
    // İyi ağ → normal kalite
    if (s.packetLoss > 0.01 || s.rttMs > 100)                     return this._goodBps;
    // Mükemmel ağ → maksimum
    return this._maxBps;
  }

  private async _applyBitrate(bps: number): Promise<void> {
    const params = this._sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = bps;
    await this._sender.setParameters(params);
  }

  getCurrentBps(): number { return this._currentBps; }
}

// ── Registry'e kaydet ─────────────────────────────────────────────────────────
const bridgeVAD = new BridgeSileroVAD();
BridgeRegistry.register('BridgeVAD', bridgeVAD);
BridgeRegistry.register('BridgeAdaptiveBitrate', BridgeAdaptiveBitrate);

// VAD başlatma — kullanıcı mikrofona ilk eriştiğinde lazy init
window.addEventListener('bridge:mic-acquired', () => {
  bridgeVAD.init().then(ok => {
    if (ok) log.log('[VAD] bridge:mic-acquired ile başlatıldı');
  });
});

export { bridgeNS, bridgeVAD, BridgeSileroVAD, BridgeAdaptiveBitrate };

