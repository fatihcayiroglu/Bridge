// client/tests/draft-store.test.ts
// Faz 8.2 — Taslak kalıcılık katmanının davranış testleri.
//
// Legacy `tests/drafts.test.ts` (jest.mock, kaldırılmış `js/core/drafts.js`
// modülünü hedefliyordu) sözleşmelerinin kalıcılık tarafı buraya taşındı.
// Zamanlama/entegrasyon tarafı `tests/draft-manager.test.ts` içindedir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  draftKey, readDraft, writeDraft, clearDraft,
  readDraftAttachmentPending, writeDraftAttachmentPending,
  DRAFT_KEY_PREFIX, MAX_DRAFT_LENGTH, MAX_DRAFT_AGE_MS, MAX_DRAFTS_PER_USER,
} from '../js/core/draft-store.ts';

const A = { userId: 'u1', kind: 'channel' as const, serverId: 'srv-1', conversationId: 'ch-1' };
const B = { userId: 'u1', kind: 'channel' as const, serverId: 'srv-1', conversationId: 'ch-2' };
const DM = { userId: 'u1', kind: 'dm' as const, conversationId: 'ch-1' };
const GDM = { userId: 'u1', kind: 'gdm' as const, conversationId: 'ch-1' };
const OTHER_SERVER = { userId: 'u1', kind: 'channel' as const, serverId: 'srv-2', conversationId: 'ch-1' };
const OTHER_USER = { userId: 'u2', kind: 'channel' as const, serverId: 'srv-1', conversationId: 'ch-1' };

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('draftKey — anahtar stratejisi', () => {
  it('kullanıcı + tür + kanonik kapsam + konuşma id\'sinden üretilir', () => {
    expect(draftKey(A)).toBe(`${DRAFT_KEY_PREFIX}:u1:channel:srv-1:ch-1`);
  });

  it('aynı id farklı türde FARKLI anahtar üretir (kanal ↔ DM karışmaz)', () => {
    expect(draftKey(A)).not.toBe(draftKey(DM));
  });

  it('aynı konuşma farklı kullanıcıda FARKLI anahtar üretir', () => {
    expect(draftKey(A)).not.toBe(draftKey(OTHER_USER));
  });

  it('aynı kanal id farklı sunucuda FARKLI anahtar üretir', () => {
    expect(draftKey(A)).not.toBe(draftKey(OTHER_SERVER));
  });

  it('aynı id DM ve GDM olduğunda FARKLI anahtar üretir', () => {
    expect(draftKey(DM)).not.toBe(draftKey(GDM));
  });

  it('eksik kimlikte anahtar üretmez (yanlış kovaya yazma riski)', () => {
    expect(draftKey({ userId: 'u1', kind: 'channel' })).toBeNull();
    expect(draftKey({ userId: 'u1', kind: 'channel', conversationId: 'ch-1' })).toBeNull();
    expect(draftKey({ kind: 'channel', conversationId: 'ch-1' })).toBeNull();
    expect(draftKey(null)).toBeNull();
  });

  it('anahtarda değişken/gizli veri taşınmaz (ad, sıra, token yok)', () => {
    const key = draftKey(A)!;
    // Yalnızca sabit önek + kanonik kimlik alanları.
    expect(key.split(':')).toEqual(['bridge', 'draft', 'v2', 'u1', 'channel', 'srv-1', 'ch-1']);
  });
});

describe('yazma / okuma', () => {
  it('taslak kaydedilir ve geri okunur', () => {
    writeDraft(A, 'yarım mesaj');
    expect(readDraft(A)).toBe('yarım mesaj');
  });

  it('kaydedilmemiş konuşma için boş string döner (null değil)', () => {
    expect(readDraft(B)).toBe('');
  });

  it('boş metin taslak üretmez', () => {
    writeDraft(A, '');
    expect(localStorage.getItem(draftKey(A)!)).toBeNull();
  });

  it('yalnızca boşluk içeren metin taslak üretmez', () => {
    writeDraft(A, '   \n\t ');
    expect(readDraft(A)).toBe('');
  });

  it('metin silinince önceki taslak da silinir', () => {
    writeDraft(A, 'bir şeyler');
    writeDraft(A, '');
    expect(readDraft(A)).toBe('');
  });

  it('baştaki/sondaki boşluk KORUNUR (kullanıcı yazdığını aynen bulur)', () => {
    writeDraft(A, '  girintili metin  ');
    expect(readDraft(A)).toBe('  girintili metin  ');
  });

  it('clearDraft kaydı siler', () => {
    writeDraft(A, 'silinecek');
    clearDraft(A);
    expect(readDraft(A)).toBe('');
  });
});

