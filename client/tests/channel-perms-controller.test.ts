// client/tests/channel-perms-controller.test.ts
// FAZ C2 — KANAL İZİNLERİ KONTROLCÜSÜ (gerçek sözleşme).
//
// Arka uç: allow/deny BİT ALANI, yetki MANAGE_CHANNELS,
//   GET    → { overrides, roles }
//   PUT    /:roleId  { allow, deny }
//   DELETE /:roleId  = INHERIT (sıfır maske PUT'lamak sahte inherit olurdu)
//
// Kontrolcü HTML ÜRETMEZ — modalin `{@html}` yuvaları bilinçli olarak
// beslenmez (rol/kanal/audit metinleri kullanıcı denetimindedir).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createChannelPermsController } from '../js/core/channel-perms/channelPermsStore.ts';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

// ── KOPYA METNİ TEST SABİTİ DEĞİLDİR ──────────────────────────────────────
// Bu dosya eskiden `'Sunucu hatası. Birazdan tekrar dene.'` gibi HAM METİNLER
// bekliyordu. Metinler i18n sözlüğüne taşındığında (`error_server`,
// `error_network`) üretim doğru davranmaya devam etti ama testler kırmızı
// oldu — ölçtükleri şey davranış değil, bir dizgenin harfleriydi.
// Sözleşme "kullanıcıya KANONİK ve GÜVENLİ mesaj gösterilir"dir; bu yüzden
// beklenti anahtarın kendisinden türetilir.
const ERR_SERVER  = () => t('error_server');
const ERR_NETWORK = () => t('error_network');

const SID = 'srv-A';
const CID = 'chan-A';
const VIEW = 1024;   // örnek izin biti
const SEND = 2048;

let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

const ok  = (b: unknown) => ({ ok: true,  status: 200, json: async () => b } as unknown as Response);
const err = (s: number, e: string) => ({ ok: false, status: s, json: async () => ({ error: e }) } as unknown as Response);

const ROLES = [{ _id: 'role-1', name: 'Moderatör' }, { _id: 'role-2', name: 'Üye' }];

function setCurrent(server: unknown) {
  BridgeRegistry.register('getCurrentServer', () => server);
}

beforeEach(() => {
  setCurrent({ _id: SID, id: SID, name: 'A' });
  fetchMock = vi.fn(async () => ok({ roles: ROLES, overrides: [] }));
});

afterEach(() => {
  BridgeRegistry.unregister('getCurrentServer');
  BridgeRegistry.unregister('getCurrentServerChannels');
  BridgeRegistry.unregister('getCurrentChannel');
  vi.restoreAllMocks();
});

async function loaded(overrides: unknown[] = []) {
  fetchMock = vi.fn(async () => ok({ roles: ROLES, overrides }));
  const c = createChannelPermsController(SID, CID);
  await c.load();
  fetchMock.mockClear();
  return c;
}

// ════════════════════════════════════════════════════════════════════════════
describe('C2 — yükleme ve hidrasyon', () => {
  it('GERÇEK uç noktadan yükler', async () => {
    const c = createChannelPermsController(SID, CID);
    expect(await c.load()).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0]))
      .toBe(`http://test/api/servers/${SID}/channels/${CID}/permissions`);
  });

  it('mevcut override’ları hidre eder', async () => {
    const c = await loaded([{ roleId: 'role-1', allow: VIEW, deny: SEND }]);

    expect(c.stateOf('role-1', VIEW)).toBe('allow');
    expect(c.stateOf('role-1', SEND)).toBe('deny');
    expect(c.stateOf('role-2', VIEW)).toBe('inherit');
  });

  it('yükleme hatası BAŞARI raporlamaz ve sunucu gövdesini SIZDIRMAZ', async () => {
    fetchMock = vi.fn(async () => err(403, 'Missing permission: MANAGE_CHANNELS'));
    const c = createChannelPermsController(SID, CID);

    expect(await c.load()).toBe(false);
    // Eskiden burada ham sunucu metninin (`MANAGE_CHANNELS`) kullanıcıya
    // ULAŞMASI bekleniyordu. api-error.ts güvenlik sözleşmesi bunu açıkça
    // yasaklar: "Sunucu gövdesi, stack trace, URL, token vb. ASLA bildirime
    // konmaz." Doğru sözleşme, kanonik yetki mesajının gösterilmesi ve ham
    // ayrıntının SIZMAMASIDIR.
    expect(c.snapshot.error).toBe(t('error_forbidden'));
    expect(String(c.snapshot.error)).not.toContain('MANAGE_CHANNELS');
  });
});

