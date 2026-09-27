// client/tests/server-settings-scope.test.ts
// FAZ C1.6–C1.9 + C1.12 — SUNUCU/KANAL KAPSAM SINIRLARI.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Sunucu Ayarları sekmeleri geçerli sunucuyu AÇILIŞTA bir kez çözer. Kullanıcı
// modal açıkken başka bir sunucuya geçerse, yakalanmış kimlikle yapılan her
// mutasyon YANLIŞ sunucuya giderdi.
//
// Arka uç yetkiyi doğrular (nihai otorite odur) — ama iki sunucunun da SAHİBİ
// olan bir kullanıcıda yetki kontrolü geçer ve yanlış sunucu SESSİZCE
// değiştirilebilirdi. Bu yüzden istemci tarafında da fail-closed bir kapı var.
//
// Bridge herkese açık çok kullanıcılı bir üründür: kapsam sınırları
// "arkadaşlar test ediyor" varsayımına göre gevşetilmez.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isStillCurrentServer } from '../js/core/server-settings/stores/serverSettingsStore.ts';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const A = { _id: 'srv-A', id: 'srv-A', name: 'A', ownerId: 'u1' };
const B = { _id: 'srv-B', id: 'srv-B', name: 'B', ownerId: 'u1' };  // AYNI sahip

function setCurrent(server: unknown): void {
  BridgeRegistry.register('getCurrentServer', () => server);
}

beforeEach(() => setCurrent({ ...A }));
afterEach(() => {
  BridgeRegistry.unregister('getCurrentServer');
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// Paylaşılan bayat-sunucu kapısı (Media / Emoji / Webhook / General ortak)
// ════════════════════════════════════════════════════════════════════════════
describe('C1.6–C1.9 — bayat sunucu kapısı', () => {
  it('geçerli sunucu için TRUE döner', () => {
    expect(isStillCurrentServer('srv-A')).toBe(true);
  });

  it('GÜVENLİK: sunucu değiştiyse eski kimlik için FALSE döner', () => {
    setCurrent({ ...B });

    // Aynı kullanıcı her iki sunucunun da sahibi olsa bile A'ya ait yakalanmış
    // kimlikle B üzerinde işlem yapılamaz.
    expect(isStillCurrentServer('srv-A')).toBe(false);
  });

  it('GÜVENLİK: boş kimlik reddedilir (`/api/servers/undefined` engeli)', () => {
    expect(isStillCurrentServer('')).toBe(false);
  });

  it('GÜVENLİK: geçerli sunucu çözülemiyorsa FAIL-CLOSED', () => {
    BridgeRegistry.unregister('getCurrentServer');

    expect(isStillCurrentServer('srv-A')).toBe(false);
  });

  it('GÜVENLİK: başka sunucunun kimliği kabul edilmez (IDOR)', () => {
    // Kullanıcı A'dayken B'nin kimliğiyle işlem yapmayı denerse.
    expect(isStillCurrentServer('srv-B')).toBe(false);
  });
});
