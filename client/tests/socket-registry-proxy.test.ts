// client/tests/socket-registry-proxy.test.ts
//
// SOKET PROXY'Sİ — YENİDEN BAĞLANMADA DİNLEYİCİ SAHİPLİĞİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// `js/core/socket-svelte.ts` %0 kapsamdaydı. İçindeki mount shim'i sıradan
// yapıştırıcı koddur, ama bir parçası DEĞİLDİR: `socket` Proxy'si.
//
//     export const socket = new Proxy({}, {
//       get(_t, prop) {
//         const current = BridgeRegistry.get('socket');
//         ...
//       }
//     });
//
// Bu Proxy, uygulamanın SOKETE ERİŞİM SÖZLEŞMESİDİR ve yeniden bağlanma
// davranışının temelidir:
//
//   • Her erişim REGİSTRY'DEN O ANKİ soketi okur.
//   • Yani soket değiştiğinde (reconnect) çağıranlar OTOMATİK olarak yeni
//     sokete yönelir — eski nesneye tutunup kaybolmazlar.
//   • Bu, `removeAllListeners()` ile yeniden bağlama kısayoluna gerek
//     bırakmayan mekanizmadır. O kısayol bu projede AÇIKÇA YASAKTIR, çünkü
//     başka modüllerin dinleyicilerini de sessizce siler.
//
// Sözleşme bozulursa belirti şudur: yeniden bağlanmadan sonra mesajlar
// gönderilir gibi görünür ama ESKİ, kapalı sokete gider. Sessiz ve teşhisi zor.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mount shim'i içe aktarmak Svelte bileşenlerini monte etmeye çalışır;
// bu testin ilgilendiği tek şey Proxy sözleşmesidir.
vi.mock('../js/core/SocketManager.svelte', () => ({ default: {} }));
vi.mock('svelte', async () => {
  const gercek = await vi.importActual<Record<string, unknown>>('svelte');
  return { ...gercek, mount: vi.fn(() => ({})) };
});
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { socket } from '../js/core/socket-svelte.ts';

/** Kaydedilen çağrıları tutan sahte soket. */
function sahteSoket(etiket: string) {
  const cagrilar: Array<{ ad: string; args: unknown[] }> = [];
  return {
    etiket,
    cagrilar,
    id: `sock-${etiket}`,
    connected: true,
    emit(...args: unknown[]) { cagrilar.push({ ad: 'emit', args }); return this; },
    on(...args: unknown[])   { cagrilar.push({ ad: 'on', args }); return this; },
    off(...args: unknown[])  { cagrilar.push({ ad: 'off', args }); return this; },
  };
}

beforeEach(() => {
  BridgeRegistry.register('socket', undefined as never);
});

// ════════════════════════════════════════════════════════════════════════════
// YENİDEN BAĞLANMA SÖZLEŞMESİ — asıl değer
// ════════════════════════════════════════════════════════════════════════════
describe('yeniden bağlanma sözleşmesi', () => {
  it('soket DEĞİŞİNCE çağrılar YENİ sokete gider', () => {
    // Kusur olsaydi belirti: reconnect sonrasi mesajlar ESKI, kapali sokete
    // gider ve sessizce kaybolurdu.
    const eski = sahteSoket('eski');
    BridgeRegistry.register('socket', eski as never);
    socket.emit!('mesaj', { a: 1 });

    const yeni = sahteSoket('yeni');
    BridgeRegistry.register('socket', yeni as never);
    socket.emit!('mesaj', { a: 2 });

    expect({
      eskiAldi: eski.cagrilar.length,
      yeniAldi: yeni.cagrilar.length,
      yeniPayload: yeni.cagrilar[0]?.args[1],
    }).toEqual({ eskiAldi: 1, yeniAldi: 1, yeniPayload: { a: 2 } });
  });

  it('Proxy referansı SAKLANSA BİLE güncel sokete yönelir', () => {
    // Modul yuklenirken `socket` yakalanip saklanir; sozlesme, o KAYDEDILMIS
    // referansin bile guncel sokete gitmesini gerektirir.
    const saklanan = socket;
    const a = sahteSoket('a');
    BridgeRegistry.register('socket', a as never);
    saklanan.emit!('x');

    const b = sahteSoket('b');
    BridgeRegistry.register('socket', b as never);
    saklanan.emit!('y');

    expect({ a: a.cagrilar.length, b: b.cagrilar.length }).toEqual({ a: 1, b: 1 });
  });

  it('metotlar DOĞRU soket örneğine bağlanır (this kaybolmaz)', () => {
    // `bind` olmasaydi `this` kaybolur ve socket.io icinde patlardi.
    const s = sahteSoket('bagli');
    BridgeRegistry.register('socket', s as never);
    const kopuk = socket.emit!;          // metodu nesneden AYIR
    kopuk('olay', 1);
    expect(s.cagrilar).toEqual([{ ad: 'emit', args: ['olay', 1] }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SOKET YOKKEN — çökme değil, sessiz undefined
// ════════════════════════════════════════════════════════════════════════════
describe('soket kayıtlı değilken', () => {
  it('özellik erişimi PATLAMAZ', () => {
    // Uygulama acilisinda soket henuz yoktur; erisim cokerse tum kabuk duser.
    expect(() => socket.emit).not.toThrow();
    expect(socket.emit).toBeUndefined();
  });

  it('bilinmeyen özellik undefined döner', () => {
    expect((socket as Record<string, unknown>).boyleBirSeyYok).toBeUndefined();
  });

  it('soket SONRADAN kaydedilince erişilebilir olur', () => {
    expect(socket.emit).toBeUndefined();
    const s = sahteSoket('gec');
    BridgeRegistry.register('socket', s as never);
    expect(typeof socket.emit).toBe('function');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VERİ ÖZELLİKLERİ
// ════════════════════════════════════════════════════════════════════════════
describe('veri özellikleri', () => {
  it('fonksiyon OLMAYAN alanlar aynen geçer', () => {
    const s = sahteSoket('veri');
    BridgeRegistry.register('socket', s as never);
    expect({
      id: (socket as Record<string, unknown>).id,
      connected: (socket as Record<string, unknown>).connected,
    }).toEqual({ id: 'sock-veri', connected: true });
  });

  it('güncel soketin DEĞİŞEN alanı okunur (anlık görüntü DEĞİL)', () => {
    // Proxy degeri onbelleklerse `connected` bayati kalir ve UI yanlis
    // baglanti durumu gosterir.
    const s = sahteSoket('degisen');
    BridgeRegistry.register('socket', s as never);
    expect((socket as Record<string, unknown>).connected).toBe(true);
    s.connected = false;
    expect((socket as Record<string, unknown>).connected).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL — Proxy gerçekten devrediyor mu?
// ════════════════════════════════════════════════════════════════════════════
describe('POZİTİF KONTROL', () => {
  it('on / off / emit ÜÇÜ de gerçek sokete ulaşır', () => {
    // Bu olmadan yukaridaki testler, her seye undefined donduren bozuk bir
    // Proxy'de de yesil kalirdi.
    const s = sahteSoket('hepsi');
    BridgeRegistry.register('socket', s as never);
    socket.on!('ev', () => {});
    socket.off!('ev');
    socket.emit!('ev', 42);
    expect(s.cagrilar.map(c => c.ad)).toEqual(['on', 'off', 'emit']);
  });
});