describe('izolasyon', () => {
  it('farklı kanalların taslakları birbirine karışmaz', () => {
    writeDraft(A, 'kanal bir');
    writeDraft(B, 'kanal iki');

    expect(readDraft(A)).toBe('kanal bir');
    expect(readDraft(B)).toBe('kanal iki');
  });

  it('DM taslağı aynı id\'li kanal taslağını ezmez', () => {
    writeDraft(A, 'kanal metni');
    writeDraft(DM, 'dm metni');

    expect(readDraft(A)).toBe('kanal metni');
    expect(readDraft(DM)).toBe('dm metni');
  });

  it('GDM taslağı aynı id\'li DM veya kanal taslağını ezmez', () => {
    writeDraft(A, 'kanal metni');
    writeDraft(DM, 'dm metni');
    writeDraft(GDM, 'gdm metni');

    expect(readDraft(A)).toBe('kanal metni');
    expect(readDraft(DM)).toBe('dm metni');
    expect(readDraft(GDM)).toBe('gdm metni');
  });

  it('aynı kanal id başka sunucudaki taslağı sızdırmaz', () => {
    writeDraft(A, 'sunucu bir');
    writeDraft(OTHER_SERVER, 'sunucu iki');
    expect(readDraft(A)).toBe('sunucu bir');
    expect(readDraft(OTHER_SERVER)).toBe('sunucu iki');
  });

  it('A kullanıcısının taslağı B kullanıcısına GÖRÜNMEZ', () => {
    writeDraft(A, 'gizli yarım mesaj');

    expect(readDraft(OTHER_USER)).toBe('');
  });

  it('B kullanıcısının yazması A\'nınkini bozmaz', () => {
    writeDraft(A, 'a metni');
    writeDraft(OTHER_USER, 'b metni');

    expect(readDraft(A)).toBe('a metni');
    expect(readDraft(OTHER_USER)).toBe('b metni');
  });
});

describe('sağlamlık — bozuk / aşırı veri', () => {
  it('bozuk JSON çökertmez, kayıt temizlenir', () => {
    localStorage.setItem(draftKey(A)!, '{bozuk json');

    expect(() => readDraft(A)).not.toThrow();
    expect(readDraft(A)).toBe('');
    expect(localStorage.getItem(draftKey(A)!)).toBeNull();
  });

  it('beklenmeyen şekildeki kayıt (dizi/sayı) boş sayılır', () => {
    localStorage.setItem(draftKey(A)!, '[1,2,3]');
    expect(readDraft(A)).toBe('');

    localStorage.setItem(draftKey(B)!, '42');
    expect(readDraft(B)).toBe('');
  });

  it('metin alanı string değilse kayıt atılır', () => {
    localStorage.setItem(draftKey(A)!, JSON.stringify({ t: { evil: true }, s: Date.now() }));
    expect(readDraft(A)).toBe('');
  });

  it('çok uzun metin sınıra kırpılarak saklanır', () => {
    writeDraft(A, 'x'.repeat(MAX_DRAFT_LENGTH + 5000));
    expect(readDraft(A)).toHaveLength(MAX_DRAFT_LENGTH);
  });

  it('depoya elle yazılmış devasa değer okurken de sınırlanır', () => {
    localStorage.setItem(draftKey(A)!, JSON.stringify({ t: 'y'.repeat(500_000), s: Date.now() }));

    expect(readDraft(A)).toHaveLength(MAX_DRAFT_LENGTH);
  });

  it('bayat taslak (7 günden eski) gösterilmez ve silinir', () => {
    const stale = Date.now() - MAX_DRAFT_AGE_MS - 1000;
    localStorage.setItem(draftKey(A)!, JSON.stringify({ t: 'çok eski', s: stale }));

    expect(readDraft(A)).toBe('');
    expect(localStorage.getItem(draftKey(A)!)).toBeNull();
  });

  it('taze taslak korunur', () => {
    const fresh = Date.now() - 2 * 24 * 60 * 60 * 1000;
    localStorage.setItem(draftKey(A)!, JSON.stringify({ t: 'güncel', s: fresh }));

    expect(readDraft(A)).toBe('güncel');
  });

  it('kullanıcı başına en fazla makul sayıda taslak saklar, en yenileri korur', () => {
    for (let index = 0; index < MAX_DRAFTS_PER_USER + 5; index += 1) {
      vi.setSystemTime(new Date(1_800_000_000_000 + index));
      writeDraft({ ...A, conversationId: `bounded-${index}` }, `metin-${index}`);
    }
    const keys = Object.keys(localStorage).filter(key => key.startsWith(`${DRAFT_KEY_PREFIX}:u1:`));
    expect(keys).toHaveLength(MAX_DRAFTS_PER_USER);
    expect(readDraft({ ...A, conversationId: 'bounded-0' })).toBe('');
    expect(readDraft({ ...A, conversationId: `bounded-${MAX_DRAFTS_PER_USER + 4}` })).toBe(`metin-${MAX_DRAFTS_PER_USER + 4}`);
    vi.useRealTimers();
  });
});

