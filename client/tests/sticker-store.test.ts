// client/tests/sticker-store.test.ts
import { t } from '../js/core/i18n/index.ts';
// FAZ C3 — STICKER KONTROLCÜSÜ (gerçek sözleşme).
//
// Arka uç: routes/sticker-packs.ts
//   GET    /api/servers/:sid/sticker-packs          (VIEW_CHANNELS)
//   DELETE /api/servers/:sid/sticker-packs/:packId  (MANAGE_SERVER + kiracı)
//   PATCH  .../:packId/stickers/:stickerId          (MANAGE_SERVER + kiracı)
//
// GÖNDERME YOKTUR: `messages` tablosunda sticker sütunu, ALLOWED_COLUMNS'ta
// sticker girdisi ve kanonik gönderim yolunda `sticker` tipi YOK.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkStickerFiles,
  createStickerController,
  isSafeStickerUrl,
  STICKER_MAX_FILE_SIZE,
} from '../js/core/stickers/stickerStore.ts';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const SID = 'srv-A';

let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

const ok  = (b: unknown, status = 200) => ({ ok: true, status, json: async () => b } as unknown as Response);
const err = (s: number, e: string) => ({ ok: false, status: s, json: async () => ({ error: e }) } as unknown as Response);

const STICKER = (over: Record<string, unknown> = {}) => ({
  id: 'st-1', packId: 'pack-1', name: 'gulen', url: '/uploads/stickers/a.png',
  tags: ['mutlu'], width: 160, height: 160, ...over,
});
const PACK = (over: Record<string, unknown> = {}) => ({
  _id: 'pack-1', serverId: SID, name: 'Paket', description: 'aciklama',
  authorId: 'u1', stickers: [STICKER()], createdAt: 123, ...over,
});

beforeEach(() => {
  BridgeRegistry.register('getCurrentServer', () => ({ _id: SID, id: SID }));
  fetchMock = vi.fn(async () => ok([PACK()]));
});

afterEach(() => {
  BridgeRegistry.unregister('getCurrentServer');
  vi.restoreAllMocks();
});

