// client/js/core/i18n-dom.ts
// Faz 12 sonrası — I18N DOM UYGULAYICISI.
//
// SORUN: `index.html` 11 elemanda `data-i18n` taşıyordu ve `js/core/i18n/`
// altında 10 dil için tam çeviri tabloları vardı; ancak bu iki taraf birbirine
// HİÇ bağlanmamıştı. Üretimde `data-i18n` niteliğini okuyan tek bir satır bile
// yoktu, dolayısıyla dil değiştirmek arayüzü değiştirmiyordu: kullanıcı her
// zaman gömülü İngilizce metni görüyordu.
//
// Bu modül eksik olan tek parçayı ekler: nitelikleri okuyup mevcut `t()`
// üzerinden METİN olarak uygular ve locale değişiminde yeniden uygular.
//
// GÜVENLİK: çeviriler METİNDİR. Yalnızca `textContent` yazılır —
// `innerHTML`/`{@html}` YOKTUR. Böylece çeviri tablosu bir XSS yüzeyi olamaz.
//
// KAPSAM SINIRI: yalnız düz metin düğümleri çevrilir. `index.html` içindeki 11
// düğümün tamamı yaprak düğümdür (`p`, `button`, `label`, `span`, `h2`);
// iç içe biçimlendirme YOKTUR, bu yüzden `textContent` güvenlidir. İleride iç
// içe biçimlendirme taşıyan bir düğüm eklenirse burada değil, ayrı olarak
// sınıflandırılmalıdır.

import { t, locale } from './i18n/index.ts';
import { createLogger } from './logger.ts';

const log = createLogger('I18nDom');

/** Çeviri anahtarını taşıyan nitelik. */
const KEY_ATTR = 'data-i18n';

/**
 * Nitelik cevirisi: `data-i18n-placeholder="anahtar"`.
 *
 * KAPATILAN GERCEK BOSLUK: uygulayici yalnizca `textContent` ceviriyordu.
 * Kabuktaki composer'in `placeholder` niteligi bu yuzden SABIT KODLU
 * kalmak zorundaydi ve dil ne olursa olsun ayni metni gosteriyordu
 * (olculdu: yerel `en` iken bile Turkce yer tutucu).
 *
 * Nitelikler ayri tutulur cunku bir dugumun hem metni hem yer tutucusu
 * olabilir ve ikisi FARKLI anahtarlardir.
 */
const ATTR_KEYS: ReadonlyArray<[string, string]> = [
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-title',       'title'],
  ['data-i18n-aria-label',  'aria-label'],
  // `index.html` has historically used `data-tip-i18n` for the visible
  // tooltip copy. Until now that attribute was never consumed, so changing
  // locale translated the button text/ARIA in some places but left the
  // floating tooltip in its boot language. Keep the established attribute
  // and make it an actual part of the canonical DOM-i18n contract.
  ['data-tip-i18n',         'data-tip'],
];

/**
 * Bir düğümün metnini geçerli locale ile günceller.
 *
 * Eksik anahtarda `t()` anahtarın kendisini döndürür; bu durumda düğüme
 * DOKUNULMAZ ki gömülü özgün metin (çoğunlukla anlamlı İngilizce) korunsun.
 * Aksi hâlde çeviri eksikliği kullanıcıya `sign_in` gibi ham anahtar olarak
 * görünürdü — mevcut metinden daha kötü bir sonuç.
 */
function applyToElement(el: Element): void {
  const key = el.getAttribute(KEY_ATTR);
  if (!key) return;

  const translated = t(key);
  if (translated === key) return; // çeviri yok → mevcut metni bozma

  el.textContent = translated;
}

/**
 * Bir dugumun cevrilebilir NITELIKLERINI gunceller.
 *
 * Metinle ayni kural: ceviri yoksa nitelige DOKUNULMAZ; aksi halde
 * kullaniciya ham anahtar gosterilirdi.
 */
function applyAttributes(el: Element): void {
  for (const [dataAttr, targetAttr] of ATTR_KEYS) {
    const key = el.getAttribute(dataAttr);
    if (!key) continue;
    const translated = t(key);
    if (translated === key) continue;
    el.setAttribute(targetAttr, translated);
  }
}

/** `[data-i18n*]` taşıyan tüm düğümleri geçerli locale ile günceller. */
export function applyTranslations(root: ParentNode = document): number {
  const nodes = root.querySelectorAll(`[${KEY_ATTR}]`);
  nodes.forEach(applyToElement);

  const attrSelector = ATTR_KEYS.map(([a]) => `[${a}]`).join(',');
  const attrNodes = root.querySelectorAll(attrSelector);
  attrNodes.forEach(applyAttributes);

  return nodes.length + attrNodes.length;
}

let _unsubscribe: (() => void) | null = null;

/**
 * Uygulayıcıyı başlatır ve locale değişimlerine abone olur.
 *
 * `locale.subscribe` abone olur olmaz mevcut değerle bir kez çağırır
 * (i18n/index.ts:94), bu yüzden ilk uygulama ayrıca tetiklenmez.
 * Çeviri tabloları asenkron yüklendiğinden ilk yükleme tamamlandığında
 * dinleyici yeniden çağrılır ve DOM o anda güncellenir.
 */
export function initI18nDom(): void {
  if (_unsubscribe) return; // tek sahip

  _unsubscribe = locale.subscribe(() => {
    const count = applyTranslations();
    log.info(`${count} düğüm '${locale.current}' diline uygulandı`);
  });
}

/** Test/teardown için — aboneliği bırakır. */
export function stopI18nDom(): void {
  _unsubscribe?.();
  _unsubscribe = null;
}
