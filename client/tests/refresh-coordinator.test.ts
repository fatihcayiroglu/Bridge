// client/tests/refresh-coordinator.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SEKMELER ARASI REFRESH TEKİLLEŞTİRME — YARIŞ TESTLERİ
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN ARIZA (Faz 1, gerçek PostgreSQL ile doğrulandı): sunucu rotasyonu
// KULLANILMIŞ bir refresh token'ın tekrar gönderilmesini REPLAY sayar ve token
// AİLESİNİ iptal eder. İki sekme aynı anda 401 alıp ikisi de refresh
// gönderdiğinde, kaybeden istek replay gibi görünür ve kullanıcı HER İKİ
// sekmede de oturumdan atılır.
//
// Sunucu davranışı DOĞRUDUR ve değiştirilmemiştir: çalınmış bir token ile
// meşru bir yarış ayırt edilemez, bu yüzden fail-closed davranılır. Düzeltme
// istemci tarafındadır — aynı tarayıcıdaki sekmeler sunucuya YALNIZCA BİR
// refresh göndermelidir.
//
// Bu testler kilidin dört zor durumunu ölçer:
//   · iki sekmeden yalnız biri sahip olur
//   · sahip çökerse kira SÜRESİ DOLAR ve devralınabilir (kilitlenme yok)
//   · bekleyen sekme sonucu görür ve KENDİ isteğini GÖNDERMEZ
//   · depolama erişilemezse koordinasyon devre dışı kalır (eski davranış)

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  tryAcquireLease, releaseLease, publishResult, waitForOtherTab,
  storageAvailable, _resetCoordinatorForTest, _KEYS,
} from '../js/core/refresh-coordinator.ts';

beforeEach(() => {
  localStorage.clear();
  _resetCoordinatorForTest();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
}

describe('kiralama — sahiplik', () => {
  it('serbestken kira ALINIR', () => {
    expect(tryAcquireLease()).toBe(true);
    expect(localStorage.getItem(_KEYS.LOCK_KEY)).toBeTruthy();
  });

  it('BAŞKA bir sekmenin taze kirası ALINAMAZ', () => {
    // Başka bir sekmeyi taklit et: farklı owner, gelecekte biten kira.
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: Date.now() + 10_000,
    }));
    expect(tryAcquireLease()).toBe(false);
  });

  it('SÜRESİ DOLMUŞ kira DEVRALINABİLİR (sahip çökmüş olabilir)', () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // Kirayı alan sekme çökerse veya kapatılırsa kilit asılı kalmamalı;
    // aksi hâlde kullanıcı bir daha ASLA token yenileyemezdi.
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'crashed-tab', expiresAt: Date.now() - 1,
    }));
    expect(tryAcquireLease()).toBe(true);
  });

  it('KENDİ kiramızı yeniden alabiliriz', () => {
    expect(tryAcquireLease()).toBe(true);
    expect(tryAcquireLease()).toBe(true);
  });

  it('releaseLease BAŞKASININ kirasını SİLMEZ', () => {
    const foreign = JSON.stringify({ owner: 'other-tab', expiresAt: Date.now() + 10_000 });
    localStorage.setItem(_KEYS.LOCK_KEY, foreign);
    releaseLease();
    expect(localStorage.getItem(_KEYS.LOCK_KEY)).toBe(foreign);
  });

  it('releaseLease KENDİ kiramızı siler', () => {
    tryAcquireLease();
    releaseLease();
    expect(localStorage.getItem(_KEYS.LOCK_KEY)).toBeNull();
  });
});

