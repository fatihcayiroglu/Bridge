// client/tests/voice-activity-detector.test.ts
//
// FAZ K2 — konusma durumu GERCEK genlikten turetilir.
// Durum makinesi saf tutuldugu icin gercek ses olmadan dogrulanabilir;
// uretim kodu yine de yalnizca canli mikrofon verisiyle beslenir.

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createSpeakingGate,
  rmsFromTimeDomain,
  startVoiceActivityDetection,
  VAD_TUNING,
} from '../js/core/voice-activity-detector.ts';

describe('Faz K2 — RMS olcumu', () => {
  it('sessizlikte sifira yakin, sinyalde yuksektir', () => {
    expect(rmsFromTimeDomain(new Float32Array([0, 0, 0, 0]))).toBe(0);
    // Tam olcekli kare dalga → RMS 1.
    expect(rmsFromTimeDomain(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 5);
  });

  it('bos ornekte cokmez', () => {
    expect(rmsFromTimeDomain(new Float32Array([]))).toBe(0);
  });
});

describe('Faz K2 — konusma durum makinesi', () => {
  it('acilis esigi asilinca konusma BASLAR', () => {
    const gate = createSpeakingGate();
    expect(gate.push(VAD_TUNING.openRms - 0.001, 0)).toBeNull();
    expect(gate.push(VAD_TUNING.openRms, 10)).toBe(true);
    expect(gate.speaking).toBe(true);
  });

  it('durum degismedikce null doner — gereksiz yayin yapilmaz', () => {
    const gate = createSpeakingGate();
    gate.push(0.2, 0);                       // basladi
    expect(gate.push(0.2, 50)).toBeNull();   // hala konusuyor
    expect(gate.push(0.2, 100)).toBeNull();
  });

  it('kisa duraklama konusmayi BITIRMEZ (hang-time)', () => {
    const gate = createSpeakingGate();
    gate.push(0.2, 0);
    // Kelimeler arasi sessizlik: hang suresinden kisa.
    expect(gate.push(0.001, 100)).toBeNull();
    expect(gate.push(0.2, 150)).toBeNull();
    expect(gate.speaking).toBe(true);
  });

  it('yeterince uzun sessizlikten sonra konusma BITER', () => {
    const gate = createSpeakingGate();
    gate.push(0.2, 0);
    expect(gate.push(0.001, 100)).toBeNull();
    expect(gate.push(0.001, 100 + VAD_TUNING.hangMs)).toBe(false);
    expect(gate.speaking).toBe(false);
  });

  it('histerezis: kapanis esigi ile acilis esigi arasi titremez', () => {
    const gate = createSpeakingGate();
    gate.push(0.2, 0);
    const between = (VAD_TUNING.openRms + VAD_TUNING.closeRms) / 2;
    // Kapanis esiginin USTUNDE kaldigi surece sessizlik sayaci baslamaz.
    expect(gate.push(between, 500)).toBeNull();
    expect(gate.push(between, 5000)).toBeNull();
    expect(gate.speaking).toBe(true);
  });

  it('sessizlik kesilirse sayac sifirlanir', () => {
    const gate = createSpeakingGate();
    gate.push(0.2, 0);
    gate.push(0.001, 100);                  // sessizlik basladi
    gate.push(0.2, 200);                    // yeniden konusma → sayac sifir
    expect(gate.push(0.001, 300)).toBeNull();
    expect(gate.speaking).toBe(true);
  });
});

describe('Faz K2 — VAD baslatma guvenligi', () => {
  it('AudioContext yoksa null doner ve SAHTE durum uretmez', () => {
    const saved = { AC: globalThis.AudioContext, WAC: (globalThis as never as Record<string, unknown>).webkitAudioContext };
    // @ts-expect-error — test ortaminda kaldiriliyor
    delete globalThis.AudioContext;
    delete (globalThis as unknown as Record<string, unknown>).webkitAudioContext;

    const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream;
    let called = false;
    const handle = startVoiceActivityDetection(stream, () => { called = true; });

    expect(handle).toBeNull();
    expect(called).toBe(false);   // hicbir konusma durumu yayilmadi

    if (saved.AC) globalThis.AudioContext = saved.AC;
    if (saved.WAC) (globalThis as unknown as Record<string, unknown>).webkitAudioContext = saved.WAC;
  });

  it('ses track olmayan akista baslamaz', () => {
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
    expect(startVoiceActivityDetection(stream, () => { /* cagrilmamali */ })).toBeNull();
  });
});

const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
const originalWebkitAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'webkitAudioContext');

function setAudioGlobal(name: 'AudioContext' | 'webkitAudioContext', value?: unknown): void {
  if (value === undefined) delete (globalThis as unknown as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreAudioGlobal(name: 'AudioContext' | 'webkitAudioContext', descriptor?: PropertyDescriptor): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as unknown as Record<string, unknown>)[name];
}

class FakeAnalyser {
  fftSize = 4;
  smoothingTimeConstant = 0;
  sample = 0;
  failRead = false;
  disconnect = vi.fn();