async function loaded(packs: unknown[] = [PACK()]) {
  fetchMock = vi.fn(async () => ok(packs));
  const c = createStickerController(SID);
  await c.load();
  fetchMock.mockClear();
  return c;
}

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — yükleme ve sözleşme', () => {
  it('GERÇEK uç noktadan yükler', async () => {
    const c = createStickerController(SID);

    expect(await c.load()).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0]))
      .toBe(`http://test/api/servers/${SID}/sticker-packs`);
  });

  it('paket ve sticker alanlarını sözleşmeye göre çözer', async () => {
    const c = await loaded();
    const p = c.snapshot.packs[0]!;

    expect(p._id).toBe('pack-1');
    expect(p.createdAt).toBe(123);
    expect(p.stickers[0]!.id).toBe('st-1');
    expect(p.stickers[0]!.tags).toEqual(['mutlu']);
  });

  it('yükleme hatası BAŞARI raporlamaz', async () => {
    fetchMock = vi.fn(async () => err(403, 'Bu sunucuya erişim izniniz yok.'));
    const c = createStickerController(SID);

    expect(await c.load()).toBe(false);
    // Sunucu govdesi kullaniciya SIZMAZ: 403 kanonik metne eslenir.
    expect(c.snapshot.error).toBe(t('error_forbidden'));
    expect(String(c.snapshot.error)).not.toContain('erişim izniniz yok');
    expect(c.snapshot.packs).toEqual([]);
  });

  it('bozuk/eksik veri çökertmez, elenir', async () => {
    const c = await loaded([PACK(), { yok: true }, null, PACK({ _id: '' })]);

    expect(c.snapshot.packs).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// URL beyaz listesi — sticker verisi güvenilmez girdi olarak ele alınır
// ════════════════════════════════════════════════════════════════════════════
describe('C3 — GÜVENLİK: sticker URL beyaz listesi', () => {
  it('yalnız /uploads/stickers/ yolları güvenlidir', () => {
    expect(isSafeStickerUrl('/uploads/stickers/a.png')).toBe(true);
  });

  it('GÜVENLİK: javascript:/data: ve dış URL REDDEDİLİR', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'https://kotu.example/a.png',
      '//kotu.example/a.png',
      '/uploads/stickers/../../etc/passwd',
      '/baska/yol/a.png',
      '',
      null,
      42,
    ]) {
      expect(isSafeStickerUrl(bad)).toBe(false);
    }
  });

  it('GÜVENLİK: güvensiz URL taşıyan sticker LİSTEYE GİRMEZ', async () => {
    const c = await loaded([PACK({
      stickers: [STICKER(), STICKER({ id: 'st-kotu', url: 'javascript:alert(1)' })],
    })]);

    const urls = c.snapshot.packs[0]!.stickers.map(s => s.url);
    expect(urls).toEqual(['/uploads/stickers/a.png']);
    expect(c.snapshot.packs[0]!.stickers.some(s => s.id === 'st-kotu')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — silme (MANAGE_SERVER)', () => {
  it('paketi DELETE ile siler ve yerel durumu günceller', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(ok(null, 204));

    expect(await c.deletePack('pack-1')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://test/api/servers/${SID}/sticker-packs/pack-1`);
    expect((init as RequestInit).method).toBe('DELETE');
    expect(c.snapshot.packs).toHaveLength(0);
  });

  it('arka uç reddederse yerel durum DEĞİŞMEZ (sahte başarı yok)', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(err(403, 'Sticker paketi silme izniniz yok.'));

    expect(await c.deletePack('pack-1')).toBe(false);
    expect(c.snapshot.packs).toHaveLength(1);
    expect(c.snapshot.error).toBe(t('error_forbidden'));
    expect(String(c.snapshot.error)).not.toContain('izniniz yok');
  });

  it('GÜVENLİK: YÜKLENMEMİŞ (yabancı) paket kimliği için istek ATILMAZ', async () => {
    const c = await loaded();

    expect(await c.deletePack('baska-sunucunun-paketi')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: sunucu değiştiyse SİLMEZ (bayat bağlam)', async () => {
    const c = await loaded();
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));

    expect(await c.deletePack('pack-1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: çift gönderim tek istek üretir', async () => {
    const c = await loaded();
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>(r => { release = r; }));

    const first = c.deletePack('pack-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await c.deletePack('pack-1')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(ok(null, 204));
    await first;
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — sticker yeniden adlandırma (MANAGE_SERVER)', () => {
  it('PATCH ile adı günceller', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(ok({ ok: true }));

    expect(await c.renameSticker('pack-1', 'st-1', 'yeni ad')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://test/api/servers/${SID}/sticker-packs/pack-1/stickers/st-1`);
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: 'yeni ad' });
    expect(c.snapshot.packs[0]!.stickers[0]!.name).toBe('yeni ad');
  });

  it('boş ad reddedilir ve istek ATILMAZ', async () => {
    const c = await loaded();

    expect(await c.renameSticker('pack-1', 'st-1', '   ')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: pakette OLMAYAN sticker için istek ATILMAZ', async () => {
    const c = await loaded();

    expect(await c.renameSticker('pack-1', 'baska-paketin-stickeri', 'x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('arka uç hatası yerel adı DEĞİŞTİRMEZ', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(err(403, 'İzin gerekli.'));

    expect(await c.renameSticker('pack-1', 'st-1', 'yeni')).toBe(false);
    expect(c.snapshot.packs[0]!.stickers[0]!.name).toBe('gulen');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — kapsam dürüstlüğü', () => {
  it('kontrolcü GÖNDERME yüzeyi SUNMAZ (arka uç sözleşmesi yok)', () => {
    const c = createStickerController(SID);
    const keys = Object.keys(c);

    expect(keys.some(k => /send|gonder|post.*message/i.test(k))).toBe(false);
  });

  it('kontrolcü HTML üretmez — yalnız tipli veri yayar', async () => {
    const c = await loaded();

    for (const v of Object.values(c.snapshot)) {
      expect(String(v)).not.toMatch(/<[a-z]/i);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C3 — PAKET OLUŞTURMA (kontrolcü seviyesi)
// ════════════════════════════════════════════════════════════════════════════
// Arayüz, yükleme sırasında gönderim düğmesini zaten devre dışı bırakır; bu
// yüzden panel testleri kontrolcüdeki çift gönderim kapısına HİÇ ulaşamaz.
// Buradaki testler o kapıyı DOĞRUDAN hedefler (savunma katmanı ayrı ayrı
// kanıtlanmalıdır).
describe('C3 — createPack sözleşmesi ve korumaları', () => {
  const png = (name = 'a.png') => new File([new Uint8Array(8)], name, { type: 'image/png' });

  it('FormData ile gerçek uca POST eder', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(ok({ _id: 'yeni', serverId: SID, name: 'Yeni', description: '', authorId: 'u', stickers: [], createdAt: 2 }, 201));

    expect(await c.createPack('Yeni', 'aciklama', [png()])).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://test/api/servers/${SID}/sticker-packs`);
    expect((init as RequestInit).method).toBe('POST');
    const body = (init as RequestInit).body as FormData;
    expect(body.get('name')).toBe('Yeni');
    expect(body.getAll('sticker')).toHaveLength(1);
  });

  it('GÜVENLİK: çift çağrı TEK istek üretir (kontrolcü kapısı)', async () => {
    const c = await loaded();
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>(r => { release = r; }));

    const first = c.createPack('Yeni', '', [png()]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await c.createPack('Yeni', '', [png()])).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(ok({ _id: 'yeni', serverId: SID, name: 'Yeni', description: '', authorId: 'u', stickers: [], createdAt: 2 }, 201));
    await first;
  });

  it('GÜVENLİK: sunucu değiştiyse OLUŞTURMAZ (bayat bağlam)', async () => {
    const c = await loaded();
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));

    expect(await c.createPack('Yeni', '', [png()])).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('boş ad veya dosyasız çağrı istek ATMAZ', async () => {
    const c = await loaded();

    expect(await c.createPack('   ', '', [png()])).toBe(false);
    expect(await c.createPack('Yeni', '', [])).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('50 dosyadan fazlası kontrolcüde REDDEDİLİR', async () => {
    const c = await loaded();
    const many = Array.from({ length: 51 }, (_, i) => png(`s${i}.png`));

    expect(await c.createPack('Yeni', '', many)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('arka uç hatası sahte başarı ÜRETMEZ ve listeyi değiştirmez', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(err(415, 'Geçersiz sticker formatı. PNG, WebP veya GIF gerekli.'));

    expect(await c.createPack('Yeni', '', [png()])).toBe(false);
    expect(c.snapshot.packs).toHaveLength(1);
    expect(String(c.snapshot.error)).toMatch(/PNG, WebP veya GIF/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C3 — TAMAMLANMA ANINDA BAYAT SUNUCU
// ════════════════════════════════════════════════════════════════════════════
// Panel, sunucu değişiminde kapandığı için bu kapı ARAYÜZDEN gözlenemez;
// doğrudan kontrolcüde kanıtlanmalıdır. İstek başlarken bağlam geçerliydi,
// yanıt döndüğünde kullanıcı başka sunucuya geçmişti.
describe('C3 — GÜVENLİK: yükleme TAMAMLANIRKEN sunucu değişmişse durum kirlenmez', () => {
  const png = (name = 'a.png') => new File([new Uint8Array(8)], name, { type: 'image/png' });

  it('geç dönen 201 yanıtı yerel paket listesine EKLENMEZ', async () => {
    const c = await loaded();
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>(r => { release = r; }));

    const pending = c.createPack('Yeni', '', [png()]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // İstek uçarken kullanıcı B sunucusuna geçti.
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));

    release(ok({ _id: 'A-paketi', serverId: SID, name: 'A Paketi', description: '', authorId: 'u', stickers: [], createdAt: 9 }, 201));

    expect(await pending).toBe(false);                 // sahte başarı YOK
    expect(c.snapshot.packs.some(p => p._id === 'A-paketi')).toBe(false);
    expect(c.snapshot.packs).toHaveLength(1);          // yalnız önceden yüklenen
  });
});

describe('C3 — derin normalizasyon ve dosya sınırları', () => {
  it('kodlanmış traversal, ters eğik çizgi, sorgu ve hash URL biçimlerini reddeder', () => {
    expect(isSafeStickerUrl('  /uploads/stickers/legacy-file.png  ')).toBe(true);
    for (const bad of [
      '/uploads/stickers/%2e%2e/secret.png',
      '/uploads/stickers/%252e%252e.png',
      '/uploads/stickers/a\\..\\secret.png',
      '/uploads/stickers/a.png?redirect=https://evil.test',
      '/uploads/stickers/a.png#fragment',
      '/uploads/stickers/.hidden',
      '/uploads/stickers/a%2fpayload.png',
      '/uploads/stickers/a.\npng',
    ]) expect(isSafeStickerUrl(bad)).toBe(false);
  });

  it('canonicalizes sticker ownership and dimensions while filtering foreign packs', async () => {
    const c = await loaded([
      PACK({
        stickers: [
          null,
          {},
          STICKER({ packId: 'foreign-pack', url: ' /uploads/stickers/a.png ', tags: null, width: -1, height: '200' }),
          STICKER({ id: 'st-max', url: '/uploads/stickers/max.webp', width: 4096, height: Infinity }),
          STICKER({ id: 'st-default-name', name: undefined, url: '/uploads/stickers/unnamed.gif' }),
        ],
      }),
      PACK({ _id: 'foreign', serverId: 'srv-B' }),
      { _id: 'minimal', serverId: SID, stickers: null },
      { _id: 'missing-server' },
    ]);

    expect(c.snapshot.packs.map(p => p._id)).toEqual(['pack-1', 'minimal']);
    const [first, second] = c.snapshot.packs;
    expect(first!.stickers).toHaveLength(3);
    expect(first!.stickers[0]).toMatchObject({ packId: 'pack-1', url: '/uploads/stickers/a.png', tags: [], width: 160, height: 200 });
    expect(first!.stickers[1]).toMatchObject({ width: 4096, height: 160 });
    expect(second).toMatchObject({ name: '', description: '', authorId: '', stickers: [], createdAt: 0 });
  });

  it('classifies invalid type, size and count without silently truncating', () => {
    const png = (name: string, size = 1) => new File([new Uint8Array(size)], name, { type: 'image/png' });
    const files = [
      new File(['x'], 'bad.svg', { type: 'image/svg+xml' }),
      png('large.png', STICKER_MAX_FILE_SIZE + 1),
      ...Array.from({ length: 52 }, (_, i) => png(`ok-${i}.png`)),
    ];
    const checked = checkStickerFiles(files);
    expect(checked.accepted).toHaveLength(50);
    expect(checked.rejected.map(r => r.reason)).toEqual(['type', 'size', 'count', 'count']);
  });
});

describe('C3 — load yarışları ve dürüst hata sınırları', () => {
  it('bozuk başarı gövdesini reddeder, gövdesiz HTTP ve ağ hatalarını açıklar', async () => {
    const c = createStickerController(SID);
    fetchMock.mockResolvedValueOnce(ok({ not: 'an array' }));
    expect(await c.load()).toBe(false);
    expect(c.snapshot.error).toContain('geçersiz');

    fetchMock.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => { throw new Error('no body'); },
    } as unknown as Response);
    expect(await c.load()).toBe(false);
    // Durum KODU kullaniciya gosterilmez; kanonik metin gosterilir.
    expect(c.snapshot.error).toBe(t('error_server'));

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await c.load()).toBe(false);
    // `Error('offline')` AG hatasi olarak siniflandirilir (api-error.ts
    // NETWORK_ERROR_HINTS); Response olmayan bir string ise siniflandirilamaz
    // ve yalnizca o zaman cagiranin yedek metni kullanilir.
    expect(c.snapshot.error).toBe(t('error_network'));
    fetchMock.mockRejectedValueOnce('offline-string');
    expect(await c.load()).toBe(false);
    expect(c.snapshot.error).toBe(t('sticker_packs_load_failed'));
    c.clearError();
    expect(c.snapshot.error).toBeNull();
  });

  it('latest-wins: eski load yanıtı yeni listeyi geri alamaz', async () => {
    const c = createStickerController(SID);
    let releaseOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseOld = resolve; }))
      .mockResolvedValueOnce(ok([PACK({ name: 'Yeni' })]));

    const oldLoad = c.load();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newLoad = c.load();
    expect(c.snapshot.loading).toBe(true);
    expect(await newLoad).toBe(true);
    releaseOld(ok([PACK({ name: 'Eski' })]));
    expect(await oldLoad).toBe(false);
    expect(c.snapshot.packs[0]!.name).toBe('Yeni');
    expect(c.snapshot.loading).toBe(false);

    let releaseOldError!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseOldError = resolve; }))
      .mockResolvedValueOnce(ok([PACK({ name: 'En yeni' })]));
    const obsoleteError = c.load();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await c.load()).toBe(true);
    releaseOldError(err(503, 'obsolete error'));
    expect(await obsoleteError).toBe(false);
    expect(c.snapshot.error).toBeNull();

    let rejectOld!: (reason: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce(ok([PACK({ name: 'Son' })]));
    const obsoleteRejection = c.load();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(await c.load()).toBe(true);
    rejectOld(new Error('obsolete rejection'));
    expect(await obsoleteRejection).toBe(false);
    expect(c.snapshot.packs[0]!.name).toBe('Son');
  });

  it('sunucu değişimi ve eşzamanlı silme eski load sonucunu geçersiz kılar', async () => {
    const c = await loaded();
    let releaseLoad!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseLoad = resolve; }))
      .mockResolvedValueOnce(ok(null, 204));
    const pendingLoad = c.load();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await c.deletePack('pack-1')).toBe(true);
    releaseLoad(ok([PACK()]));
    expect(await pendingLoad).toBe(false);
    expect(c.snapshot.packs).toEqual([]);

    let releaseStale!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseStale = resolve; }));
    const stale = c.load();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));
    releaseStale(ok([PACK()]));
    expect(await stale).toBe(false);
    expect(c.snapshot.packs).toEqual([]);
  });

  it('boş veya çözülemeyen sunucu bağlamında istek atmaz', async () => {
    expect(await createStickerController('').load()).toBe(false);
    BridgeRegistry.unregister('getCurrentServer');
    expect(await createStickerController(SID).load()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('C3 — mutasyon hata, kodlama ve bayat-yanıt sınırları', () => {
  it('kimlikleri URL segmenti olarak kodlar', async () => {
    const specialServer = 'srv/A ?';
    BridgeRegistry.register('getCurrentServer', () => ({ _id: specialServer, id: specialServer }));
    const specialPack = PACK({
      _id: 'pack/one?', serverId: specialServer,
      stickers: [
        STICKER({ id: 'st/one?', packId: 'pack/one?' }),
        STICKER({ id: 'untouched', packId: 'pack/one?', url: '/uploads/stickers/other.png' }),
      ],
    });
    fetchMock.mockResolvedValueOnce(ok([specialPack]));
    const c = createStickerController(specialServer);
    expect(await c.load()).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/servers/srv%2FA%20%3F/sticker-packs');

    fetchMock.mockResolvedValueOnce(ok({ ok: true }));
    expect(await c.renameSticker('pack/one?', 'st/one?', 'renamed')).toBe(true);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/pack%2Fone%3F/stickers/st%2Fone%3F');
    expect(c.snapshot.packs[0]!.stickers[1]!.name).toBe('gulen');
    fetchMock.mockResolvedValueOnce(ok(null, 204));
    expect(await c.deletePack('pack/one?')).toBe(true);
    expect(String(fetchMock.mock.calls[2]![0])).toContain('/pack%2Fone%3F');
  });

  it('delete eksik kimlik, gövdesiz HTTP ve iki ağ hata türünde sahte başarı vermez', async () => {
    const c = await loaded();
    expect(await c.deletePack('')).toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error('no body'); } } as unknown as Response);
    expect(await c.deletePack('pack-1')).toBe(false);
    expect(c.snapshot.error).toBe(t('error_server'));
    fetchMock.mockRejectedValueOnce(new Error('delete offline'));
    expect(await c.deletePack('pack-1')).toBe(false);
    expect(c.snapshot.error).toBe(t('error_network'));
    fetchMock.mockRejectedValueOnce('delete offline');
    expect(await c.deletePack('pack-1')).toBe(false);
    expect(c.snapshot.error).toBe(t('sticker_pack_delete_failed'));
  });

  it('rename doğrulama, busy, gövdesiz hata ve ağ hata yollarını korur', async () => {
    const c = await loaded();
    expect(await c.renameSticker('', '', 'x')).toBe(false);
    expect(await c.renameSticker('foreign', 'st-1', 'x')).toBe(false);

    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const first = c.renameSticker('pack-1', 'st-1', 'first');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await c.renameSticker('pack-1', 'st-1', 'second')).toBe(false);
    release(err(500, 'failed'));
    expect(await first).toBe(false);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new Error('no body'); } } as unknown as Response);
    expect(await c.renameSticker('pack-1', 'st-1', 'next')).toBe(false);
    expect(c.snapshot.error).toBe(t('error_server'));
    fetchMock.mockRejectedValueOnce(new Error('rename offline'));
    expect(await c.renameSticker('pack-1', 'st-1', 'next')).toBe(false);
    expect(c.snapshot.error).toBe(t('error_network'));
    fetchMock.mockRejectedValueOnce('rename offline');
    expect(await c.renameSticker('pack-1', 'st-1', 'next')).toBe(false);
    expect(c.snapshot.error).toBe(t('sticker_update_failed'));
  });

  it('sunucu değişince geç delete/rename başarı veya hata sonucu uygulanmaz', async () => {
    const c = await loaded();
    let releaseDelete!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseDelete = resolve; }));
    const deleting = c.deletePack('pack-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));
    releaseDelete(ok(null, 204));
    expect(await deleting).toBe(false);
    expect(c.snapshot.packs).toHaveLength(1);
    expect(await c.renameSticker('pack-1', 'st-1', 'wrong server')).toBe(false);

    BridgeRegistry.register('getCurrentServer', () => ({ _id: SID, id: SID }));
    let releaseRename!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseRename = resolve; }));
    const renaming = c.renameSticker('pack-1', 'st-1', 'late');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));
    releaseRename(err(403, 'obsolete'));
    expect(await renaming).toBe(false);
    expect(c.snapshot.packs[0]!.stickers[0]!.name).toBe('gulen');
    expect(c.snapshot.error).toBeNull();
  });
});

