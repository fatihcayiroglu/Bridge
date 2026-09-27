// client/tests/server-settings-opener.test.ts
// FAZ C1.2 + C1.3 — Sunucu Ayarları: kanonik sunucu çözümü + canlı açıcı.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `ServerSettingsModal.svelte` (250 satır + 7 sekme) gerçek bir uygulamaydı
// ama ürüne HİÇ bağlanmamıştı:
//   • `getCurrentServerFromRegistry()` sabit `null` döndürüyordu → modaldeki
//     `store` HER ZAMAN null kalıyor, modal "Sunucu seçilmedi." ekranından
//     öteye geçemiyordu
//   • AuditLog/Emoji/Webhook sekmeleri `BridgeRegistry.get('getCurrentServer')`
//     kullanıyordu; bu çağrı kayıtlı GETTER FONKSİYONUNU döndürür, sunucuyu
//     değil — `server._id` undefined olup istekler `/api/servers/undefined/...`
//     adresine gidiyordu
//   • shim app.ts'ten import edilmiyordu ve açacak bir kontrol yoktu
//
// YETKİ SÖZLEŞMESİ: arka uç `PATCH /api/servers/:sid` SAHİP-ONLY'dir
// (server/routes/servers/core.ts:348). Açıcı bu yüzden yalnızca sahibe
// görünür. Görünürlük UX'tir; güvenlik sınırı arka uçtur.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ServerSettingsOpener from '../js/core/ServerSettingsOpener.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { getCurrentServerFromRegistry } from '../js/core/server-settings/stores/serverSettingsStore.ts';

const OWNER  = 'user-owner-1';
const MEMBER = 'user-member-2';

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

const gear = () => host.querySelector<HTMLButtonElement>('.server-settings-opener');

/** Kanonik uygulama durumunu taklit eder (AppState.svelte:60,67 sözleşmesi). */
function setState(server: unknown, me: unknown): void {
  BridgeRegistry.register('getCurrentServer', () => server);
  BridgeRegistry.register('me', () => me);
}

function mountOpener(): void {
  instance = mount(ServerSettingsOpener, { target: host });
  flushSync();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  for (const k of ['getCurrentServer', 'me', 'openServerSettings', 'closeServerSettings']) {
    BridgeRegistry.unregister(k);
  }
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// C1.2 — kanonik geçerli-sunucu çözümleyicisi
// ════════════════════════════════════════════════════════════════════════════
describe('C1.2 — kanonik sunucu çözümleyicisi', () => {
  it('kayıtlı getter’ı ÇAĞIRIR ve sunucuyu döndürür', () => {
    setState({ _id: 'srv-1', name: 'Sunucum', ownerId: OWNER }, { _id: OWNER });

    const resolved = getCurrentServerFromRegistry();

    // Eski hata: getter fonksiyonun kendisi dönüyordu (veya sabit null).
    expect(typeof resolved).toBe('object');
    expect(resolved?._id).toBe('srv-1');
  });

  it('sunucu seçili değilse null döner', () => {
    setState(null, { _id: OWNER });

    expect(getCurrentServerFromRegistry()).toBeNull();
  });

  it('kimliksiz/boş sunucu nesnesi null sayılır (undefined id sızmaz)', () => {
    setState({ name: 'kimliksiz' }, { _id: OWNER });

    // `/api/servers/undefined/...` isteklerinin kaynağı buydu.
    expect(getCurrentServerFromRegistry()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C1.3 — açıcı erişilebilirliği ve yetki farkındalığı
// ════════════════════════════════════════════════════════════════════════════
describe('C1.3 — canlı açıcı', () => {
  it('SAHİP için açıcı GÖRÜNÜR', () => {
    setState({ _id: 'srv-1', ownerId: OWNER }, { _id: OWNER });
    mountOpener();

    expect(gear()).not.toBeNull();
    expect(gear()!.getAttribute('aria-label')).toMatch(/sunucu ayarlar/i);
  });

  it('GÜVENLİK: sıradan ÜYE için açıcı GÖSTERİLMEZ', () => {
    // Arka uç sahip-only; üyeye kaydedemeyeceği yüzey vaat edilmez.
    setState({ _id: 'srv-1', ownerId: OWNER }, { _id: MEMBER });
    mountOpener();

    expect(gear()).toBeNull();
  });

  it('GÜVENLİK: sahiplik KANITLANAMIYORSA gizlenir (fail-closed)', () => {
    // ownerId alanı yoksa yanlış vaatte bulunma.
    setState({ _id: 'srv-1' }, { _id: OWNER });
    mountOpener();

    expect(gear()).toBeNull();
  });

  it('oturum yokken açıcı gösterilmez', () => {
    setState({ _id: 'srv-1', ownerId: OWNER }, null);
    mountOpener();

    expect(gear()).toBeNull();
  });

  it('sunucu seçili değilken açıcı gösterilmez', () => {
    setState(null, { _id: OWNER });
    mountOpener();

    expect(gear()).toBeNull();
  });

  it('tıklama GERÇEK açma sözleşmesini çağırır', () => {
    const open = vi.fn();
    setState({ _id: 'srv-1', ownerId: OWNER }, { _id: OWNER });
    BridgeRegistry.register('openServerSettings', open);
    mountOpener();

    gear()!.click();
    flushSync();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('sunucu DEĞİŞİMİNDE görünürlük yeniden değerlendirilir (bayat durum yok)', () => {
    setState({ _id: 'srv-owned', ownerId: OWNER }, { _id: OWNER });
    mountOpener();
    expect(gear()).not.toBeNull();

    // Kullanıcı sahibi OLMADIĞI bir sunucuya geçiyor.
    setState({ _id: 'srv-other', ownerId: 'someone-else' }, { _id: OWNER });
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-other' } }));
    flushSync();

    expect(gear()).toBeNull();
  });

  it('çıkışta açıcı kaybolur (önceki hesap sızıntısı yok)', () => {
    setState({ _id: 'srv-1', ownerId: OWNER }, { _id: OWNER });
    mountOpener();
    expect(gear()).not.toBeNull();

    setState(null, null);
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();

    expect(gear()).toBeNull();
  });

  it('GÜVENLİK: açıcı satır içi string handler kullanmaz', () => {
    setState({ _id: 'srv-1', ownerId: OWNER }, { _id: OWNER });
    mountOpener();

    expect(gear()!.getAttribute('onclick')).toBeNull();
  });

  it('unmount sonrası sunucu değişimi ÇÖKMEZ (dinleyici temizliği)', () => {
    setState({ _id: 'srv-1', ownerId: OWNER }, { _id: OWNER });
    mountOpener();
    unmount(instance!);
    instance = null;

    expect(() => {
      document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: {} }));
      flushSync();
    }).not.toThrow();
  });
});