  getFloatTimeDomainData(buffer: Float32Array): void {
    if (this.failRead) throw new Error('device disappeared');
    buffer.fill(this.sample);
  }
}

class FakeSource {
  connect = vi.fn();
  disconnect = vi.fn();
}

let latestContext: FakeAudioContext | null = null;
let failContextSetup = false;
let rejectContextClose = false;

class FakeAudioContext {
  readonly analyser = new FakeAnalyser();
  readonly source = new FakeSource();
  close = vi.fn<() => Promise<void>>(() => rejectContextClose
    ? Promise.reject(new Error('close rejected'))
    : Promise.resolve());

  constructor() { latestContext = this; }
  createMediaStreamSource(): MediaStreamAudioSourceNode {
    if (failContextSetup) throw new Error('source setup failed');
    return this.source as unknown as MediaStreamAudioSourceNode;
  }
  createAnalyser(): AnalyserNode { return this.analyser as unknown as AnalyserNode; }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  latestContext = null;
  failContextSetup = false;
  rejectContextClose = false;
  restoreAudioGlobal('AudioContext', originalAudioContext);
  restoreAudioGlobal('webkitAudioContext', originalWebkitAudioContext);
});

describe('Faz K2 — gercek AudioContext yasam dongusu', () => {
  const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream;
  const tuning = { openRms: 0.02, closeRms: 0.012, hangMs: 100, intervalMs: 10 };

  it('webkit yedegini kullanir, gercek RMS gecislerini yayar ve temizligi tek kez yapar', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setAudioGlobal('AudioContext');
    setAudioGlobal('webkitAudioContext', FakeAudioContext);
    const changes = vi.fn();
    const levels = vi.fn();
    const handle = startVoiceActivityDetection(stream, changes, tuning, levels)!;
    const ctx = latestContext!;

    expect(ctx.source.connect).toHaveBeenCalledWith(ctx.analyser);
    expect(ctx.analyser.fftSize).toBe(1024);
    expect(ctx.analyser.smoothingTimeConstant).toBe(0.2);
    ctx.analyser.sample = 0.1;
    vi.advanceTimersByTime(10);
    expect(levels).toHaveBeenLastCalledWith(expect.closeTo(0.1, 5));
    expect(changes).toHaveBeenCalledWith(true);
    expect(handle.isSpeaking()).toBe(true);

    ctx.analyser.sample = 0;
    vi.advanceTimersByTime(110);
    expect(changes).toHaveBeenLastCalledWith(false);
    expect(handle.isSpeaking()).toBe(false);

    handle.stop();
    handle.stop();
    expect(ctx.source.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('contains analyser and consumer failures without losing cleanup or gate state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setAudioGlobal('AudioContext', FakeAudioContext);
    const changes = vi.fn(() => { throw new Error('UI callback failed'); });
    const levels = vi.fn(() => { throw new Error('meter callback failed'); });
    const handle = startVoiceActivityDetection(stream, changes, tuning, levels)!;
    const ctx = latestContext!;

    ctx.analyser.failRead = true;
    vi.advanceTimersByTime(10);
    expect(levels).not.toHaveBeenCalled();
    ctx.analyser.failRead = false;
    ctx.analyser.sample = 0.1;
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(handle.isSpeaking()).toBe(true);

    ctx.source.disconnect.mockImplementation(() => { throw new Error('already disconnected'); });
    ctx.analyser.disconnect.mockImplementation(() => { throw new Error('already disconnected'); });
    ctx.close.mockImplementation(() => { throw new Error('closed synchronously'); });
    expect(() => handle.stop()).not.toThrow();
    expect(changes).toHaveBeenLastCalledWith(false);
    expect(ctx.source.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.analyser.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed streams, constructor errors and partial graph setup', async () => {
    setAudioGlobal('AudioContext', FakeAudioContext);
    const callback = vi.fn();
    expect(startVoiceActivityDetection({} as MediaStream, callback)).toBeNull();
    expect(startVoiceActivityDetection({ getAudioTracks: () => { throw new Error('revoked'); } } as unknown as MediaStream, callback)).toBeNull();
    expect(startVoiceActivityDetection({ getAudioTracks: () => null } as unknown as MediaStream, callback)).toBeNull();

    class ThrowingContext { constructor() { throw new Error('audio unavailable'); } }
    setAudioGlobal('AudioContext', ThrowingContext);
    expect(startVoiceActivityDetection(stream, callback)).toBeNull();

    setAudioGlobal('AudioContext', FakeAudioContext);
    failContextSetup = true;
    rejectContextClose = true;
    expect(startVoiceActivityDetection(stream, callback)).toBeNull();
    expect(latestContext?.close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
  });

  it('contains asynchronous close rejection after a successful stop', async () => {
    vi.useFakeTimers();
    setAudioGlobal('AudioContext', FakeAudioContext);
    const handle = startVoiceActivityDetection(stream, vi.fn(), tuning)!;
    const ctx = latestContext!;
    ctx.close.mockImplementation(() => Promise.reject(new Error('already closed')));
    expect(() => handle.stop()).not.toThrow();
    await Promise.resolve();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });
});
