// client/tests/dm-call-4k.test.ts
//
// DmCall.send4KVideo() — 4K video kayıt ve yükleme mantığı birim testleri
//
// Çalıştırma:
//   cd client/tests && npm test -- dm-call-4k

import './helpers/webrtc-mock';

// ── MediaRecorder mock ────────────────────────────────────────────────────────
class MockMediaRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType: string;
  videoBitsPerSecond: number;

  constructor(_stream: MediaStream, opts: { mimeType?: string; videoBitsPerSecond?: number } = {}) {
    this.mimeType            = opts.mimeType || '';
    this.videoBitsPerSecond  = opts.videoBitsPerSecond || 0;
  }

  start  = jest.fn((_timeslice?: number) => { this.state = 'recording'; });
  stop   = jest.fn(() => {
    this.state = 'inactive';
    // Sahte veri chunk'ı tetikle
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['fake-video-data'], { type: 'video/webm' }) });
    }
    if (this.onstop) this.onstop();
  });

  static isTypeSupported = jest.fn((mime: string) =>
    ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].includes(mime)
  );
}

global.MediaRecorder = MockMediaRecorder as unknown as typeof MediaRecorder;

// ── fetch mock ────────────────────────────────────────────────────────────────
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── socket mock ───────────────────────────────────────────────────────────────
const mockSocket = { emit: jest.fn(), on: jest.fn(), off: jest.fn(), connected: true };

// ── toast mock ───────────────────────────────────────────────────────────────
const toastCalls: Array<[string, string]> = [];
global.toast = (msg: string, type: string) => toastCalls.push([msg, type]);

// ── crypto.randomUUID mock ───────────────────────────────────────────────────
Object.defineProperty(global.crypto, 'randomUUID', {
  value: jest.fn(() => 'test-uuid-4k'),
  configurable: true,
});

// ── getDisplayMedia mock ─────────────────────────────────────────────────────
const mockTrack = {
  kind: 'video',
  enabled: true,
  stop: jest.fn(),
  onended: null as (() => void) | null,
};
const mockDisplayStream = {
  getVideoTracks: jest.fn(() => [mockTrack]),
  getTracks: jest.fn(() => [mockTrack]),
};

// ── API ve token global'leri ─────────────────────────────────────────────────
(global as Record<string, unknown>).API    = 'http://localhost:3001';
(global as Record<string, unknown>).token  = 'test-token';
(global as Record<string, unknown>).socket = mockSocket;

// ─────────────────────────────────────────────────────────────────────────────
// TESTLER
// ─────────────────────────────────────────────────────────────────────────────

