// client/tests/state.test.ts
// core/state.ts — CANLI sözleşme testleri.
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — ÖLÜ SÖZLEŞME EMEKLİLİĞİ (kanıtlı)
// ════════════════════════════════════════════════════════════════════════════
//
// ESKİ TEST NEYİ BEKLİYORDU (236 satır, 6 describe):
//   `state` Proxy'si  → state.currentUser / currentServer / token /
//                        sidebarCollapsed / mobileView
//   setState()
//   subscribe()
//   wildcard subscribe('*')
//   initState()
//   BridgeState namespace
//
// ÜRETİMDE BUGÜN NE VAR (js/core/state.ts — 5 satır, doğrulandı):
//   export interface CurrentUser
//   export function getCurrentUser(): CurrentUser | null
//
// Yani reaktif store'un TAMAMI kaldırılmış. Yerine geçen sahip:
//   js/core/AppState.svelte  (js/core/state-svelte.ts shim'i ile mount edilir,
//   "Sprint 116 — AppState mount shim, ADR-0008 Faz 3")
// Durum artık Svelte runes + BridgeRegistry üzerinden akıyor.
//
// YERİNE GEÇEN KAPSAM (aktif süitler):
//   draft-composer-integration · message-delivery-state · Phase10Social
//   · user-isolation (çıkışta özel durum temizliği)
//
// Bu yüzden eski iddialar "düzeltilemez": onları geçirmek, kaldırılmış global
// store mimarisini geri getirmek anlamına gelirdi — Faz 11 kararlarına aykırı.
//
// KORUNAN CANLI SÖZLEŞME: `getCurrentUser()`. Üretimde gerçekten kullanılıyor
// (js/core/settings/tabs/ProfileTab.svelte:4,8) ve burada test edilir.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `getCurrentUser()` `globalThis.currentUser`'ı ÇAĞRI ANINDA okur; modül
 * seviyesi durum tutmaz. Yine de her test taze modül alsın diye kanonik
 * Vitest/ESM biçimi kullanılır (CJS `require()` Vite tarafından çözülmez).
 */
async function loadState() {
  vi.resetModules();
  return await import('../js/core/state.ts');
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).currentUser;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).currentUser;
});

describe('getCurrentUser()', () => {
  it('currentUser tanımsızsa null döner', async () => {
    const { getCurrentUser } = await loadState();

    expect(getCurrentUser()).toBeNull();
  });

  it('currentUser null ise null döner', async () => {
    (globalThis as Record<string, unknown>).currentUser = null;
    const { getCurrentUser } = await loadState();

    expect(getCurrentUser()).toBeNull();
  });

  it('currentUser set edilmişse aynı nesneyi döner', async () => {
    const user = { _id: 'u1', username: 'ahmet', displayName: 'Ahmet' };
    (globalThis as Record<string, unknown>).currentUser = user;
    const { getCurrentUser } = await loadState();

    expect(getCurrentUser()).toEqual(user);
  });

  it('ÇAĞRI ANINDA okur — modül yüklendikten sonraki değişiklik görünür', async () => {
    const { getCurrentUser } = await loadState();
    expect(getCurrentUser()).toBeNull();

    (globalThis as Record<string, unknown>).currentUser = { _id: 'u2' };

    // Değer modül yükleme anında dondurulmaz; bu sözleşme ProfileTab'ın
    // doğru kullanıcıyı görmesi için önemlidir.
    expect(getCurrentUser()).toEqual({ _id: 'u2' });
  });
});

describe('kaldırılmış global store MİMARİSİ geri gelmemelidir', () => {
  it('state.ts yalnız getCurrentUser dışa aktarır', async () => {
    const mod = await loadState() as unknown as Record<string, unknown>;

    expect(typeof mod.getCurrentUser).toBe('function');

    // Bu adlar AppState.svelte + BridgeRegistry'ye taşındı. Yeniden
    // belirmeleri, Faz 11'de kaldırılan legacy global mimarisinin geri
    // döndüğü anlamına gelir.
    for (const removed of ['state', 'setState', 'subscribe', 'initState', 'BridgeState']) {
      expect(mod[removed]).toBeUndefined();
    }
  });
});