describe('C3 — createPack yanıt doğruluğu ve gövdesiz hata eşlemesi', () => {
  const png = () => new File(['png'], 'a.png', { type: 'image/png' });

  it('bozuk veya yabancı başarılı yanıtı başarı diye raporlamaz', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValueOnce(ok({}));
    expect(await c.createPack('New', '', [png()])).toBe(false);
    expect(c.snapshot.error).toContain('geçersiz');
    fetchMock.mockResolvedValueOnce(ok(PACK({ _id: 'foreign-created', serverId: 'srv-B' })));
    expect(await c.createPack('New', '', [png()])).toBe(false);
    expect(c.snapshot.packs.some(p => p._id === 'foreign-created')).toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => { throw new Error('bad JSON'); } } as unknown as Response);
    expect(await c.createPack('New', '', [png()])).toBe(false);
  });

  it('gövdesiz durumları kullanıcıya eyleme dönük ve doğru eşler', async () => {
    const c = await loaded();
    const cases: Array<[number, RegExp]> = [
      [401, /Oturumunuz/], [403, /izniniz/], [404, /bulunamadı/], [413, /çok büyük/],
      [415, /PNG, WebP veya GIF/], [429, /Çok fazla/], [500, /Sunucu hatası/], [418, /\(418\)/],
    ];
    for (const [status, expected] of cases) {
      fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => { throw new Error('no body'); } } as unknown as Response);
      expect(await c.createPack('New', '', [png()])).toBe(false);
      expect(c.snapshot.error).toMatch(expected);
    }
  });

  it('ağ hata türlerini ayırır ve bayat hata yanıtını görünür duruma yazmaz', async () => {
    const c = await loaded();
    fetchMock.mockRejectedValueOnce(new Error('create offline'));
    expect(await c.createPack('New', '', [png()])).toBe(false);
    // Istisnanin ham `message` alani da gosterilmez.
    expect(c.snapshot.error).toBe(t('error_network'));
    fetchMock.mockRejectedValueOnce('create offline');
    expect(await c.createPack('New', '', [png()])).toBe(false);
    expect(c.snapshot.error).toBe(t('sticker_pack_create_failed'));

    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const pending = c.createPack('New', '', [png()]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));
    release(err(403, 'obsolete'));
    expect(await pending).toBe(false);
    expect(c.snapshot.error).toBeNull();
  });
});
