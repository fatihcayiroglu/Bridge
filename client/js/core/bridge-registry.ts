// client/js/core/bridge-registry.ts
// Sprint 33: window.* köprü temizliği
// Modüller arası fonksiyon paylaşımı için merkezi kayıt defteri.
// window.foo = function() {} yerine BridgeRegistry.register/call kullanın.

'use strict';

// Dynamic registry boundary: callers register heterogeneous signatures.
// `never[]` is the safe top-type for accepting arbitrary function signatures
// without turning the registry boundary into an `any` escape hatch.
export type AnyFn = (...args: unknown[]) => unknown;
type RegistrableFn = (...args: never[]) => unknown;

const _registry = new Map<string, AnyFn>();

// logger.ts import edilmiyor: bu modül neredeyse her yerden import edildiği için
// döngüsel bağımlılık riski alınmıyor. Ölçüt logger.ts:36-41 ile aynı.
function _isDev(): boolean {
  return typeof window !== 'undefined'
    && (window as { BRIDGE_ENV?: string }).BRIDGE_ENV !== 'production';
}

/**
 * Modüller arası fonksiyon paylaşımı için merkezi kayıt defteri.
 *
 * `window.*` global'larına fonksiyon atamak yerine bu registry kullanılır.
 * Bu sayede:
 * - Tip güvenliği sağlanır (global any yerine AnyFn)
 * - Test ortamında mock/spy kolayca enjekte edilebilir
 * - İsim çakışmaları tek noktada yönetilir
 *
 * @example
 * // Kayıt:
 * BridgeRegistry.register('openUserProfile', (userId: string) => { ... });
 *
 * // Çağrı:
 * BridgeRegistry.call('openUserProfile', '123');
 *
 * // Genişletme (wrap):
 * BridgeRegistry.wrap('sendMessage', (orig, ...args) => {
 *   analytics.track('message_sent');
 *   return orig?.(...args);
 * });
 */
export const BridgeRegistry = {
  /**
   * Bir fonksiyonu adıyla kaydet. Mevcut kaydın üzerine yazar.
   *
   * @param name - Kayıt adı (global isim alanından bağımsız, benzersiz string).
   * @param fn   - Kaydedilecek fonksiyon.
   */
  register<T extends RegistrableFn>(name: string, fn: T): void {
    _registry.set(name, fn as unknown as AnyFn);
  },

  /**
   * Adıyla kayıtlı fonksiyonu çağırır.
   *
   * @param name - Çağrılacak fonksiyonun kayıt adı.
   * @param args - Fonksiyona iletilecek argümanlar.
   * @returns Fonksiyonun dönüş değeri; kayıtlı değilse `undefined`.
   */
    call<T = unknown>(name: string, ...args: unknown[]): T | undefined {
    const fn = _registry.get(name);
    if (!fn) {
      // Production davranışı değişmez (sessiz undefined); geliştirmede kayıp
      // kayıtlar sessizce yutulmasın — Faz 1 teşhis kolaylığı.
      if (_isDev()) {
        // eslint-disable-next-line no-console
        console.warn(`[BridgeRegistry] "${name}" kayıtlı değil — çağrı yok sayıldı.`);
      }
      return undefined;
    }
    return Reflect.apply(fn, undefined, args) as T;
  },

  /**
   * Kayıtlı fonksiyonu referans olarak döndürür.
   *
   * @param name - Kayıt adı.
   * @returns Fonksiyon referansı veya `null` (kayıtlı değilse).
   */
    /**
   * VARSAYILAN TIP `AnyFn`dir, `unknown` DEGIL.
   *
   * `register` yalnizca fonksiyon kabul eder (`RegistrableFn`), dolayisiyla
   * tip argumani verilmeyen bir `get` cagrisinin sonucu SOZLESME GEREGI
   * cagrilabilirdir. Varsayilan `unknown` iken yaygin
   *
   *     BridgeRegistry.get('voicePanel:toggleMute')?.()
   *
   * kalibi "This expression is not callable" (TS2349) veriyordu — tek basina
   * `client` typecheck'inde 24 hata. Bu, tum client typecheck kapisini
   * kirmizi tutuyor ve GERCEK client tip hatalarini gizliyordu.
   *
   * Fonksiyon OLMAYAN bir deger saklayan tek cagiran (SocketManager'daki
   * `socket`) zaten hem yazarken hem okurken ACIK tip verir; bu varsayilan
   * onu etkilemez.
   */
    get<T = AnyFn>(name: string): T | null {
    return (_registry.get(name) as T | undefined) ?? null;
  },

  /**
   * Kayıtlı fonksiyonu wrap ederek genişletir (monkey-patch alternatifi).
   * Orijinal fonksiyon `wrapper`'ın ilk argümanı olarak iletilir.
   *
   * @param name    - Wrap edilecek fonksiyonun kayıt adı.
   * @param wrapper - `(orig, ...args) => result` imzalı genişletici fonksiyon.
   *
   * @example
   * BridgeRegistry.wrap('doGlobalSearch', (orig, query) => {
   *   console.log('Searching:', query);
   *   return orig?.(query);
   * });
   */
  wrap<T extends RegistrableFn>(name: string, wrapper: (orig: T | null, ...args: Parameters<T>) => ReturnType<T>): void {
    const orig = (_registry.get(name) as unknown as T | undefined) ?? null;
    _registry.set(name, (...args: unknown[]) => wrapper(orig, ...(args as Parameters<T>)));
  },

  /**
   * Verilen adın registry'de kayıtlı olup olmadığını kontrol eder.
   *
   * @param name - Kontrol edilecek kayıt adı.
   * @returns `true` ise kayıtlı, `false` ise kayıtsız.
   */
  has(name: string): boolean {
    return _registry.has(name);
  },

  unregister(name: string): void {
    _registry.delete(name);
  },
};

// FIX Sprint 33 — Dispatcher index.html inline <script> içinde tanımlanıyor.
// Burada ikinci bir DOMContentLoaded/click dinleyicisi OLMASIN — çifte tetiklenme olur.
// Dispatcher tek yer: index.html'deki <script> bloğu (BridgeRegistry.call kullanır).
// data-bridge-arg desteği için index.html'deki dispatcher güncellendi.
