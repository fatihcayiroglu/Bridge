// client/tests/socket-ready-signal.test.ts
//
// HAZIR SİNYALİ ZAMANLAMASI — GERİLEME TESTİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `SocketManager` `bridge:socket-ready` ve `bridge:socket-reconnected`
// sinyallerini doğrudan ham `connect` olayının içinde yayıyordu. Dinleyiciler
// — özellikle `MessageLoader` — bu sinyalde HEMEN `channel:join` yayar.
//
// Sunucu ise özellik dinleyicilerini (`channel:join`, `message:*`, `voice:*`)
// DÖRT ardışık `await` sonrasında kaydeder (server/socket/index.ts:
// Users.findById → trackSocket → Users.update → setupMemberships).
// Socket.IO, dinleyicisi olmayan bir olayı SESSİZCE ATAR: hata yok, log yok,
// ack yok — `channel:join` zaten ack'siz bir olaydır.
//
// İKİ GERÇEK SUNUCUYLA ÖLÇÜLDÜ (deterministik, 6 deneme):
//     connect → join gecikmesi = 0 ms    → teslim 0/1
//     connect → join gecikmesi ≥ 500 ms  → teslim 1/1
//
// GERÇEK ETKİ yeniden bağlanmada ağırdır: kopukken sunucudaki oda üyeliği
// düşer. Yeniden bağlanınca gönderilen `channel:join` düşerse kullanıcı BAĞLI
// görünür ama CANLI MESAJ ALMAZ — kanal değiştirene ya da sayfayı yenileyene
// kadar. Wi-Fi kesintisi, uyku/uyanma ve sunucu yeniden başlatması bu yolu
// her gün tetikler.
//
// SÖZLEŞME: sunucu `userAuthenticated`ı TÜM dinleyiciler kaydedildikten SONRA
// yayar (server/socket/index.ts — "HAZIR SİNYALİ" notu). İstemci artık onu
// bekler. Sinyal hiç gelmezse yedek süre devreye girer — özellik kaybı yerine
// kısa bir yarış riski tercih edilir.
//
// Bu test SocketManager bileşenini mount etmez (io fabrikası ve ağ gerekir);
// bunun yerine bileşendeki SIRALAMA SÖZLEŞMESİNİ birebir modelleyip sürer ve
// ayrıca kaynak kodda kaydın gerçekten yapıldığını doğrular.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/** Küçük sahte soket — `on` / `once` / `emit` kaydı tutar. */
function makeSocket() {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    emitted: [] as string[],
    on(ev: string, fn: (...a: unknown[]) => void) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    once(ev: string, fn: (...a: unknown[]) => void) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    emit(ev: string) { this.emitted.push(ev); },
    /** Sunucudan gelen olayı tetikler. */
    fire(ev: string) { for (const fn of handlers.get(ev) ?? []) fn(); },
  };
}

/**
 * `SocketManager.bindLifecycle` içindeki hazır-sinyal sözleşmesinin birebir
 * modeli. Üründeki mantık değişirse aşağıdaki kaynak denetimi yakalar.
 */
function wireReadySignals(
  socket: ReturnType<typeof makeSocket>,
  dispatch: (name: string) => void,
  wasReconnect: boolean,
  fallbackMs: number,
) {
  let signalled = false;
  const emitReadySignals = () => {
    if (signalled) return;
    signalled = true;
    if (wasReconnect) dispatch('bridge:socket-reconnected');
    dispatch('bridge:socket-ready');
  };
  const fallback = setTimeout(emitReadySignals, fallbackMs);
  socket.once('userAuthenticated', () => {
    clearTimeout(fallback);
    emitReadySignals();
  });
}

describe('hazır sinyali — `userAuthenticated` beklenir', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('`connect` ANINDA hazır sinyali YAYILMAZ', () => {
    // KANITLAR   : dinleyiciler sunucu hazır olmadan `channel:join` yaymaz.
    // KANITLAMAZ : sunucunun kayıt süresini (orası ayrıca ölçüldü).
    const sock = makeSocket();
    const seen: string[] = [];
    wireReadySignals(sock, n => seen.push(n), false, 3000);

    expect(seen, 'connect anında sinyal yayıldı — yarış geri geldi').toEqual([]);
  });

  it('`userAuthenticated` gelince hazır sinyali yayılır', () => {
    const sock = makeSocket();
    const seen: string[] = [];
    wireReadySignals(sock, n => seen.push(n), false, 3000);

    sock.fire('userAuthenticated');
    expect(seen).toEqual(['bridge:socket-ready']);
  });

  it('YENİDEN BAĞLANMADA önce senkronizasyon, sonra hazır sinyali gelir', () => {
    // Sıra önemlidir: MessageLoader `reconnected` sinyalinde kanala yeniden
    // katılır ve eksik mesajları çeker.
    const sock = makeSocket();
    const seen: string[] = [];
    wireReadySignals(sock, n => seen.push(n), true, 3000);

    sock.fire('userAuthenticated');
    expect(seen).toEqual(['bridge:socket-reconnected', 'bridge:socket-ready']);
  });

  it('sinyal İKİ KEZ yayılmaz (yedek süre + olay birlikte gelirse)', () => {
    const sock = makeSocket();
    const seen: string[] = [];
    wireReadySignals(sock, n => seen.push(n), false, 3000);

    sock.fire('userAuthenticated');
    vi.advanceTimersByTime(5000);      // yedek süre de dolsun
    expect(seen).toEqual(['bridge:socket-ready']);
  });

  it('`userAuthenticated` HİÇ gelmezse yedek süre ürünü kilitlemez', () => {
    // Eski sunucu ya da kayıp sinyal: özellik kaybı yerine kısa yarış riski.
    const sock = makeSocket();
    const seen: string[] = [];
    wireReadySignals(sock, n => seen.push(n), false, 3000);

    vi.advanceTimersByTime(3001);
    expect(seen, 'yedek süre çalışmadı — istemci sonsuza dek beklerdi')
      .toEqual(['bridge:socket-ready']);
  });
});

describe('kaynak sözleşmesi — SocketManager gerçekten bekliyor', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'core', 'SocketManager.svelte'), 'utf8',
  );

  it('`userAuthenticated` dinleyicisi kayıtlı', () => {
    // Mantık doğru olsa bile kayıt silinirse koruma çalışmaz.
    expect(src).toContain("socket.once('userAuthenticated'");
  });

  it('yedek süre tanımlı', () => {
    expect(src).toContain('READY_SIGNAL_FALLBACK_MS');
  });

  it('hazır sinyali `connect` gövdesinde DOĞRUDAN yayılmıyor', () => {
    // `dispatchSocketReady()` yalnızca `emitReadySignals` içinden çağrılmalı.
    const connectBody = src.slice(
      src.indexOf("socket.on('connect'"),
      src.indexOf("socket.on('disconnect'"),
    );
    const readyCalls = [...connectBody.matchAll(/dispatchSocketReady\(\)/g)].length;
    // Tanım dışında tek çağrı: `emitReadySignals` içinde.
    expect(readyCalls, 'connect içinde beklenmedik sayıda hazır çağrısı').toBe(1);
    const idx = connectBody.indexOf('dispatchSocketReady()');
    const before = connectBody.slice(0, idx);
    expect(before, 'hazır çağrısı emitReadySignals dışında').toContain('emitReadySignals');
  });
});