describe('attachment recovery hint', () => {
  it('raw dosya/blob/isim saklamadan yalnız yeniden seçim gerektiğini hatırlar', () => {
    writeDraft(A, 'açıklama');
    expect(writeDraftAttachmentPending(A, true)).toBe(true);
    expect(readDraftAttachmentPending(A)).toBe(true);
    expect(readDraft(A)).toBe('açıklama');

    const stored = localStorage.getItem(draftKey(A)!)!;
    expect(stored).not.toContain('File');
    expect(stored).not.toContain('secret.pdf');
    expect(JSON.parse(stored)).toMatchObject({ t: 'açıklama', a: true });
  });

  it('hint temizlenince metin korunur; metin de yoksa kayıt tamamen kalkar', () => {
    writeDraft(A, 'metin');
    writeDraftAttachmentPending(A, true);
    writeDraftAttachmentPending(A, false);
    expect(readDraft(A)).toBe('metin');
    expect(readDraftAttachmentPending(A)).toBe(false);

    writeDraft(A, '');
    expect(localStorage.getItem(draftKey(A)!)).toBeNull();
  });
});

describe('sağlamlık — depolama arızası', () => {
  it('kota aşımında yazma false döner ama FIRLATMAZ', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => writeDraft(A, 'metin')).not.toThrow();
    expect(writeDraft(A, 'metin')).toBe(false);
  });

  it('okuma hatası çökertmez, boş string döner', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => readDraft(A)).not.toThrow();
    expect(readDraft(A)).toBe('');
  });

  it('silme hatası çökertmez', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => clearDraft(A)).not.toThrow();
  });

  it('eksik kimlikle yazma sessizce reddedilir (yanlış kovaya yazmaz)', () => {
    expect(writeDraft({ userId: '', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' }, 'metin')).toBe(false);
    expect(localStorage.length).toBe(0);
  });
});

describe('güvenlik — içerik düz metin kalır', () => {
  it('HTML/script içeren taslak aynen düz metin olarak saklanır', () => {
    const payload = '<img src=x onerror="alert(1)"><script>evil()<\/script>';
    writeDraft(A, payload);

    // Kaçış yapılmaz, kodlanmaz — ama HTML olarak da yorumlanmaz:
    // katman yalnızca string taşır, DOM'a yazan taraf textarea.value'dur.
    expect(readDraft(A)).toBe(payload);
    expect(typeof readDraft(A)).toBe('string');
  });

  it('taslak kaydında kullanıcı metadata\'sı saklanmaz', () => {
    writeDraft(A, 'metin');
    const stored = JSON.parse(localStorage.getItem(draftKey(A)!)!);

    // Yalnızca metin + zaman damgası. Kullanıcı adı, token, e-posta yok.
    expect(Object.keys(stored).sort()).toEqual(['s', 't']);
  });
});

describe('sinir durumlari — depolama ve attachment durumu', () => {
  it('localStorage yoksa kaydi basarili gostermeden fail-closed davranir', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readDraft(A)).toBe('');
    expect(writeDraft(A, 'kaybolmamali')).toBe(false);
  });

  it('localStorage getter hata firlatirsa okuma cokmez', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('storage getter blocked'); },
    });
    try {
      expect(readDraft(A)).toBe('');
      expect(writeDraft(A, 'metin')).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });

  it('zaman damgasi sayi degilse sifir kabul eder ve metni korur', () => {
    localStorage.setItem(draftKey(A)!, JSON.stringify({ t: 'metin', s: 'invalid' }));
    expect(readDraft(A)).toBe('metin');
  });

  it('prune sirasinda bozuk kullanici kaydini atlar', () => {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}:u1:channel:srv-1:broken`, '{bad');
    expect(writeDraft(A, 'gecerli')).toBe(true);
    expect(readDraft(A)).toBe('gecerli');
  });

  it('yazma sonrasi depolama kapanirsa prune islemini guvenle atlar', () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key: string, value: string) {
      original.call(this, key, value);
      vi.stubGlobal('localStorage', undefined);
    });
    expect(writeDraft(A, 'kaydedildi')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('gecersiz kimliklerde tum public islemler guvenli varsayilan dondurur', () => {
    const invalid = { userId: '', kind: 'channel' as const, serverId: 's', conversationId: 'c' };
    expect(readDraft(invalid)).toBe('');
    expect(writeDraftAttachmentPending(invalid, true)).toBe(false);
    expect(readDraftAttachmentPending(invalid)).toBe(false);
    expect(() => clearDraft(invalid)).not.toThrow();
  });

  it('string olmayan metni bos kabul eder', () => {
    writeDraft(A, 'onceki');
    expect(writeDraft(A, null as unknown as string)).toBe(true);
    expect(readDraft(A)).toBe('');
  });

  it('yalniz attachment hint varken bos metin yazimi kaydi korur', () => {
    expect(writeDraftAttachmentPending(A, true)).toBe(true);
    expect(writeDraft(A, '')).toBe(true);
    expect(readDraft(A)).toBe('');
    expect(readDraftAttachmentPending(A)).toBe(true);
  });

  it('attachment hintten sonra metin yazimi hinti korur', () => {
    writeDraftAttachmentPending(A, true);
    writeDraft(A, 'aciklama');
    expect(readDraft(A)).toBe('aciklama');
    expect(readDraftAttachmentPending(A)).toBe(true);
  });

  it('olmayan attachment hintini temizlemek kaydi gereksiz yere olusturmaz', () => {
    expect(writeDraftAttachmentPending(A, false)).toBe(true);
    expect(localStorage.getItem(draftKey(A)!)).toBeNull();
  });
});
