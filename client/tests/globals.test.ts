// client/tests/globals.test.ts
// core/globals.ts — CANLI sözleşme testleri.
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — KISMİ EMEKLİLİK KAYDI (ölü sözleşme)
// ════════════════════════════════════════════════════════════════════════════
//
// Bu dosya Sprint 81'de yazıldı ve o zamanki `globals.ts` yüzeyini test
// ediyordu. Svelte-runes göçünde (Faz 1–9) modül durumu AppState ve
// BridgeRegistry'ye taşındı; `globals.ts` ince bir uyumluluk katmanına indi.
//
// BUGÜNKÜ GERÇEK EXPORT YÜZEYİ (js/core/globals.ts — doğrulandı, 5 export):
//   getAPI · currentServer · currentServerChannels · friendsCache · getRtc
//
// ESKİ TESTLERİN BEKLEDİĞİ, ARTIK VAR OLMAYAN EXPORT'LAR:
//   setMe/getMe · setSocket/getSocket · setCurrentServer/getCurrentServer
//   setCurrentChannel/getCurrentChannel · setToken · setMemberListVisible
//   setClientConfig/getClientConfig · setEditingMessageId/getEditingMessageId
//   setReplyingTo/getReplyingTo · setUnreadMentions/getUnreadMentions
//   applyServerEmojis · serverEmojiCache · setCurrentServerChannels
//   setCurrentServerMembers · addNsfwAccepted · _nsfwAccepted
//   collapsedCategories · _persistCollapsedCategories
//   ve BridgeRegistry kayıtları: getCurrentUser · getCurrentUserId
//   · getCurrentChannel · getCurrentMember · setMeField
//
// Bunların HİÇBİRİ üretimde yok (`register('setMe'|'getMe')` araması: 0 sonuç).
// Dolayısıyla o testler üretim davranışını değil, kaldırılmış bir sözleşmeyi
// doğruluyordu; korunmaları imkânsız, "düzeltilmeleri" ise var olmayan bir API'yi
// geri getirmek anlamına gelirdi.
//
// YERİNE GEÇEN KAPSAM: mevcut kimlik/durum sözleşmesi BridgeRegistry üzerinden
// işler ve aktif süitlerde kapsanır — Phase10Social, Phase9Messaging,
// user-isolation (çıkışta özel durum temizliği), socket-rebind.
//
// KORUNAN: yalnız bugün GERÇEKTEN var olan yüzey aşağıda test edilir.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `globals.ts` modül seviyesi Proxy/koleksiyon durumu taşır; her test taze
 * örnek alır. CJS `require()` yerine kanonik Vitest/ESM biçimi kullanılır
 * (Vite `import`u çözer, çalışma zamanı `require`ı çözmez).
 */
async function loadModule() {
  vi.resetModules();
  return await import('../js/core/globals.ts');
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).BRIDGE_API;
});

describe('getAPI()', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).BRIDGE_API;
  });

  it('BRIDGE_API tanımsızsa sayfanın origin\'ini döner', async () => {
    const { getAPI } = await loadModule();

    // Üretim sözleşmesi (globals.ts:5-8): sabit host DEĞİL, location.origin.
    expect(getAPI()).toBe(location.origin);
  });

  it('BRIDGE_API tanımlıysa onu döner', async () => {
    (globalThis as Record<string, unknown>).BRIDGE_API = 'https://api.bridge.example.com';
    const { getAPI } = await loadModule();

    expect(getAPI()).toBe('https://api.bridge.example.com');
  });

  it('BRIDGE_API boş string ise origin\'e düşer', async () => {
    (globalThis as Record<string, unknown>).BRIDGE_API = '';
    const { getAPI } = await loadModule();

    expect(getAPI()).toBe(location.origin);
  });

  it('BRIDGE_API string değilse origin\'e düşer', async () => {
    (globalThis as Record<string, unknown>).BRIDGE_API = 12345;
    const { getAPI } = await loadModule();

    expect(getAPI()).toBe(location.origin);
  });
});

describe('canlı export yüzeyi', () => {
  it('yalnız beklenen üyeleri dışa aktarır', async () => {
    const mod = await loadModule();

    // Yüzey daralması KASITLIDIR; genişlerse bu test uyarır ve kapsam
    // eklenmesi gerektiğini gösterir.
    expect(typeof mod.getAPI).toBe('function');
    expect(typeof mod.getRtc).toBe('function');
    expect(mod.currentServer).toBeDefined();
    expect(mod.currentServerChannels).toBeDefined();
    expect(mod.friendsCache).toBeDefined();
  });

  it('kaldırılmış eski API geri GELMEMELİDİR', async () => {
    const mod = await loadModule() as unknown as Record<string, unknown>;

    // Bu adlar AppState/BridgeRegistry'ye taşındı. Yeniden belirmeleri,
    // legacy global mimarisinin geri döndüğü anlamına gelir.
    for (const removed of ['setMe', 'getMe', 'setSocket', 'setToken', 'applyServerEmojis']) {
      expect(mod[removed]).toBeUndefined();
    }
  });
});

describe('friendsCache', () => {
  it('temizlenebilir bir koleksiyondur (kullanıcı izolasyonu için)', async () => {
    const { friendsCache } = await loadModule();

    expect(typeof friendsCache.clear).toBe('function');
    friendsCache.clear();
    expect(friendsCache.size).toBe(0);
  });
});
