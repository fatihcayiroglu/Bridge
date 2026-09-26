// client/js/core/dead-control-guard.ts
// Tasarım Fazı 2 — Ölü denetim koruması.
//
// SORUN (denetimde ölçüldü): Arayüzde satır içi `onclick="birSey()"` taşıyan
// 22 GÖRÜNÜR düğme var ve çağırdıkları global hiç tanımlı değil. Tıklayan
// kullanıcı hiçbir geri bildirim almıyor; yalnızca konsola ReferenceError
// düşüyor. Kullanıcı açısından uygulama "bozuk" görünüyor.
//
// BU MODÜL ÖZELLİK YAZMAZ. Yalnızca çökmeyi dürüst geri bildirime çevirir:
// eksik bir denetime tıklanınca kullanıcı "bu özellik henüz kullanılamıyor"
// bildirimi görür. Böylece:
//   - görünür hiçbir denetim ReferenceError üretmez
//   - eksik özellikler GİZLENMEZ (kullanıcıya dürüstçe söylenir)
//   - gerçek özellikler geldiğinde bu koruma kendiliğinden devre dışı kalır
//     (handler tanımlıysa dokunulmaz)
//
// Placeholder kurtarma turlarında bu modülün etkisi kendiliğinden azalır.

import { toast } from './utils.ts';
import { createLogger } from './logger.ts';
import { t } from './i18n/index';

const log = createLogger('DeadControlGuard');

/** `onclick="ad(...)"` içinden çağrılan adı çıkarır. */
function handlerName(source: string): string | null {
  const match = source.match(/^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/);
  return match ? match[1] : null;
}

/** Nokta ayrımlı adı global kapsamda çözer (`BridgeE2E.open` gibi). */
function resolve(path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    globalThis as unknown,
  );
}

function isCallable(path: string): boolean {
  try { return typeof resolve(path) === 'function'; } catch { return false; }
}

/**
 * DOM'daki satır içi handler'ları denetler ve tanımsız olanları güvenli hale
 * getirir. Birden çok kez çağrılabilir (yeni içerik eklendiğinde); zaten
 * işaretlenmiş öğeler atlanır.
 *
 * @returns Bu turda etkisizleştirilen denetim sayısı.
 */
export function guardDeadControls(root: ParentNode = document): number {
  let guarded = 0;

  for (const el of root.querySelectorAll<HTMLElement>('[onclick]')) {
    if (el.dataset.deadControl === 'guarded') continue;

    const source = el.getAttribute('onclick') ?? '';
    const name = handlerName(source);
    // Ad çıkarılamıyorsa (karmaşık ifade) dokunma — yanlış pozitif riski.
    if (!name || isCallable(name)) continue;

    const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || 'Bu işlem';

    el.removeAttribute('onclick');
    el.dataset.deadControl = 'guarded';
    el.setAttribute('aria-disabled', 'true');
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toast(t('dcg_unavailable', '{label}: bu özellik henüz kullanılamıyor.', { label }), 'info');
    });

    guarded += 1;
    // Geliştirmede görünür kalsın: eksik bağlantı sessizce normalleşmesin.
    log.warn(`Ölü denetim korundu: ${name}()`);
  }

  return guarded;
}

/**
 * Boot sonrası tarama. Uygulama modülleri global tanımlamıyor olabilir ama
 * bazıları geç yükleniyor; bu yüzden ilk tarama socket hazır olduktan sonra
 * yapılır — erken tarama gerçek handler'ları yanlışlıkla etkisizleştirebilirdi.
 */
function scheduleScan(): void {
  const run = () => {
    const count = guardDeadControls();
    if (count > 0) log.warn(`${count} ölü denetim güvenli hale getirildi`);
  };
  // socket-ready: tüm özellik modülleri import edilmiş olur.
  document.addEventListener('bridge:socket-ready', run, { once: true });
  // Oturum açılmadıysa socket hiç hazır olmaz; giriş ekranı için de tara.
  document.addEventListener('bridge:auth-success', () => setTimeout(run, 1000), { once: true });

  // ── GIRIS EKRANI, OTURUM ACILMADAN ONCE ─────────────────────────────────
  // Yukaridaki iki tetikleyici de KIMLIK DOGRULAMADAN SONRA calisir. Oysa
  // giris ekranindaki denetimler tam olarak ondan ONCE kullanilir; yani o
  // ekrandaki olu bir dugme hic korunmuyordu.
  //
  // OLCULDU: `index.html` iki passkey dugmesi gosteriyor —
  //   data-auth-action="passkey-login"
  //   data-auth-action="passkey-register"
  // `js/webauthn.ts` bu global'i tanimlar, ama o dosya HICBIR giris
  // noktasindan import edilmiyor (uretim paketinde yok). Sonuc: kullanici
  // "Passkey ile giris yap"a basiyor ve HICBIR SEY olmuyor; yalnizca
  // konsola ReferenceError dusuyor. Sunucu tarafi WebAuthn'i tam
  // destekliyor, dolayisiyla bu bir baglama boslugu.
  //
  // BARIYER OLARAK `load` SECILDI: `DOMContentLoaded` erken olurdu ve
  // paketin sonradan tanimlayacagi GERCEK handler'lari yanlislikla
  // etkisizlestirme riski tasirdi. `load` aninda paketin tanimlayacagi tum
  // global'ler tanimlidir (`auth-compat.ts` login/register/switchAuthTab'i
  // modul degerlendirmesinde atar), bu yuzden yanlis pozitif riski en
  // dusuktur.
  //
  // KAPSAM DAR TUTULDU: yalnizca `#auth-screen` altinda taranir.
  const authTara = () => {
    const kok = document.getElementById('auth-screen');
    if (!kok) return;
    const count = guardDeadControls(kok);
    if (count > 0) log.warn(`giriş ekranında ${count} ölü denetim güvenli hale getirildi`);
  };
  if (document.readyState === 'complete') setTimeout(authTara, 0);
  else window.addEventListener('load', authTara, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleScan, { once: true });
} else {
  scheduleScan();
}