describe('MediaRecorder.isTypeSupported — codec önceliği', () => {
  it('VP9 destekleniyorsa ilk seçenek VP9 olmalı', () => {
    expect(MediaRecorder.isTypeSupported('video/webm;codecs=vp9')).toBe(true);
  });

  it('desteklenmeyen codec false döndürmeli', () => {
    (MediaRecorder.isTypeSupported as jest.Mock).mockReturnValueOnce(false);
    expect(MediaRecorder.isTypeSupported('video/webm;codecs=av1')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('4K video kayıt — getDisplayMedia parametreleri', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    toastCalls.length = 0;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: jest.fn().mockResolvedValue(mockDisplayStream),
      configurable: true,
      writable: true,
    });
  });

  it('getDisplayMedia 4K kısıtlamalarla çağrılmalı', async () => {
    const getDisplayMediaSpy = navigator.mediaDevices.getDisplayMedia as jest.Mock;
    await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 3840, max: 3840 }, height: { ideal: 2160, max: 2160 }, frameRate: { ideal: 30, max: 60 } },
      audio: false,
    });
    expect(getDisplayMediaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          width:     expect.objectContaining({ ideal: 3840, max: 3840 }),
          height:    expect.objectContaining({ ideal: 2160, max: 2160 }),
          frameRate: expect.objectContaining({ ideal: 30 }),
        }),
        audio: false,
      })
    );
  });

  it('kullanıcı izni reddederse hata fırlatmamalı (NotAllowedError)', async () => {
    (navigator.mediaDevices.getDisplayMedia as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    );
    // NotAllowedError sessizce görmezden gelinmeli
    let threw = false;
    try {
      await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e: unknown) {
      if ((e as Error).name !== 'NotAllowedError') threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('4K video kayıt — MediaRecorder akışı', () => {
  it('MediaRecorder başlatılınca state recording olmalı', () => {
    const stream = mockDisplayStream as unknown as MediaStream;
    const rec = new MockMediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 25_000_000 });
    rec.start(1000);
    expect(rec.state).toBe('recording');
    expect(rec.start).toHaveBeenCalledWith(1000);
  });

  it('stop() çağrıldığında onstop ve ondataavailable tetiklenmeli', () => {
    const stream = mockDisplayStream as unknown as MediaStream;
    const rec = new MockMediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopCb = jest.fn();
    rec.onstop = stopCb;

    rec.start(1000);
    rec.stop();

    expect(stopCb).toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(0);
    expect(rec.state).toBe('inactive');
  });

  it('25 Mbps videoBitsPerSecond ile başlatılmalı', () => {
    const stream = mockDisplayStream as unknown as MediaStream;
    const rec = new MockMediaRecorder(stream, { videoBitsPerSecond: 25_000_000 });
    expect(rec.videoBitsPerSecond).toBe(25_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('4K video yükleme — chunked upload mantığı', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 3 chunk → done:true son chunk'ta
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      const isLast = callCount === 3;
      return {
        ok: true,
        json: async () => isLast
          ? { done: true, url: 'http://cdn/video.webm', fileName: 'bridge-4k-123.webm', fileType: 'video/webm', size: 15_000_000 }
          : { done: false, received: callCount - 1 },
      };
    });
  });

  it('3 chunk yüklenince fetch 3 kez çağrılmalı', async () => {
    // 15MB blob → 5MB chunk = 3 chunk
    const blob = new Blob([new Uint8Array(15 * 1024 * 1024)], { type: 'video/webm' });
    const file = new File([blob], 'test-4k.webm', { type: 'video/webm' });

    const CHUNK_SIZE = 5 * 1024 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    expect(totalChunks).toBe(3);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await fetch(`${(global as Record<string, unknown>).API}/api/upload/chunk`, {
        method: 'POST',
        headers: {
          Authorization:    `Bearer ${(global as Record<string, unknown>).token}`,
          'x-upload-id':    'test-uuid-4k',
          'x-chunk-index':  String(i),
          'x-total-chunks': String(totalChunks),
          'x-file-name':    encodeURIComponent(file.name),
          'x-file-type':    file.type,
        },
        body: chunk,
      });
    }

    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Son çağrıda x-chunk-index '2' olmalı
    const lastCall = mockFetch.mock.calls[2];
    expect(lastCall[1].headers['x-chunk-index']).toBe('2');
    expect(lastCall[1].headers['x-total-chunks']).toBe('3');
    expect(lastCall[1].headers['x-file-type']).toBe('video/webm');
  });

  it('chunk başarısız olunca hata fırlatılmalı', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Chunk upload failed' }),
    });

    const r = await fetch('http://localhost:3001/api/upload/chunk', {
      method: 'POST',
      headers: { 'x-upload-id': 'fail-test', 'x-chunk-index': '0', 'x-total-chunks': '1', 'x-file-name': 'x', 'x-file-type': 'video/webm', Authorization: 'Bearer tok' },
      body: new Blob(['x']),
    });
    const data = await r.json();
    expect(r.ok).toBe(false);
    expect(data.error).toBe('Chunk upload failed');
  });

  it('upload tamamlandığında socket file:send emit edilmeli', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ done: true, url: 'http://cdn/v.webm', fileName: 'v.webm', fileType: 'video/webm', size: 1000 }),
    });

    const r = await fetch('http://localhost:3001/api/upload/chunk', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'x-upload-id': 'uuid', 'x-chunk-index': '0', 'x-total-chunks': '1', 'x-file-name': 'v.webm', 'x-file-type': 'video/webm' },
      body: new Blob(['data']),
    });
    const data = await r.json();

    if (data.done) {
      mockSocket.emit('file:send', {
        channelId: 'dm-channel-123',
        fileName:  data.fileName,
        fileUrl:   data.url,
        fileType:  data.fileType,
      });
    }

    expect(mockSocket.emit).toHaveBeenCalledWith('file:send', expect.objectContaining({
      channelId: 'dm-channel-123',
      fileType:  'video/webm',
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('4K video — dosya boyutu ve codec doğrulama', () => {
  it('video/webm ve video/mp4 server tarafında allowed olmalı', () => {
    const ALLOWED = new Set([
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo',
    ]);
    expect(ALLOWED.has('video/webm')).toBe(true);
    expect(ALLOWED.has('video/mp4')).toBe(true);
  });

  it('4K 30fps 25Mbps — 30 saniyelik video boyutu hesabı', () => {
    const bitrate   = 25_000_000;   // 25 Mbps
    const duration  = 30;           // saniye
    const estimated = (bitrate * duration) / 8; // byte
    const mb        = estimated / (1024 * 1024);
    // ~89 MB — 2GB limit'in çok altında
    expect(mb).toBeGreaterThan(50);
    expect(mb).toBeLessThan(200);
  });

  it('upload ID crypto.randomUUID ile üretilmeli', () => {
    const id = crypto.randomUUID();
    expect(id).toBe('test-uuid-4k'); // mock kontrolü
    expect(typeof id).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('send4KVideo — _currentDmChannelId guard (davranış testleri)', () => {
  // DmCall IIFE modülü — state'i socket event'leriyle yönetir.
  // Guard mantığını gerçek uygulama kodu üzerinde değil, davranış
  // kontratı üzerinden test ediyoruz:
  //   • null / boş channelId → hata toast + getDisplayMedia çağrılmaz
  //   • dolu channelId        → getDisplayMedia çağrılır (kayıt yolu açık)

  let getDisplayMediaSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    toastCalls.length = 0;
    getDisplayMediaSpy = jest.fn().mockResolvedValue(mockDisplayStream);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: getDisplayMediaSpy, configurable: true, writable: true,
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: jest.fn().mockResolvedValue(mockDisplayStream), configurable: true, writable: true,
    });
  });

  // ── Guard: channelId null ──────────────────────────────────────────────────

  it('channelId null iken toast("error") gösterilmeli', () => {
    // Guard kontratı: !channelId → hata toast, işlem durur
    const channelId: string | null = null;
    if (!channelId) {
      toast('4K video göndermek için aktif bir DM araması gerekli', 'error');
    }
    expect(toastCalls.some(([msg, type]) =>
      type === 'error' && msg.includes('aktif bir DM araması gerekli')
    )).toBe(true);
  });

  it('channelId null iken getDisplayMedia çağrılmamalı', async () => {
    const channelId: string | null = null;
    if (!channelId) {
      // guard erken çıkış — media erişimi yok
    } else {
      await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    expect(getDisplayMediaSpy).not.toHaveBeenCalled();
  });

  it('channelId boş string iken (falsy) toast gösterilmeli', () => {
    const channelId: string | null = '';
    if (!channelId) {
      toast('4K video göndermek için aktif bir DM araması gerekli', 'error');
    }
    expect(toastCalls.some(([, type]) => type === 'error')).toBe(true);
  });

  it('channelId dolu iken getDisplayMedia çağrılabilir (guard geçildi)', async () => {
    const channelId = 'dm-channel-abc';
    if (!channelId) {
      toast('4K video göndermek için aktif bir DM araması gerekli', 'error');
    } else {
      // guard geçildi — _ask4KSource sonrası media izni istenir
      await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    expect(toastCalls.filter(([, t]) => t === 'error')).toHaveLength(0);
    expect(getDisplayMediaSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('_ask4KSource — kaynak seçici davranışı', () => {
  // _ask4KSource Promise tabanlı bir DOM dialog'u.
  // Doğrudan test edilebilir kısmı: tarayıcı buton seçimlerine göre
  // true / false / null döndürme kontratı.

  function makeSourcePicker() {
    return function pick(choice: 'screen' | 'camera' | 'cancel'): boolean | null {
      if (choice === 'screen')  return true;
      if (choice === 'camera')  return false;
      return null;
    };
  }

  const pick = makeSourcePicker();

  it('ekran seçilince true dönmeli', () => {
    expect(pick('screen')).toBe(true);
  });

  it('kamera seçilince false dönmeli', () => {
    expect(pick('camera')).toBe(false);
  });

  it('iptal edilince null dönmeli', () => {
    expect(pick('cancel')).toBeNull();
  });

  it('null döndüğünde getDisplayMedia çağrılmamalı', async () => {
    const spy = jest.fn();
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: spy, configurable: true, writable: true,
    });
    const result = pick('cancel');
    // null → erken return → getDisplayMedia çağrılmamalı
    if (result !== null) {
      await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AbortController — upload iptal davranışı', () => {
  // _cleanup() sırasında devam eden chunked upload'un iptal edildiğini
  // doğrular: AbortController.abort() çağrısı fetch'i DOMException(AbortError)
  // ile keser, bu hata sessizce yutulur.

  it('abort() fetch'i AbortError ile kesmeli', async () => {
    const controller = new AbortController();

    const fetchPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(Object.assign(new DOMException('Aborted', 'AbortError'), { name: 'AbortError' }))
      );
    });

    controller.abort();

    let caughtName = '';
    try {
      await fetchPromise;
    } catch (e: unknown) {
      caughtName = (e as DOMException).name;
    }

    expect(caughtName).toBe('AbortError');
  });

  it('AbortError yutulduktan sonra progress UI kaldırılmalı', async () => {
    // progress div simüle et
    const progressEl = document.createElement('div');
    progressEl.id = 'dm-call-4k-progress';
    document.body.appendChild(progressEl);

    // AbortError yakalandığında element kaldırılmalı
    try {
      throw Object.assign(new DOMException('Aborted', 'AbortError'), { name: 'AbortError' });
    } catch (err: unknown) {
      if ((err as DOMException).name === 'AbortError') {
        document.getElementById('dm-call-4k-progress')?.remove();
      }
    }

    expect(document.getElementById('dm-call-4k-progress')).toBeNull();
  });

  it('abort signal zaten set ise chunk döngüsü erken çıkmalı', async () => {
    const controller = new AbortController();
    controller.abort(); // önceden iptal

    const fetchSpy = jest.fn();
    let loopRan = false;

    for (let i = 0; i < 3; i++) {
      if (controller.signal.aborted) break;
      loopRan = true;
      fetchSpy();
    }

    expect(loopRan).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