describe('bekleyen sekme', () => {
  it('BAŞARILI sonucu görür', async () => {
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: Date.now() + 10_000,
    }));
    const startedAt = Date.now();
    const waiting = waitForOtherTab(startedAt);

    // Sahip sekme başarıyla bitirir.
    publishResult(true);

    await expect(waiting).resolves.toBe(true);
  });

  it('BAŞARISIZ sonucu görür ve kendi denemesine izin verir', async () => {
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: Date.now() + 10_000,
    }));
    const waiting = waitForOtherTab(Date.now());
    publishResult(false);
    await expect(waiting).resolves.toBe(false);
  });

  it('ESKİ bir sonucu KABUL ETMEZ', async () => {
    // Kritik: önceki bir yenilemenin sonucu, şimdiki bekleyişi
    // yanlışlıkla tamamlamamalı — aksi hâlde sekme eski token'la devam ederdi.
    localStorage.setItem(_KEYS.RESULT_KEY, JSON.stringify({
      owner: 'other-tab', ok: true, at: Date.now() - 60_000,
    }));
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: Date.now() - 1,   // süresi dolmuş
    }));

    // Eski sonuç yok sayılır; kira da bittiği için beklemez, false döner.
    await expect(waitForOtherTab(Date.now())).resolves.toBe(false);
  });

  it('kira süresi dolduğunda BEKLEMEYİ BIRAKIR (sahip çökmesi)', async () => {
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'crashed-tab', expiresAt: Date.now() - 1,
    }));
    // Sonuç hiç yayınlanmaz; kira bittiği için hemen vazgeçmeli.
    await expect(waitForOtherTab(Date.now())).resolves.toBe(false);
  });

  it('storage olayinda ilgisiz anahtari yok sayar, sonuc anahtarinda uyanir', async () => {
    const startedAt = Date.now();
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: startedAt + 10_000,
    }));
    const waiting = waitForOtherTab(startedAt);

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    localStorage.setItem(_KEYS.RESULT_KEY, JSON.stringify({
      owner: 'other-tab', ok: true, at: startedAt,
    }));
    window.dispatchEvent(new StorageEvent('storage', { key: _KEYS.RESULT_KEY }));

    await expect(waiting).resolves.toBe(true);
  });

  it('BroadcastChannel yoksa storage olayi tek basina sonucu tasir', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const startedAt = Date.now();
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: startedAt + 10_000,
    }));
    const waiting = waitForOtherTab(startedAt);

    publishResult(true);
    window.dispatchEvent(new StorageEvent('storage', { key: _KEYS.RESULT_KEY }));

    await expect(waiting).resolves.toBe(true);
  });

  it('BroadcastChannel mesajini yasina gore suzer ve yalniz bir kez tamamlanir', async () => {
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel as unknown as typeof BroadcastChannel);
    const startedAt = Date.now();
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: startedAt + 10_000,
    }));

    const waiting = waitForOtherTab(startedAt);
    const channel = FakeBroadcastChannel.instances[0]!;
    const handler = channel.onmessage!;
    handler({ data: undefined } as MessageEvent);
    handler({ data: { owner: 'other-tab', ok: false, at: startedAt - 1 } } as MessageEvent);
    handler({ data: { owner: 'other-tab', ok: true, at: startedAt } } as MessageEvent);

    await expect(waiting).resolves.toBe(true);
    expect(channel.close).toHaveBeenCalledOnce();
    // Gec gelen ikinci uyari resolve'u veya temizligi ikinci kez calistirmamali.
    handler({ data: { owner: 'other-tab', ok: false, at: startedAt + 1 } } as MessageEvent);
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('BroadcastChannel kurulamazsa yoklamaya duser ve sinirli zamanda vazgecer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', class {
      constructor() { throw new Error('channel unavailable'); }
    } as unknown as typeof BroadcastChannel);
    const startedAt = Date.now();
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'other-tab', expiresAt: startedAt + 60_000,
    }));

    const waiting = waitForOtherTab(startedAt);
    await vi.advanceTimersByTimeAsync(_KEYS.WAIT_TIMEOUT_MS);
    await expect(waiting).resolves.toBe(false);
  });
});

describe('sonuc yayini', () => {
  it('BroadcastChannel varsa sonucu hem depoya hem kanala yazar ve kanali kapatir', () => {
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel as unknown as typeof BroadcastChannel);

    publishResult(true);

    const stored = JSON.parse(localStorage.getItem(_KEYS.RESULT_KEY)!) as { ok: boolean };
    expect(stored.ok).toBe(true);
    const channel = FakeBroadcastChannel.instances[0]!;
    expect(channel.name).toBe(_KEYS.CHANNEL_NAME);
    expect(channel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('BroadcastChannel gonderimi hata verirse depolanan sonuc korunur', () => {
    vi.stubGlobal('BroadcastChannel', class {
      constructor() { throw new Error('channel unavailable'); }
    } as unknown as typeof BroadcastChannel);

    expect(() => publishResult(false)).not.toThrow();
    expect(JSON.parse(localStorage.getItem(_KEYS.RESULT_KEY)!).ok).toBe(false);
  });
});

describe('depolama erişilemezken', () => {
  it('storageAvailable false döner ve koordinasyon devre dışı kalır', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(storageAvailable()).toBe(false);
    // Kira da alınamaz → çağıran eski sekme-içi davranışa döner.
    expect(tryAcquireLease()).toBe(false);
    spy.mockRestore();
  });

  it('okuma hata verirse kira islemleri guvenli bicimde basarisiz olur', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(tryAcquireLease()).toBe(false);
    expect(() => releaseLease()).not.toThrow();
    spy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UÇTAN UCA: iki "sekme" aynı anda yeniler → SUNUCUYA TEK İSTEK
// ════════════════════════════════════════════════════════════════════════════
describe('api-fetch entegrasyonu — sekmeler arası tek uçuş', () => {
  it('ikinci sekme KENDİ refresh isteğini GÖNDERMEZ', async () => {
    // Sahip sekmeyi taklit et: kirayı o almış ve henüz bitirmemiş.
    localStorage.setItem(_KEYS.LOCK_KEY, JSON.stringify({
      owner: 'owner-tab', expiresAt: Date.now() + 10_000,
    }));

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../js/core/api-fetch.ts');
    mod.resetRefreshState();

    const pending = mod.refreshAccessToken();

    // Sahip sekme başarıyla bitirir ve yeni token'ı paylaşılan depoya yazar.
    localStorage.setItem('token', 'yeni-token-sahipten');
    localStorage.setItem('bridge_token', 'yeni-token-sahipten');
    publishResult(true);

    await expect(pending).resolves.toBe(true);
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // Sunucuya İKİNCİ bir refresh gitmedi; dolayısıyla replay tetiklenmez ve
    // token ailesi iptal edilmez.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('kira serbestken KENDİ isteğini gönderir (yanlış pozitif kontrolü)', async () => {
    // Yukarıdaki iddia, `refreshAccessToken` hiç istek göndermese de geçerdi.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ token: 'taze-token' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../js/core/api-fetch.ts');
    mod.resetRefreshState();

    await expect(mod.refreshAccessToken()).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/refresh');

    vi.unstubAllGlobals();
  });
});