describe('C2 — üç durumlu düzenleme', () => {
  it('allow ve deny AYNI bit için birlikte olamaz', async () => {
    const c = await loaded();

    c.setState('role-1', VIEW, 'allow');
    expect(c.masks('role-1')).toEqual({ allow: VIEW, deny: 0 });

    c.setState('role-1', VIEW, 'deny');
    expect(c.masks('role-1')).toEqual({ allow: 0, deny: VIEW });   // allow temizlendi

    c.setState('role-1', VIEW, 'inherit');
    expect(c.masks('role-1')).toEqual({ allow: 0, deny: 0 });
  });

  it('dirty yalnız gerçek değişimde true olur; reset geri alır', async () => {
    const c = await loaded([{ roleId: 'role-1', allow: VIEW, deny: 0 }]);
    expect(c.isDirty()).toBe(false);

    c.setState('role-1', SEND, 'deny');
    expect(c.isDirty()).toBe(true);

    c.reset();
    expect(c.isDirty()).toBe(false);
    expect(c.stateOf('role-1', VIEW)).toBe('allow');
  });
});

describe('C2 — kaydetme sözleşmesi', () => {
  it('override PUT ile yazılır', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(ok({ ok: true }));
    c.setState('role-1', VIEW, 'allow');

    expect(await c.save()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/permissions\/role-1$/);
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ allow: VIEW, deny: 0 });
  });

  it('INHERIT sıfır maske PUT değil, DELETE gönderir', async () => {
    const c = await loaded([{ roleId: 'role-1', allow: VIEW, deny: 0 }]);
    fetchMock.mockResolvedValue(ok({ ok: true }));
    c.setState('role-1', VIEW, 'inherit');

    expect(await c.save()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/permissions\/role-1$/);
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('DEĞİŞMEYEN roller için istek atılmaz', async () => {
    const c = await loaded([{ roleId: 'role-1', allow: VIEW, deny: 0 }]);
    fetchMock.mockResolvedValue(ok({ ok: true }));
    c.setState('role-2', SEND, 'deny');

    await c.save();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/role-2$/);
  });

  it('arka uç hatası BAŞARI raporlamaz ve durum ilerletilmez', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(err(403, 'Missing permission: MANAGE_CHANNELS'));
    c.setState('role-1', VIEW, 'allow');

    expect(await c.save()).toBe(false);
    expect(c.isDirty()).toBe(true);       // taslak korunur, sahte başarı yok
  });

  it('değişiklik yoksa istek atılmaz', async () => {
    const c = await loaded();

    expect(await c.save()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('C2 — GÜVENLİK: bağlam ve kiracı sınırları', () => {
  it('GÜVENLİK: sunucu değiştiyse KAYDETMEZ (bayat bağlam)', async () => {
    const c = await loaded();
    c.setState('role-1', VIEW, 'allow');

    setCurrent({ _id: 'srv-B', id: 'srv-B' });      // kullanıcı B'ye geçti

    expect(await c.save()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(c.snapshot.error)).toMatch(/sunucu değişti/i);
  });

  it('GÜVENLİK: sunucu çözülemiyorsa yükleme FAIL-CLOSED', async () => {
    BridgeRegistry.unregister('getCurrentServer');
    const c = createChannelPermsController(SID, CID);

    expect(await c.load()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: eksik kanal kimliği ile istek OLUŞMAZ (undefined URL engeli)', async () => {
    const c = createChannelPermsController(SID, '');

    expect(await c.load()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: bu sunucuya ait OLMAYAN rol yazılamaz', async () => {
    const c = await loaded();
    fetchMock.mockResolvedValue(ok({ ok: true }));
    c.setState('yabanci-rol', VIEW, 'allow');       // roles listesinde yok

    expect(await c.save()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: çift kaydetme eşzamanlı yinelenen istek üretmez', async () => {
    const c = await loaded();
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>(r => { release = r; }));
    c.setState('role-1', VIEW, 'allow');

    const first = c.save();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await c.save()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(ok({ ok: true }));
    await first;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C2 §14 — KANAL BAYATLIK KAPISI
// ════════════════════════════════════════════════════════════════════════════
describe('C2 — GÜVENLİK: bayat KANAL koruması', () => {
  it('etkin kanal BAŞKA olsa bile YAKALANAN kanala yazar (menü asıl kullanımı)', async () => {
    // Menü, ChannelItem üzerinden ETKİN OLMAYAN bir kanal için açılabilir.
    // Yanlış kanala yazma riski yoktur: channelId URL'ye gömülüdür.
    BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'chan-B' }));
    const c = await loaded();
    fetchMock.mockResolvedValue(ok({ ok: true }));
    c.setState('role-1', VIEW, 'allow');

    expect(await c.save()).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`/channels/${CID}/`);

    BridgeRegistry.unregister('getCurrentChannel');
  });

  it('GÜVENLİK: kanal artık bu sunucunun listesinde değilse KAYDETMEZ', async () => {
    const c = await loaded();
    c.setState('role-1', VIEW, 'allow');

    BridgeRegistry.register('getCurrentServerChannels', () => [{ _id: 'baska-kanal' }]);

    expect(await c.save()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    BridgeRegistry.unregister('getCurrentServerChannels');
  });

  it('GÜVENLİK: bilinen kanal listesi boşsa son silinen kanala KAYDETMEZ', async () => {
    const c = await loaded();
    c.setState('role-1', VIEW, 'allow');
    BridgeRegistry.register('getCurrentServerChannels', () => []);

    expect(await c.save()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('eksik kimlikli kanal kayıtlarını güvenle atlar ama yakalanan kanalı bulur', async () => {
    BridgeRegistry.register('getCurrentServerChannels', () => [null, {}, { _id: CID }] as never);
    const c = createChannelPermsController(SID, CID);

    expect(await c.load()).toBe(true);
  });
});

describe('C2 — bozuk yanıtlar ve hata sınırları', () => {
  it('opsiyonel/düzensiz koleksiyonları boş diziye indirger ve maskeleri sayısallaştırır', async () => {
    fetchMock = vi.fn(async () => ok({ roles: { nope: true }, overrides: { nope: true } }));
    const malformed = createChannelPermsController(SID, CID);
    expect(await malformed.load()).toBe(true);
    expect(malformed.snapshot.roles).toEqual([]);
    expect(malformed.masks('missing')).toEqual({ allow: 0, deny: 0 });

    fetchMock = vi.fn(async () => ok({
      roles: ROLES,
      overrides: [{ roleId: 'role-1', allow: 'not-a-number', deny: null }],
    }));
    const numeric = createChannelPermsController(SID, CID);
    numeric.selectRole('role-2');
    expect(await numeric.load()).toBe(true);
    expect(numeric.snapshot.selectedRoleId).toBe('role-2');
    expect(numeric.masks('role-1')).toEqual({ allow: 0, deny: 0 });
  });

  it('yükleme hata gövdesi okunamazsa durum kodlu güvenli mesaj döndürür', async () => {
    fetchMock = vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new Error('invalid json'); },
    } as unknown as Response));
    const c = createChannelPermsController(SID, CID);

    expect(await c.load()).toBe(false);
    expect(c.snapshot.error).toBe(ERR_SERVER());
    expect(c.snapshot.loading).toBe(false);
  });

  it.each([
    [new Error('offline-load'), ERR_NETWORK],
    ['offline-load', () => t('perm_load_failed', 'Kanal izinleri yüklenemedi.')],
  ])('yükleme istisnasını kullanıcıya güvenli biçimde taşır: %#', async (cause, message) => {
    fetchMock = vi.fn(async () => { throw cause; });
    const c = createChannelPermsController(SID, CID);

    expect(await c.load()).toBe(false);
    expect(c.snapshot.error).toBe(message());
  });
});

describe('Permission Explainability — kontrolcü hata ve yarış davranışı', () => {
  it('bayat bağlamı istek atmadan reddeder', async () => {
    setCurrent({ _id: 'srv-other', id: 'srv-other' });
    const c = createChannelPermsController(SID, CID);

    expect(await c.loadExplanation()).toBe(false);
    expect(c.snapshot.explanationError).toContain('bağlamı geçersiz');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uçuşta ikinci açıklama isteğini reddeder ve ilk sonucu yayınlar', async () => {
    let release: (response: Response) => void = () => {};
    fetchMock = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const c = createChannelPermsController(SID, CID);
    const first = c.loadExplanation();
    await vi.waitFor(() => expect(c.snapshot.explanationLoading).toBe(true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(await c.loadExplanation()).toBe(false);
    release(ok({ channelId: CID, subject: 'me', permissions: [] }));
    expect(await first).toBe(true);
    expect(c.snapshot.explanation?.subject).toBe('me');
    expect(c.snapshot.explanationLoading).toBe(false);
  });

  it.each([
    [500, { error: 'explain failed' }, ERR_SERVER],
    [502, null, ERR_SERVER],
  ])('403 dışı açıklama hatalarını güvenli biçimde sunar: %#', async (status, body, message) => {
    fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      json: body === null ? async () => { throw new Error('bad json'); } : async () => body,
    } as unknown as Response));
    const c = createChannelPermsController(SID, CID);

    expect(await c.loadExplanation()).toBe(false);
    expect(c.snapshot.explanationError).toBe(message());
  });

  it.each([
    [new Error('offline-explain'), ERR_NETWORK],
    ['offline-explain', () => t('perm_explanation_failed', 'Açıklama yüklenemedi.')],
  ])('açıklama istisnasını sınırlar: %#', async (cause, message) => {
    fetchMock = vi.fn(async () => { throw cause; });
    const c = createChannelPermsController(SID, CID);

    expect(await c.loadExplanation()).toBe(false);
    expect(c.snapshot.explanationError).toBe(message());
    expect(c.snapshot.explanationLoading).toBe(false);
  });
});

describe('View as Role — kontrolcü hata, yarış ve URL davranışı', () => {
  it('bayat bağlamı ve boş rolü istek atmadan reddeder', async () => {
    const c = createChannelPermsController(SID, CID);
    expect(await c.loadRolePreview('')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    setCurrent({ _id: 'srv-other', id: 'srv-other' });
    expect(await c.loadRolePreview('role-1')).toBe(false);
    expect(c.snapshot.rolePreviewError).toContain('bağlamı geçersiz');
  });

  it('uçuşta ikinci rol önizlemesini reddeder ve özel rol kimliğini kodlar', async () => {
    let release: (response: Response) => void = () => {};
    fetchMock = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const c = createChannelPermsController(SID, CID);
    const first = c.loadRolePreview('role / özel');
    await vi.waitFor(() => expect(c.snapshot.rolePreviewLoading).toBe(true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(await c.loadRolePreview('role-2')).toBe(false);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/roles/role%20%2F%20%C3%B6zel/preview');
    // Uretim, yaniti ISTENEN role kimligine baglar (`data.role.id !== roleId`
    // ise yanit REDDEDILIR): bayat/yanlis rol icin gelen bir onizleme
    // gosterilmemelidir. Test cifti bunu ihlal edip sabit `'r'` donduruyordu,
    // yani kanitladigi sey uretim davranisi degildi.
    release(ok({
      simulation: true,
      role: { id: 'role / özel', name: 'Özel' },
      // `isRolePreviewResponse` OZETIN BES SAYACINI da dogrular; bos bir
      // `summary` uretimde REDDEDILIR. Test cifti bunu da ihlal ediyordu.
      summary: { totalChannels: 0, visibleChannels: 0, sendableChannels: 0,
                 attachableChannels: 0, manageableChannels: 0 },
      channels: [],
    }));
    expect(await first).toBe(true);
    expect(c.snapshot.rolePreview?.simulation).toBe(true);
  });

  it.each([
    [500, { error: 'preview failed' }, ERR_SERVER],
    [502, null, ERR_SERVER],
  ])('403 dışı rol önizleme hatalarını güvenli biçimde sunar: %#', async (status, body, message) => {
    fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      json: body === null ? async () => { throw new Error('bad json'); } : async () => body,
    } as unknown as Response));
    const c = createChannelPermsController(SID, CID);

    expect(await c.loadRolePreview('role-1')).toBe(false);
    expect(c.snapshot.rolePreviewError).toBe(message());
  });

  it.each([
    [new Error('offline-preview'), ERR_NETWORK],
    ['offline-preview', () => t('perm_role_preview_failed', 'Rol önizlemesi yüklenemedi.')],
  ])('rol önizleme istisnasını sınırlar: %#', async (cause, message) => {
    fetchMock = vi.fn(async () => { throw cause; });
    const c = createChannelPermsController(SID, CID);

    expect(await c.loadRolePreview('role-1')).toBe(false);
    expect(c.snapshot.rolePreviewError).toBe(message());
    expect(c.snapshot.rolePreviewLoading).toBe(false);
  });
});

describe('C2 — kaydetme hata gövdeleri ve URL güvenliği', () => {
  it('rol kimliğini yol parçası olarak kodlar', async () => {
    const specialRole = 'role / özel';
    fetchMock = vi.fn(async () => ok({ roles: [{ _id: specialRole, name: 'Özel' }], overrides: [] }));
    const c = createChannelPermsController(SID, CID);
    expect(await c.load()).toBe(true);
    fetchMock.mockClear();
    c.setState(specialRole, VIEW, 'deny');

    expect(await c.save()).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/permissions/role%20%2F%20%C3%B6zel');
  });

  it('hata gövdesi okunamazsa durum kodlu güvenli mesajı ve taslağı korur', async () => {
    const c = await loaded();
    c.setState('role-1', VIEW, 'allow');
    fetchMock = vi.fn(async () => ({
      ok: false, status: 503, json: async () => { throw new Error('bad json'); },
    } as unknown as Response));

    expect(await c.save()).toBe(false);
    expect(c.snapshot.error).toBe(ERR_SERVER());
    expect(c.snapshot.dirty).toBe(true);
  });

  it.each([
    [new Error('offline-save'), ERR_NETWORK],
    ['offline-save', () => t('perm_save_failed')],
  ])('kaydetme istisnasını sınırlar ve saving bayrağını temizler: %#', async (cause, message) => {
    const c = await loaded();
    c.setState('role-1', VIEW, 'allow');
    fetchMock = vi.fn(async () => { throw cause; });

    expect(await c.save()).toBe(false);
    expect(c.snapshot.error).toBe(message());
    expect(c.snapshot.saving).toBe(false);
  });
});
