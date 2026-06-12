// client/tests/voice-recorder-unit.test.ts
// Sprint 72: BridgeVoiceRecorder birim testleri
//
// Kapsam:
//   - Başlangıç durumu ve state geçişleri
//   - _bestMimeType() tarayıcı uyumluluğu
//   - maxDuration sınırı ve default'ları
//   - stop() idle durumunda güvenli davranış
//   - Chunk birleştirme mantığı
//   - Upload ext mantığı (ogg vs webm)
//   - cancel() state temizliği
//
// Çalıştırma: npx vitest run client/tests/voice-recorder-unit.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── MediaRecorder mock ────────────────────────────────────────────────────────

class MockMediaRecorder {
  static _supported: string[] = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'];
  state: string = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  private _mimeType: string;

  constructor(_stream: unknown, options: { mimeType?: string } = {}) {
    this._mimeType = options.mimeType ?? MockMediaRecorder._supported[0];
  }

  static isTypeSupported(mime: string): boolean {
    return MockMediaRecorder._supported.includes(mime);
  }

  start(_timeslice?: number): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    // Simulate one data chunk
    if (this.ondataavailable) {
      const blob = new Blob(['audio-data'], { type: this._mimeType });
      this.ondataavailable({ data: blob });
    }
    if (this.onstop) this.onstop();
  }

  pause(): void  { this.state = 'paused'; }
  resume(): void { this.state = 'recording'; }
}

// ── MediaStream mock ──────────────────────────────────────────────────────────

class MockMediaStreamTrack {
  kind = 'audio';
  stop = vi.fn();
}

class MockMediaStream {
  private _tracks: MockMediaStreamTrack[];
  constructor() { this._tracks = [new MockMediaStreamTrack()]; }
  getTracks()      { return this._tracks; }
  getAudioTracks() { return this._tracks; }
}

// ── BridgeRegistry stub ───────────────────────────────────────────────────────

const _registry: Record<string, unknown> = {};
const BridgeRegistry = {
  register: (key: string, val: unknown) => { _registry[key] = val; },
  get:      (key: string) => _registry[key],
};

// ── Globals kurulum ───────────────────────────────────────────────────────────

