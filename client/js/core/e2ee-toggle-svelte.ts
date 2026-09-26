// client/js/core/e2ee-toggle-svelte.ts
// Sprint 116 — E2EEToggle mount shim (ADR-0008 Faz 3)
// Kanal E2EE etkinleştirme toggle bileşeni
import { mount, unmount } from 'svelte';
import E2EEToggle from './E2EEToggle.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('E2EEToggleShim');

let _instance: ReturnType<typeof mount> | null = null;

/**
 * E2EE anahtarını AÇIKÇA bir kanal bağlamına bağlar.
 *
 * `channelId` zorunludur: kanal bağlamı olmayan bir E2EE anahtarı hiçbir şeyi
 * şifreleyemez ve kullanıcıya yanlış bir güvenlik güvencesi verir. Boş
 * kimlikle çağrılırsa hiçbir şey render edilmez.
 */
export function mountE2EEToggle(target?: HTMLElement, channelId = ''): void {
  if (_instance) return;
  if (!channelId) {
    log.warn('E2EEToggle mount edilmedi: kanal bağlamı olmadan gösterilemez.');
    return;
  }
  const el = target ?? document.getElementById('e2ee-toggle-root');
  if (!el) {
    log.warn('E2EEToggle mount edilmedi: hedef kapsayıcı yok.');
    return;
  }
  _instance = mount(E2EEToggle, { target: el, props: { channelId, initialEnabled: false } });
  log.info('E2EEToggle mounted via shim');
}

export function unmountE2EEToggle(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

// Faz 11 §20/§32 — OTOMATİK MOUNT KALDIRILDI.
//
// Bu shim eskiden kendi `#e2ee-toggle-root` div'ini yaratıp `document.body`ye
// ekliyor ve E2EEToggle'ı `channelId: ''` ile mount ediyordu. Sonuç, ürün
// yüzeyinde "Uçtan uca şifreleme" iddiasında bulunan görünür bir anahtardı.
// Oysa ölçülen gerçek:
//   - MessageInputPanel hiçbir şifreleme YAPMIYOR; kanal mesajları düz metin.
//   - `/api/channels/:id/e2ee` ucu SUNUCUDA YOK.
//   - Mount kanal bağlamsız olduğu için istek zaten bozuk URL'e gidiyordu.
//
// Doğrulanmayan bir güvenlik güvencesi göstermek, hiç göstermemekten kötüdür.
// Kontrol ürün yüzeyinden kaldırıldı; bileşen korunuyor ve gerçek, kanal
// kapsamlı bir E2EE sahibi yazıldığında `mountE2EEToggle` ile bağlanabilir.