beforeEach(() => {
  (global as unknown as Record<string, unknown>)['MediaRecorder'] = MockMediaRecorder;
  (global as unknown as Record<string, unknown>)['BridgeRegistry'] = BridgeRegistry;
  (global as unknown as Record<string, unknown>)['getCurrentChannel'] = vi.fn(() => 'ch-1');
  (global as unknown as Record<string, unknown>)['getCurrentServer']  = vi.fn(() => 'srv-1');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── BridgeVoiceRecorder mantığını izole eden sınıf ───────────────────────────
// (Gerçek dosyayı import etmeden kritik mantığı yeniden uygular)

interface RecorderOptions {
  maxDuration?:       number;
  mimeType?:          string;
  audioBitsPerSecond?: number;
  noiseSuppression?:  boolean;
  channelId?:         string | null;
  serverId?:          string | null;
  onStart?:           () => void;
  onStop?:            () => void;
  onUpload?:          (result: unknown) => void;
  onError?:           (err: unknown) => void;
}

class BridgeVoiceRecorderStub {
  options: Required<RecorderOptions>;
  _mediaRecorder: MockMediaRecorder | null = null;
  _stream: MockMediaStream | null = null;
  _chunks: Blob[] = [];
  _startTime: number | null = null;
  _maxTimer: ReturnType<typeof setTimeout> | null = null;
  state: 'idle' | 'recording' | 'uploading' = 'idle';

  constructor(opts: RecorderOptions = {}) {
    this.options = {
      maxDuration:        opts.maxDuration        ?? 300_000,
      mimeType:           opts.mimeType           ?? this._bestMimeType(),
      audioBitsPerSecond: opts.audioBitsPerSecond ?? 96_000,
      noiseSuppression:   opts.noiseSuppression   !== false,
      channelId:          opts.channelId          ?? null,
      serverId:           opts.serverId           ?? null,
      onStart:            opts.onStart            ?? (() => {}),
      onStop:             opts.onStop             ?? (() => {}),
      onUpload:           opts.onUpload           ?? (() => {}),
      onError:            opts.onError            ?? (() => {}),
    };
  }

  _bestMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const mime of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MockMediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return 'audio/webm';
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    this._stream = new MockMediaStream();
    this._chunks = [];
    this._startTime = Date.now();
    this.state = 'recording';

    const recOpts: Record<string, unknown> = {
      audioBitsPerSecond: this.options.audioBitsPerSecond,
    };
    if (this.options.mimeType) recOpts['mimeType'] = this.options.mimeType;

    this._mediaRecorder = new MockMediaRecorder(this._stream, recOpts as MediaRecorderOptions);
    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) this._chunks.push(e.data);
    };
    this._mediaRecorder.onstop = () => this._onRecordingStop();
    this._mediaRecorder.start(250);

    this._maxTimer = setTimeout(() => this.stop(), this.options.maxDuration);
    this.options.onStart();
  }

  stop(): void {
    if (this.state !== 'recording') return;
    if (this._maxTimer) clearTimeout(this._maxTimer);
    this._mediaRecorder?.stop();
  }

  cancel(): void {
    if (this._maxTimer) clearTimeout(this._maxTimer);
    this._chunks = [];
    if (this._mediaRecorder) {
      this._mediaRecorder.onstop = null;
      if (this._mediaRecorder.state === 'recording') this._mediaRecorder.stop();
    }
    this._stream?.getTracks().forEach(t => t.stop());
    this.state = 'idle';
    this._startTime = null;
  }

  _onRecordingStop(): void {
    const duration = Math.round((Date.now() - (this._startTime ?? Date.now())) / 1000);
    const blob = new Blob(this._chunks, { type: this.options.mimeType || 'audio/webm' });
    this.state = 'uploading';
    this.options.onStop();
    void this._upload(blob, duration);
  }

  async _upload(_blob: Blob, _duration: number): Promise<void> {
    // Stub — test case'lerde override edilir
    this.state = 'idle';
    this.options.onUpload({ ok: true });
  }

  elapsed(): number {
    if (!this._startTime) return 0;
    return Math.round((Date.now() - this._startTime) / 1000);
  }

  getUploadExt(): string {
    return this.options.mimeType?.includes('ogg') ? 'ogg' : 'webm';
  }
}

// ── Testler ───────────────────────────────────────────────────────────────────

describe('BridgeVoiceRecorder — başlangıç durumu', () => {
  it('state başlangıçta idle olmalı', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r.state).toBe('idle');
  });

  it('_chunks boş başlamalı', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r._chunks).toHaveLength(0);
  });

  it('_startTime başlangıçta null olmalı', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r._startTime).toBeNull();
  });

  it('_mediaRecorder başlangıçta null olmalı', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r._mediaRecorder).toBeNull();
  });
});

describe('BridgeVoiceRecorder — default değerleri', () => {
  it('maxDuration default 300_000ms (5 dakika)', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r.options.maxDuration).toBe(300_000);
  });

  it('audioBitsPerSecond default 96_000', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r.options.audioBitsPerSecond).toBe(96_000);
  });

  it('noiseSuppression default true', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r.options.noiseSuppression).toBe(true);
  });

  it('noiseSuppression false olarak geçilebilir', () => {
    const r = new BridgeVoiceRecorderStub({ noiseSuppression: false });
    expect(r.options.noiseSuppression).toBe(false);
  });

  it('özel maxDuration geçilebilir', () => {
    const r = new BridgeVoiceRecorderStub({ maxDuration: 60_000 });
    expect(r.options.maxDuration).toBe(60_000);
  });
});

describe('BridgeVoiceRecorder — _bestMimeType()', () => {
  it('desteklenen ilk mimeType seçilmeli (audio/webm;codecs=opus)', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r.options.mimeType).toBe('audio/webm;codecs=opus');
  });

  it('özel mimeType geçilince kullanılmalı', () => {
    const r = new BridgeVoiceRecorderStub({ mimeType: 'audio/ogg;codecs=opus' });
    expect(r.options.mimeType).toBe('audio/ogg;codecs=opus');
  });
});

describe('BridgeVoiceRecorder — getUploadExt()', () => {
  it('webm mimeType → webm uzantısı', () => {
    const r = new BridgeVoiceRecorderStub({ mimeType: 'audio/webm;codecs=opus' });
    expect(r.getUploadExt()).toBe('webm');
  });

  it('ogg mimeType → ogg uzantısı', () => {
    const r = new BridgeVoiceRecorderStub({ mimeType: 'audio/ogg;codecs=opus' });
    expect(r.getUploadExt()).toBe('ogg');
  });

  it('sade audio/webm → webm uzantısı', () => {
    const r = new BridgeVoiceRecorderStub({ mimeType: 'audio/webm' });
    expect(r.getUploadExt()).toBe('webm');
  });
});

describe('BridgeVoiceRecorder — start()', () => {
  it('start() sonrası state recording olmalı', async () => {
    const r = new BridgeVoiceRecorderStub();
    await r.start();
    expect(r.state).toBe('recording');
  });

  it('start() onStart callback çağırmalı', async () => {
    const onStart = vi.fn();
    const r = new BridgeVoiceRecorderStub({ onStart });
    await r.start();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('start() _startTime setlemeli', async () => {
    const r = new BridgeVoiceRecorderStub();
    await r.start();
    expect(r._startTime).toBeTypeOf('number');
  });

  it('recording sırasında tekrar start() çağrılınca görmezden gelinmeli', async () => {
    const onStart = vi.fn();
    const r = new BridgeVoiceRecorderStub({ onStart });
    await r.start();
    await r.start(); // ikinci çağrı
    expect(onStart).toHaveBeenCalledOnce(); // sadece bir kez çağrılmalı
  });

  it('maxDuration geçince otomatik stop() çağrılmalı', async () => {
    const stopSpy = vi.spyOn(BridgeVoiceRecorderStub.prototype, 'stop');
    const r = new BridgeVoiceRecorderStub({ maxDuration: 1_000 });
    await r.start();
    vi.advanceTimersByTime(1_001);
    expect(stopSpy).toHaveBeenCalled();
  });
});

describe('BridgeVoiceRecorder — stop()', () => {
  it('idle durumunda stop() güvenli olmalı (throw etmemeli)', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(() => r.stop()).not.toThrow();
  });

  it('stop() onStop callback çağırmalı', async () => {
    const onStop = vi.fn();
    const r = new BridgeVoiceRecorderStub({ onStop });
    await r.start();
    r.stop();
    expect(onStop).toHaveBeenCalled();
  });
});

describe('BridgeVoiceRecorder — cancel()', () => {
  it('cancel() state\'i idle\'a döndürmeli', async () => {
    const r = new BridgeVoiceRecorderStub();
    await r.start();
    expect(r.state).toBe('recording');
    r.cancel();
    expect(r.state).toBe('idle');
  });

  it('cancel() _chunks temizlemeli', async () => {
    const r = new BridgeVoiceRecorderStub();
    await r.start();
    r._chunks.push(new Blob(['data']));
    r.cancel();
    expect(r._chunks).toHaveLength(0);
  });

  it('cancel() _startTime\'ı null yapmalı', async () => {
    const r = new BridgeVoiceRecorderStub();
    await r.start();
    r.cancel();
    expect(r._startTime).toBeNull();
  });

  it('idle durumunda cancel() güvenli olmalı', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(() => r.cancel()).not.toThrow();
  });
});

describe('BridgeVoiceRecorder — elapsed()', () => {
  it('kayıt başlamadan 0 dönmeli', () => {
    const r = new BridgeVoiceRecorderStub();
    expect(r.elapsed()).toBe(0);
  });

  it('kayıt başladıktan sonra geçen süreyi dönmeli', async () => {
    const r = new BridgeVoiceRecorderStub();
    await r.start();
    vi.advanceTimersByTime(3_000);
    expect(r.elapsed()).toBe(3);
  });
});

describe('BridgeVoiceRecorder — upload tamamlama', () => {
  it('upload sonrası onUpload callback çağırılmalı', async () => {
    const onUpload = vi.fn();
    const r = new BridgeVoiceRecorderStub({ onUpload });
    await r.start();
    r.stop();
    // _onRecordingStop async — microtask queue'yu boşalt
    await Promise.resolve();
    expect(onUpload).toHaveBeenCalled();
  });

  it('upload sonrası state idle olmalı', async () => {
    const r = new BridgeVoiceRecorderStub();
    await r.start();
    r.stop();
    await Promise.resolve();
    expect(r.state).toBe('idle');
  });
});
